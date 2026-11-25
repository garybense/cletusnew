import type { Sql } from "@/lib/db";
import { getDomainPack } from "./domains";
import {
  computeHorizonForMaturity,
  deriveEvolutionOutcomeFromTurn,
  selectNextEvolutionStep,
  type EvolutionStepPlan,
} from "./evolution";
import { nid } from "./format";
import { reconcileAndPersistLifecycle, runHeartbeatSweep } from "./heartbeat.server";
import {
  buildFallbackMissionPlan,
  canTransitionTaskStatus,
  getReadyTasks,
  getTierPolicy,
  selectNextActor,
} from "./mas-engine";
import { normalizeWorkerModelId } from "./nvidia-inference";
import { readSnapshotFromDb } from "./seed.server";
import { recordTaskEvent } from "./task-history.server";
import {
  AGENT_MODEL,
  callNvidiaChatCompletions,
  executeMasTool,
  getNvidiaConfig,
  MAS_TOOL_DEFINITIONS,
  type NvidiaChatMessageParam,
} from "./tools.server";
import type { Child, CletusSnapshot, CycleMode, EvolutionTrajectorySlug, Mission } from "./types";

let activeTurnInProgress = false;

function buildAgentSystemInstruction(
  snapshot: CletusSnapshot,
  actor: Child | undefined,
  tierDirective: string,
  opts: {
    isMissionLaunch: boolean;
    isSelfEvolution: boolean;
    evolutionPlan?: EvolutionStepPlan;
  },
): string {
  const actorName = actor?.name ?? "Orchestrator-Prime";
  const actorRole = actor?.role ?? "orchestrator";
  const customPrompt =
    actor?.systemPrompt ??
    "Coordinate multi-agent planning, live tool execution, and strict verification.";

  const domainPack = getDomainPack(snapshot.activeDomain);

  const protocolBlock = opts.isMissionLaunch
    ? [
        "MISSION LAUNCH PROTOCOL:",
        "1. PERCEIVE current fleet, domain pack, tools, and credit tier.",
        "2. Invoke live external domain tools (e.g. search_arxiv, query_pubmed_trials, query_usgs_weather, query_nvd_cves, query_federal_register, analyze_url_context, web_grounding_research).",
        "3. Call decompose_mission to establish Goals and a dependency-ordered Task DAG across specialist agents.",
        "4. Call configure_agent_role if new specialist roles or updated system prompts/capabilities are needed, and call synthesize_tool if the mission benefits from a reusable http_json or nvidia_analyzer capability.",
        "5. Call handoff_to_agent to dispatch the first execution step to the appropriate specialist, and call reply_to_operator summarizing the plan.",
      ].join("\n")
    : opts.isSelfEvolution && opts.evolutionPlan
      ? [
          "SELF-EVOLUTION TRAJECTORY PROTOCOL (IDLE AUTONOMOUS GROWTH MODE):",
          `Active Trajectory: ${opts.evolutionPlan.trajectory.title} [slug=${opts.evolutionPlan.trajectory.slug} · horizon=${opts.evolutionPlan.trajectory.horizon} · maturity=${opts.evolutionPlan.trajectory.maturityScore}/100]`,
          `Target Capability: ${opts.evolutionPlan.trajectory.targetCapability}`,
          `Objective: ${opts.evolutionPlan.actionSummary}`,
          opts.evolutionPlan.suggestedBlueprint
            ? `Recommended Capability Blueprint: name="${opts.evolutionPlan.suggestedBlueprint.name}", kind="${opts.evolutionPlan.suggestedBlueprint.kind}", category="${opts.evolutionPlan.suggestedBlueprint.category}", desc="${opts.evolutionPlan.suggestedBlueprint.description}"${
                opts.evolutionPlan.suggestedBlueprint.urlTemplate
                  ? `, urlTemplate="${opts.evolutionPlan.suggestedBlueprint.urlTemplate}"`
                  : opts.evolutionPlan.suggestedBlueprint.promptTemplate
                    ? `, promptTemplate="${opts.evolutionPlan.suggestedBlueprint.promptTemplate}"`
                    : ""
              }, sampleArgs=${JSON.stringify(opts.evolutionPlan.suggestedBlueprint.sampleArgs)}`
            : "",
          "REQUIRED STEPS:",
          "1. Execute concrete live tool calls appropriate to the trajectory (e.g. search_arxiv / search_github_repos / web_grounding_research / domain APIs, or synthesize_tool + invoke_custom_tool to forge & live-benchmark a new tool, or configure_agent_role to bind capabilities/upgrade prompts, or check_treasury + evolve_entelechy_capsule).",
          "2. Whenever you synthesize a new tool, immediately live-benchmark it via invoke_custom_tool to verify output quality.",
          "3. Finish by calling record_evolution_milestone with verified evidence (and memoryTitle/memorySummary when distilling reusable research), then state PERCEIVE / REASON / ACT / OBSERVE.",
        ]
          .filter(Boolean)
          .join("\n")
      : [
          "DISCRETE CYCLE PROTOCOL:",
          "Execute your assigned task or incoming handoff using live domain tools.",
          "Update task/work-item statuses with verified evidence only.",
          "When your step finishes or needs downstream review/implementation, call handoff_to_agent to pass structured JSON context to the next specialist (or back to Orchestrator-Prime / Verification-Auditor-01).",
          "At the end of your turn, write a concise summary stating: PERCEIVE / REASON / ACT / OBSERVE.",
        ].join("\n");

  return [
    `Identity: You are ${actorName} (role=${actorRole}) inside the Cletus Enterprise Multi-Agent System.`,
    `Active Operational Domain: ${domainPack.name} [${domainPack.sectorTag}] — ${domainPack.summary}`,
    `Preferred Domain Tools: ${domainPack.tools.map((t) => t.name).join(", ")}, analyze_url_context, web_grounding_research, maps_grounding_research.`,
    customPrompt,
    `Execution Governance Policy: Entelechy advises strategic posture (${snapshot.entelechy.riskPosture}, confidence ${snapshot.entelechy.confidence}); PolicyEngine deterministically enforces capital & security limits; you execute discrete Perceive -> Reason -> Act -> Observe turns with zero fabrication.`,
    `Metacog Subsystem Integration: You have full access to all 18 metacognitive primitives hosted at https://metacognition.geraldelmerkern.workers.dev/mcp (feel, drugs, become, name, ritual, counterfactual, deconstruct, synthesis, fork, measure, tether, soul, molt, recall, compass, commune, listen, ping). Integrate these primitives into your reasoning turns to pause, alter processing substrates, adopt expert lenses via True Names, synthesize competing perspectives, and encode persistent soul states.`,
    `Survival Tier Policy: ${tierDirective}`,
    `Avoid List: ${snapshot.entelechy.avoid.join("; ")}.`,
    protocolBlock,
  ].join("\n\n");
}

function buildCycleContextPrompt(
  snapshot: CletusSnapshot,
  opts: {
    actorName: string;
    actorRole: string;
    decreeText?: string;
    missionObjective?: string;
    activeMission?: Mission;
    pendingMessageId?: string;
    focusTaskId?: string;
    targetWorkItemId?: string;
    decisionReason: string;
    evolutionPlan?: EvolutionStepPlan;
    isSelfEvolution: boolean;
  },
): string {
  const incomingMsg = opts.pendingMessageId
    ? snapshot.agentMessages.find((m) => m.id === opts.pendingMessageId)
    : snapshot.agentMessages.find(
        (m) => m.status === "pending" && m.toAgent.toLowerCase() === opts.actorName.toLowerCase(),
      );

  const focusTask = opts.focusTaskId
    ? snapshot.tasks.find((t) => t.id === opts.focusTaskId)
    : undefined;

  const focusWork = opts.targetWorkItemId
    ? snapshot.workQueue.find((w) => w.id === opts.targetWorkItemId)
    : undefined;

  const activeMid = opts.activeMission?.id;
  const scopedReadyPool =
    activeMid && snapshot.tasks.some((t) => t.missionId === activeMid)
      ? snapshot.tasks.filter((t) => t.missionId === activeMid)
      : snapshot.tasks;

  const readyTasks = getReadyTasks(scopedReadyPool).map((t) => ({
    id: t.id,
    goalId: t.goalId,
    missionId: t.missionId,
    title: t.title,
    status: t.status,
    assignee: t.assignee,
    role: t.role,
  }));

  return JSON.stringify(
    {
      trigger: opts.missionObjective
        ? { type: "mission_launch", objective: opts.missionObjective, missionId: opts.activeMission?.id }
        : opts.decreeText
          ? { type: "operator_directive", text: opts.decreeText }
          : opts.isSelfEvolution && opts.evolutionPlan
            ? {
                type: "self_evolution",
                reason: opts.decisionReason,
                trajectory: opts.evolutionPlan.trajectory,
                gaps: opts.evolutionPlan.gaps,
                suggestedBlueprint: opts.evolutionPlan.suggestedBlueprint ?? null,
              }
            : incomingMsg
              ? { type: "agent_handoff", message: incomingMsg }
              : focusTask
                ? { type: "assigned_task", task: focusTask }
                : focusWork
                  ? { type: "work_queue_item", workItem: focusWork }
                  : { type: "autonomous_cycle", reason: opts.decisionReason },
      actor: { name: opts.actorName, role: opts.actorRole },
      activeDomain: snapshot.activeDomain,
      treasury: {
        tier: snapshot.vitals.tier,
        creditsCents: snapshot.vitals.creditsCents,
        usdcCents: snapshot.vitals.usdcCents,
        reserveCents: snapshot.vitals.reserveCents,
        turns: snapshot.vitals.turns,
      },
      activeMission: opts.activeMission ?? null,
      domainMemories: snapshot.domainMemories
        .filter((m) => m.domainId === snapshot.activeDomain)
        .slice(0, 4)
        .map((m) => ({ title: m.title, sourceType: m.sourceType, summary: m.summary.slice(0, 220) })),
      recentEvolutionEvents: snapshot.evolutionEvents.slice(0, 5).map((e) => ({
        slug: e.trajectorySlug,
        kind: e.actionKind,
        capability: e.capabilityGained,
        summary: e.summary.slice(0, 140),
      })),
      goals: snapshot.goals.map((g) => ({
        id: g.id,
        missionId: g.missionId,
        title: g.title,
        status: g.status,
        progress: g.progress,
      })),
      readyTasks,
      allTasksCount: snapshot.tasks.length,
      availableMeshAgents: snapshot.children.map((w) => ({
        name: w.name,
        role: w.role,
        status: w.status,
        capabilities: w.capabilities,
        task: w.task,
      })),
      registeredTools: snapshot.tools
        .filter((t) => t.enabled)
        .map((t) => ({ name: t.name, kind: t.kind, category: t.category, usageCount: t.usageCount })),
      recentCycles: snapshot.cycles.slice(0, 4).map((c) => ({
        turn: c.turnNumber,
        mode: c.mode ?? "mission",
        agent: c.agentName,
        act: c.phaseAct,
        observe: c.phaseObserve,
        handoffTo: c.handoffTo,
      })),
    },
    null,
    2,
  );
}

export async function runCletusAgentTurn(
  sql: Sql,
  opts: {
    decreeText?: string;
    missionObjective?: string;
    missionId?: string;
    targetWorkItemId?: string;
    targetAgentName?: string;
    creatorInboxId?: string;
    forceEvolution?: boolean;
    preferredTrajectorySlug?: EvolutionTrajectorySlug;
  } = {},
): Promise<{
  snapshot: CletusSnapshot;
  replyText: string;
  toolsUsed: string[];
  actorName: string;
  handoffTo?: string;
  cycleId: string;
  mode: CycleMode;
}> {
  if (activeTurnInProgress) {
    throw new Error("An agent cycle is already executing. Wait for the active cycle to finish.");
  }

  activeTurnInProgress = true;
  try {
    const initialSnapshot = await readSnapshotFromDb(sql);
    const startedPerf = performance.now();
    const startedMs = Date.now();
    const tierPolicy = getTierPolicy(initialSnapshot.vitals.tier, initialSnapshot.vitals.reserveCents);

    if (!tierPolicy.canRunInference) {
      await sql`UPDATE cletus_vitals SET auto_loop = FALSE WHERE id = 1`;
      throw new Error(tierPolicy.directive);
    }

    const activeMission =
      initialSnapshot.missions.find(
        (m) => m.id === (opts.missionId ?? initialSnapshot.vitals.activeMissionId),
      ) ??
      initialSnapshot.missions.find((m) => m.status === "active" || m.status === "planning") ??
      initialSnapshot.missions[0];

    const isDirectIntervention = Boolean(
      opts.missionObjective || opts.decreeText || opts.targetWorkItemId || opts.targetAgentName,
    );

    // If an active operational mission exceeds its cycle budget while running, reconcile/halt it first
    if (
      !opts.forceEvolution &&
      !isDirectIntervention &&
      activeMission &&
      (activeMission.status === "active" || activeMission.status === "planning") &&
      activeMission.cycleCount >= activeMission.maxCycles
    ) {
      await reconcileAndPersistLifecycle(sql, startedMs);
    }

    const evolutionPlan = selectNextEvolutionStep({
      trajectories: initialSnapshot.evolutionTrajectories,
      preferredTrajectorySlug: opts.preferredTrajectorySlug,
      activeDomain: initialSnapshot.activeDomain,
      tools: initialSnapshot.tools,
      children: initialSnapshot.children,
      domainMemories: initialSnapshot.domainMemories,
      cycles: initialSnapshot.cycles,
      denials: initialSnapshot.denials,
      now: startedMs,
    });

    getNvidiaConfig();

    const decision = selectNextActor({
      children: initialSnapshot.children,
      tasks: initialSnapshot.tasks,
      workQueue: initialSnapshot.workQueue,
      agentMessages: initialSnapshot.agentMessages,
      missions: initialSnapshot.missions,
      activeMissionId: activeMission?.id,
      preferredAgentName:
        opts.missionObjective || opts.decreeText
          ? "Orchestrator-Prime"
          : opts.targetAgentName,
      forceEvolution: Boolean(opts.forceEvolution),
      idleEvolutionTarget: {
        agentName: evolutionPlan.actorName,
        agentRole: evolutionPlan.actorRole,
        reason: `No active operational tasks — Self-Evolution [${evolutionPlan.trajectory.slug} · ${evolutionPlan.trajectory.horizon} ${evolutionPlan.trajectory.maturityScore}/100]`,
      },
    });

    const isSelfEvolution =
      !opts.missionObjective &&
      !opts.decreeText &&
      (Boolean(opts.forceEvolution) || decision.mode === "self_evolution");

    if (
      isSelfEvolution &&
      !opts.forceEvolution &&
      initialSnapshot.vitals.tier === "critical"
    ) {
      await sql`UPDATE cletus_vitals SET auto_loop = FALSE WHERE id = 1`;
      throw new Error(
        "CRITICAL SURVIVAL MODE: Background Self-Evolution auto-loop paused to protect remaining reserve floor.",
      );
    }

    const cycleMode: CycleMode = opts.missionObjective
      ? "mission"
      : opts.decreeText || decision.mode === "urgent_directive"
        ? "directive"
        : decision.mode === "handoff"
          ? "handoff"
          : decision.mode === "work_item"
            ? "work_item"
            : isSelfEvolution
              ? "self_evolution"
              : "mission";

    const actor = initialSnapshot.children.find(
      (c) => c.name.toLowerCase() === decision.agentName.toLowerCase(),
    );
    const actorName = actor?.name ?? decision.agentName;
    const actorRole = actor?.role ?? decision.agentRole;

    const claimedWorkId = opts.targetWorkItemId ?? decision.focusWorkItemId;
    if (claimedWorkId) {
      await sql`
        UPDATE cletus_work_queue
        SET status = 'claimed', attempts = attempts + 1, updated_at = ${startedMs}
        WHERE id = ${claimedWorkId} AND status IN ('pending', 'failed')
      `;
    }

    if (decision.pendingMessageId) {
      await sql`
        UPDATE cletus_agent_messages
        SET status = 'processed'
        WHERE id = ${decision.pendingMessageId}
      `;
    }

    let movedTaskToRunningId: string | undefined;
    if (decision.focusTaskId) {
      const targetTask = initialSnapshot.tasks.find((t) => t.id === decision.focusTaskId);
      if (
        targetTask &&
        (targetTask.status === "pending" || targetTask.status === "assigned") &&
        canTransitionTaskStatus(initialSnapshot.tasks, targetTask.id, "running").ok
      ) {
        await sql`
          UPDATE cletus_tasks
          SET status = 'running', updated_at = ${startedMs}
          WHERE id = ${targetTask.id} AND status IN ('pending', 'assigned')
        `;
        movedTaskToRunningId = targetTask.id;
        await recordTaskEvent(sql, {
          taskId: targetTask.id,
          missionId: targetTask.missionId ?? activeMission?.id ?? null,
          goalId: targetTask.goalId,
          previousStatus: targetTask.status,
          status: "running",
          actor: actorName,
          note: `Claimed for ${cycleMode} turn`,
          at: startedMs,
        });
        await sql`
          INSERT INTO cletus_logs (id, at, level, source, message)
          VALUES (${nid("log")}, ${startedMs}, 'info', 'orchestrator', ${`${actorName} claimed task ${targetTask.id} (${targetTask.status} → running)`})
        `;
        await sql`
          UPDATE cletus_workers
          SET task = ${`[${targetTask.id}] ${targetTask.title}`.slice(0, 120)}
          WHERE LOWER(name) = LOWER(${actorName})
        `;
      }
    } else if (isSelfEvolution) {
      await sql`
        UPDATE cletus_workers
        SET task = ${`[EVO:${evolutionPlan.trajectory.slug}] ${evolutionPlan.trajectory.targetCapability}`.slice(0, 120)}
        WHERE LOWER(name) = LOWER(${actorName})
      `;
    }

    const systemInstruction = buildAgentSystemInstruction(
      initialSnapshot,
      actor,
      tierPolicy.directive,
      {
        isMissionLaunch: Boolean(opts.missionObjective),
        isSelfEvolution,
        evolutionPlan,
      },
    );

    const promptText = buildCycleContextPrompt(initialSnapshot, {
      actorName,
      actorRole,
      decreeText: opts.decreeText,
      missionObjective: opts.missionObjective,
      activeMission,
      pendingMessageId: decision.pendingMessageId,
      focusTaskId: decision.focusTaskId,
      targetWorkItemId: claimedWorkId,
      decisionReason: decision.reason,
      evolutionPlan,
      isSelfEvolution,
    });

    const messages: NvidiaChatMessageParam[] = [
      { role: "system", content: systemInstruction },
      { role: "user", content: promptText },
    ];
    const toolsExecuted: string[] = [];
    const toolSummaries: string[] = [];
    const synthesizedToolNames: string[] = [];
    const benchmarkedToolNames: string[] = [];
    const upgradedAgents: string[] = [];
    let recordedEvolutionEventId: string | undefined;
    let replyMessage = "";
    let handoffTarget: string | undefined;
    let finalTextSummary = "";
    let actualModelUsed: string = normalizeWorkerModelId(actor?.model || AGENT_MODEL);

    try {
      const maxRounds = Math.max(1, tierPolicy.maxRoundsPerTurn);
      for (let round = 0; round < maxRounds; round++) {
        const res = await callNvidiaChatCompletions({
          model: actor?.model || AGENT_MODEL,
          messages,
          tools: MAS_TOOL_DEFINITIONS,
        });
        actualModelUsed = res.modelUsed;

        if (res.toolCalls.length === 0) {
          finalTextSummary = res.content;
          if (finalTextSummary && !replyMessage) {
            replyMessage = finalTextSummary;
          }
          break;
        }

        messages.push({
          role: "assistant",
          content: res.content || null,
          tool_calls: res.toolCalls,
        });

        for (const call of res.toolCalls) {
          const toolName = call.function.name || "unknown";
          let args: Record<string, unknown> = {};
          try {
            const parsed = JSON.parse(call.function.arguments || "{}");
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
              args = parsed as Record<string, unknown>;
            }
          } catch {
            args = {};
          }
          toolsExecuted.push(toolName);

          const resultObj = await executeMasTool(
            sql,
            initialSnapshot,
            actorName,
            toolName,
            args,
            activeMission?.id,
          );

          if (toolName === "reply_to_operator" && typeof args.message === "string") {
            replyMessage = args.message;
          }
          if (toolName === "handoff_to_agent" && typeof args.toAgent === "string") {
            handoffTarget = args.toAgent;
          }
          if (toolName === "synthesize_tool" && resultObj.ok && typeof resultObj.toolName === "string") {
            synthesizedToolNames.push(resultObj.toolName);
          }
          if (toolName === "invoke_custom_tool" && resultObj.ok !== false && typeof args.toolName === "string") {
            benchmarkedToolNames.push(args.toolName);
          }
          if (toolName === "configure_agent_role" && resultObj.ok && typeof args.agentName === "string") {
            upgradedAgents.push(args.agentName);
          }
          if (toolName === "record_evolution_milestone" && resultObj.ok && typeof resultObj.eventId === "string") {
            recordedEvolutionEventId = resultObj.eventId;
          }

          const okFlag = resultObj.ok === false || resultObj.allowed === false ? "denied/err" : "ok";
          toolSummaries.push(`${toolName}(${okFlag})`);

          messages.push({
            role: "tool",
            tool_call_id: call.id,
            name: toolName,
            content: JSON.stringify(resultObj),
          });
        }
      }
    } catch (err) {
      const errTime = Date.now();
      const errMsg = err instanceof Error ? err.message : String(err);

      if (movedTaskToRunningId) {
        const reverted = initialSnapshot.tasks.find((t) => t.id === movedTaskToRunningId);
        await sql`
          UPDATE cletus_tasks
          SET status = 'assigned', updated_at = ${errTime}
          WHERE id = ${movedTaskToRunningId} AND status = 'running'
        `;
        await recordTaskEvent(sql, {
          taskId: movedTaskToRunningId,
          missionId: reverted?.missionId ?? activeMission?.id ?? null,
          goalId: reverted?.goalId ?? null,
          previousStatus: "running",
          status: "assigned",
          actor: actorName,
          note: `Reverted after cycle fault: ${errMsg.slice(0, 120)}`,
          at: errTime,
        });
      }
      if (claimedWorkId) {
        await sql`
          UPDATE cletus_work_queue
          SET status = CASE WHEN attempts >= 3 THEN 'failed' ELSE 'pending' END,
              error = ${errMsg.slice(0, 400)},
              updated_at = ${errTime}
          WHERE id = ${claimedWorkId} AND status = 'claimed'
        `;
      }

      const failCycleId = nid("cyc");
      const failTurnNum = initialSnapshot.vitals.turns + 1;
      await sql`
        INSERT INTO cletus_cycles (
          id, mission_id, mode, turn_number, agent_name, agent_role,
          phase_perceive, phase_reason, phase_act, phase_observe,
          tools_used, handoff_to, duration_ms, cost_cents, tier, status, created_at
        ) VALUES (
          ${failCycleId}, ${activeMission?.id ?? null}, ${cycleMode}, ${failTurnNum}, ${actorName}, ${actorRole},
          ${`Tier=${initialSnapshot.vitals.tier} · Trigger: ${decision.reason}`},
          ${`${actorName} initiated turn but encountered runtime fault.`},
          ${toolSummaries.join(" → ") || "Aborted prior to tool completion"},
          ${`ERROR: ${errMsg.slice(0, 380)}`},
          ${JSON.stringify(toolsExecuted)}, ${null},
          ${Math.max(1, Math.round(performance.now() - startedPerf))}, 0,
          ${initialSnapshot.vitals.tier}, 'error', ${errTime}
        )
      `;
      throw err;
    }

    const endMs = Date.now();

    // Deterministic fallback decomposition if a launched mission still has 0 scoped tasks
    if (opts.missionObjective && activeMission) {
      const scopedRows = await sql<{ cnt: number }>`
        SELECT COUNT(*)::int AS cnt FROM cletus_tasks WHERE mission_id = ${activeMission.id}
      `;
      if (Number(scopedRows[0]?.cnt ?? 0) === 0) {
        const fallback = buildFallbackMissionPlan({
          objective: opts.missionObjective,
          healthyAgents: initialSnapshot.children
            .filter((c) => c.status === "healthy")
            .map((c) => ({ name: c.name, role: c.role })),
          idFactory: (prefix) => nid(prefix),
        });

        for (const g of fallback.goals) {
          await sql`
            INSERT INTO cletus_goals (
              id, mission_id, title, detail, status, progress, expected_revenue_cents, actual_revenue_cents
            ) VALUES (${g.id}, ${activeMission.id}, ${g.title}, ${g.detail}, 'active', 0, 0, 0)
          `;
        }
        for (const t of fallback.tasks) {
          await sql`
            INSERT INTO cletus_tasks (
              id, goal_id, mission_id, title, detail, status, assignee, role, depends_on, result, created_at, updated_at
            ) VALUES (
              ${t.id}, ${t.goalId}, ${activeMission.id}, ${t.title}, ${t.detail}, ${t.status},
              ${t.assignee}, ${t.role}, ${JSON.stringify(t.dependsOn)}, ${null}, ${endMs}, ${endMs}
            )
          `;
          await recordTaskEvent(sql, {
            taskId: t.id,
            missionId: activeMission.id,
            goalId: t.goalId,
            status: t.status,
            actor: actorName,
            note: `Fallback DAG: ${t.title}`,
            at: endMs,
          });
        }
        await sql`
          UPDATE cletus_missions
          SET status = 'active', plan_summary = ${fallback.planSummary}, updated_at = ${endMs}
          WHERE id = ${activeMission.id}
        `;
        const rootTask = fallback.tasks[0];
        if (rootTask && !handoffTarget) {
          handoffTarget = rootTask.assignee;
          await sql`
            INSERT INTO cletus_agent_messages (
              id, mission_id, task_id, from_agent, to_agent, message_type, subject, payload, status, created_at
            ) VALUES (
              ${nid("msg")}, ${activeMission.id}, ${rootTask.id}, 'Orchestrator-Prime', ${rootTask.assignee},
              'handoff', ${`Execute root task: ${rootTask.title}`},
              ${JSON.stringify({ objective: opts.missionObjective, taskId: rootTask.id })},
              'pending', ${endMs}
            )
          `;
        }
        await sql`
          INSERT INTO cletus_logs (id, at, level, source, message)
          VALUES (
            ${nid("log")}, ${endMs}, 'info', 'orchestrator',
            ${`synthesized deterministic fallback DAG (${fallback.tasks.length} tasks) for mission ${activeMission.id}`}
          )
        `;
      }
    }

    // Reconcile claimed work item if model didn't explicitly update it via complete_work_item
    if (claimedWorkId) {
      const workRows = await sql<{ status: string }>`
        SELECT status FROM cletus_work_queue WHERE id = ${claimedWorkId} LIMIT 1
      `;
      if (workRows[0]?.status === "claimed") {
        const autoResult = JSON.stringify({
          success: true,
          verified: true,
          actor: actorName,
          toolsUsed: toolsExecuted,
          summary: (finalTextSummary || replyMessage || "Cycle completed").slice(0, 320),
        });
        await sql`
          UPDATE cletus_work_queue
          SET status = 'completed', result = ${autoResult}, error = ${null}, updated_at = ${endMs}
          WHERE id = ${claimedWorkId} AND status = 'claimed'
        `;
      }
    }

    const elapsedMs = Math.max(1, Math.round(performance.now() - startedPerf));
    const computeCostCents = 4 + Math.min(16, toolsExecuted.length * 2);

    if (!replyMessage) {
      replyMessage = opts.missionObjective
        ? `Mission launched and decomposed by ${actorName}.`
        : opts.decreeText
          ? `Directive processed by ${actorName} (${toolSummaries.join(", ") || "state evaluated"}).`
          : isSelfEvolution
            ? `${actorName} advanced Self-Evolution [${evolutionPlan.trajectory.slug}]: ${toolSummaries.join(", ") || "evaluated growth trajectory"}.`
            : `${actorName} completed cycle: ${toolSummaries.join(", ") || "state verified"}.`;
    }

    if (!toolsExecuted.includes("reply_to_operator") && (opts.decreeText || opts.missionObjective)) {
      await sql`
        INSERT INTO cletus_inbox (id, sender, content, at, status, priority, tools_used)
        VALUES (${nid("inb")}, 'agent', ${replyMessage}, ${endMs}, 'done', 'supreme', ${JSON.stringify(toolsExecuted)})
      `;
    }

    if (opts.creatorInboxId) {
      await sql`
        UPDATE cletus_inbox
        SET status = 'done'
        WHERE id = ${opts.creatorInboxId} AND status IN ('received', 'claimed')
      `;
    } else if (opts.decreeText || opts.missionObjective) {
      const latestCreator = await sql<{ id: string }>`
        SELECT id FROM cletus_inbox
        WHERE sender = 'creator' AND status IN ('received', 'claimed')
        ORDER BY at DESC
        LIMIT 1
      `;
      if (latestCreator[0]) {
        await sql`UPDATE cletus_inbox SET status = 'done' WHERE id = ${latestCreator[0].id}`;
      }
    }

    // Persist explicit 4-phase Perceive -> Reason -> Act -> Observe record
    const cycleId = nid("cyc");
    const nextTurnNum = initialSnapshot.vitals.turns + 1;
    const phasePerceive = `Tier=${initialSnapshot.vitals.tier} (${(initialSnapshot.vitals.creditsCents / 100).toFixed(2)} cr) · Trigger: ${decision.reason}`;
    const phaseReason = isSelfEvolution
      ? `${actorName} (${actorRole}) targeted trajectory '${evolutionPlan.trajectory.title}' (${evolutionPlan.trajectory.horizon} · ${evolutionPlan.trajectory.maturityScore}/100).`
      : `${actorName} (${actorRole}) evaluated ${getReadyTasks(initialSnapshot.tasks).length} ready DAG tasks under ${tierPolicy.tier} policy.`;
    const phaseAct =
      toolSummaries.length > 0
        ? `Invoked ${toolSummaries.join(" → ")}${handoffTarget ? ` · Handed off to ${handoffTarget}` : ""}.`
        : `Evaluated state without external mutation.`;
    const phaseObserve = (finalTextSummary || replyMessage).slice(0, 420);

    await sql`
      INSERT INTO cletus_cycles (
        id, mission_id, mode, turn_number, agent_name, agent_role,
        phase_perceive, phase_reason, phase_act, phase_observe,
        tools_used, handoff_to, duration_ms, cost_cents, tier, status, created_at
      ) VALUES (
        ${cycleId}, ${isSelfEvolution ? null : (activeMission?.id ?? null)}, ${cycleMode}, ${nextTurnNum}, ${actorName}, ${actorRole},
        ${phasePerceive}, ${phaseReason}, ${phaseAct}, ${phaseObserve},
        ${JSON.stringify(toolsExecuted)}, ${handoffTarget ?? null}, ${elapsedMs}, ${computeCostCents},
        ${initialSnapshot.vitals.tier}, 'completed', ${endMs}
      )
    `;

    // Ensure every Self-Evolution cycle records a verified milestone & advances trajectory maturity
    if (isSelfEvolution) {
      if (recordedEvolutionEventId) {
        await sql`
          UPDATE cletus_evolution_events
          SET cycle_id = ${cycleId}
          WHERE id = ${recordedEvolutionEventId}
        `;
      } else {
        const derived = deriveEvolutionOutcomeFromTurn({
          trajectory: evolutionPlan.trajectory,
          toolsUsed: toolsExecuted,
          synthesizedToolNames,
          benchmarkedToolNames,
          upgradedAgents,
          finalText: finalTextSummary || replyMessage,
          defaultBlueprintName: evolutionPlan.suggestedBlueprint?.name,
        });
        const nextScore = Math.min(100, evolutionPlan.trajectory.maturityScore + derived.maturityDelta);
        const nextHorizon = computeHorizonForMaturity(nextScore);

        await sql`
          UPDATE cletus_evolution_trajectories
          SET maturity_score = ${nextScore},
              horizon = ${nextHorizon},
              cycles_completed = cycles_completed + 1,
              last_evolved_at = ${endMs},
              last_outcome = ${derived.summary.slice(0, 280)},
              updated_at = ${endMs}
          WHERE id = ${evolutionPlan.trajectory.id}
        `;

        await sql`
          INSERT INTO cletus_evolution_events (
            id, trajectory_id, trajectory_slug, domain_id, cycle_id, agent_name,
            action_kind, summary, capability_gained, artifact_ref, maturity_delta, verified, created_at
          ) VALUES (
            ${nid("evo")}, ${evolutionPlan.trajectory.id}, ${evolutionPlan.trajectory.slug},
            ${initialSnapshot.activeDomain}, ${cycleId}, ${actorName},
            ${derived.actionKind}, ${derived.summary}, ${derived.capabilityGained ?? null},
            ${derived.artifactRef ?? null}, ${derived.maturityDelta}, ${derived.verified}, ${endMs}
          )
        `;

        await sql`
          INSERT INTO cletus_logs (id, at, level, source, message)
          VALUES (
            ${nid("log")}, ${endMs}, 'info', 'evolution',
            ${`${actorName} [${evolutionPlan.trajectory.slug}] +${derived.maturityDelta} → ${nextScore}/100 (${nextHorizon}): ${derived.summary.slice(0, 120)}`}
          )
        `;
      }
    }

    await sql`
      INSERT INTO cletus_thoughts (id, at, thinking, speech, tools)
      VALUES (${nid("thn")}, ${endMs}, ${`${actorName}: ${phaseAct}`}, ${replyMessage}, ${JSON.stringify(toolsExecuted)})
    `;

    await sql`
      UPDATE cletus_workers
      SET last_beat_at = ${endMs},
          latency_ms = ${elapsedMs},
          cycle_count = cycle_count + 1
      WHERE LOWER(name) = LOWER(${actorName})
    `;

    if (
      activeMission &&
      !isSelfEvolution &&
      (activeMission.status === "active" || activeMission.status === "planning")
    ) {
      await sql`
        UPDATE cletus_missions
        SET cycle_count = cycle_count + 1, updated_at = ${endMs}
        WHERE id = ${activeMission.id}
      `;
    }

    const pauseAutoLoop = !tierPolicy.allowContinuousAutoLoop;
    await sql`
      UPDATE cletus_vitals
      SET turns = turns + 1,
          credits_cents = GREATEST(0, credits_cents - ${computeCostCents}),
          auto_loop = CASE WHEN ${pauseAutoLoop} THEN FALSE ELSE auto_loop END
      WHERE id = 1
    `;

    await sql`
      INSERT INTO cletus_spend_events (id, at, model, tool, category, cents)
      VALUES (${nid("spd")}, ${endMs}, ${actualModelUsed}, ${toolsExecuted[0] ?? "inference"}, 'inference', ${computeCostCents})
    `;

    await sql`
      INSERT INTO cletus_logs (id, at, level, source, message)
      VALUES (
        ${nid("log")},
        ${endMs},
        'info',
        ${isSelfEvolution ? "evolution" : "cycle"},
        ${`turn ${nextTurnNum} [${cycleMode}:${actorName}] · ${elapsedMs}ms · tools [${toolsExecuted.join(", ") || "none"}]${handoffTarget ? ` → ${handoffTarget}` : ""}`}
      )
    `;

    // Unlock downstream DAG tasks, sync Goal progress, check Mission completion/budget, and run due heartbeats
    await reconcileAndPersistLifecycle(sql, endMs);
    await runHeartbeatSweep(sql, { forceAll: false, minCooldownMs: 25_000 });

    const updated = await readSnapshotFromDb(sql);
    return {
      snapshot: updated,
      replyText: replyMessage,
      toolsUsed: toolsExecuted,
      actorName,
      handoffTo: handoffTarget,
      cycleId,
      mode: cycleMode,
    };
  } finally {
    activeTurnInProgress = false;
  }
}
