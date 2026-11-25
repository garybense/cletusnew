import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { RankedMemoryResult } from "./domains";
import { nid } from "./format";
import { validatePublicHttpsUrl } from "./mas-engine";
import type {
  AudioBriefing,
  CletusSnapshot,
  CycleMode,
  DomainId,
  DomainMemoryItem,
  DynamicTool,
  EvolutionTrajectorySlug,
  GeoGroundingPlace,
  JsonObject,
  NvidiaChatMessage,
  NvidiaVideoJob,
  TaskStatus,
  WebGroundingSource,
} from "./types";

export interface TurnActionResult {
  snapshot: CletusSnapshot;
  turnError?: string;
  replyText?: string;
  actorName?: string;
  handoffTo?: string;
  cyclesExecuted?: number;
  mode?: CycleMode;
}

export interface ToolRunResult {
  snapshot: CletusSnapshot;
  ok: boolean;
  output: JsonObject;
  durationMs: number;
}

export const getSnapshotServer = createServerFn({ method: "GET" }).handler(
  async (): Promise<CletusSnapshot> => {
    const { getSql } = await import("@/lib/db");
    const { readSnapshotFromDb } = await import("./seed.server");
    const sql = await getSql();
    return readSnapshotFromDb(sql);
  },
);

const issueDecreeSchema = z.object({
  text: z.string().trim().min(1).max(2000),
  runAgentTurn: z.boolean().optional(),
  targetAgentName: z.string().optional(),
});

export const issueDecreeServer = createServerFn({ method: "POST" })
  .validator((input: unknown) => issueDecreeSchema.parse(input))
  .handler(async ({ data }): Promise<TurnActionResult> => {
    const { getSql } = await import("@/lib/db");
    const { readSnapshotFromDb } = await import("./seed.server");
    const { runCletusAgentTurn } = await import("./agent-runner.server");
    const sql = await getSql();
    const now = Date.now();
    const msgId = nid("inb");
    const workId = nid("wrk");
    const vitalsRows = await sql<{ active_mission_id: string | null }>`
      SELECT active_mission_id FROM cletus_vitals WHERE id = 1
    `;
    const activeMissionId = vitalsRows[0]?.active_mission_id ?? null;

    await sql`
      INSERT INTO cletus_inbox (id, sender, content, at, status, priority, tools_used)
      VALUES (${msgId}, 'creator', ${data.text}, ${now}, 'received', 'supreme', '[]')
    `;

    await sql`
      INSERT INTO cletus_work_queue (id, mission_id, source, payload, acceptance_predicate, priority, spend_bearing, status, attempts, result, error, created_at, updated_at)
      VALUES (
        ${workId},
        ${activeMissionId},
        'operator_directive',
        ${JSON.stringify({ directive: data.text })},
        'result.success === true',
        100,
        FALSE,
        'pending',
        0,
        ${null},
        ${null},
        ${now},
        ${now}
      )
    `;

    await sql`
      UPDATE cletus_vitals
      SET state = 'running', sleep_until = ${null}, paused = FALSE
      WHERE id = 1
    `;

    await sql`
      INSERT INTO cletus_logs (id, at, level, source, message)
      VALUES (${nid("log")}, ${now}, 'info', 'inbox', 'operator directive persisted · supreme priority · Orchestrator-Prime engaged')
    `;

    if (data.runAgentTurn === false) {
      return { snapshot: await readSnapshotFromDb(sql) };
    }

    try {
      const res = await runCletusAgentTurn(sql, {
        decreeText: data.text,
        targetWorkItemId: workId,
        targetAgentName: data.targetAgentName,
        creatorInboxId: msgId,
      });
      return {
        snapshot: res.snapshot,
        replyText: res.replyText,
        actorName: res.actorName,
        handoffTo: res.handoffTo,
        cyclesExecuted: 1,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await sql`
        INSERT INTO cletus_logs (id, at, level, source, message)
        VALUES (${nid("log")}, ${Date.now()}, 'error', 'inference', ${msg})
      `;
      return { snapshot: await readSnapshotFromDb(sql), turnError: msg };
    }
  });

const launchMissionSchema = z.object({
  title: z.string().trim().min(1).max(160).optional(),
  objective: z.string().trim().min(3).max(3000),
  maxCycles: z.number().int().min(2).max(40).optional(),
  autoLoop: z.boolean().optional(),
});

export const launchMissionServer = createServerFn({ method: "POST" })
  .validator((input: unknown) => launchMissionSchema.parse(input))
  .handler(async ({ data }): Promise<TurnActionResult> => {
    const { getSql } = await import("@/lib/db");
    const { readSnapshotFromDb } = await import("./seed.server");
    const { runCletusAgentTurn } = await import("./agent-runner.server");
    const sql = await getSql();
    const now = Date.now();
    const missionId = nid("msn");
    const inbId = nid("inb");
    const title =
      data.title?.trim() ||
      (data.objective.length > 76 ? `${data.objective.slice(0, 73)}…` : data.objective);

    // Supersede any previously active/planning missions cleanly before activating the new mission
    await sql`
      UPDATE cletus_missions
      SET status = 'completed', updated_at = ${now}
      WHERE status IN ('active', 'planning')
    `;

    await sql`
      INSERT INTO cletus_missions (
        id, title, objective, status, orchestrator, plan_summary,
        success_criteria, cycle_count, max_cycles, created_at, updated_at
      ) VALUES (
        ${missionId}, ${title}, ${data.objective}, 'planning', 'Orchestrator-Prime',
        'Awaiting Orchestrator-Prime decomposition & tool discovery.',
        'All mission tasks verified completed by specialist & auditor roles.',
        0, ${data.maxCycles ?? 12}, ${now}, ${now}
      )
    `;

    await sql`
      INSERT INTO cletus_inbox (id, sender, content, at, status, priority, tools_used)
      VALUES (${inbId}, 'creator', ${`[MISSION ${missionId}] ${data.objective}`}, ${now}, 'received', 'supreme', '[]')
    `;

    await sql`
      UPDATE cletus_vitals
      SET state = 'running',
          sleep_until = ${null},
          paused = FALSE,
          active_mission_id = ${missionId},
          auto_loop = ${Boolean(data.autoLoop)}
      WHERE id = 1
    `;

    await sql`
      INSERT INTO cletus_logs (id, at, level, source, message)
      VALUES (${nid("log")}, ${now}, 'info', 'mission', ${`launched ${missionId}: ${title}`})
    `;

    try {
      const res = await runCletusAgentTurn(sql, {
        missionObjective: data.objective,
        missionId,
        targetAgentName: "Orchestrator-Prime",
        creatorInboxId: inbId,
      });
      return {
        snapshot: res.snapshot,
        replyText: res.replyText,
        actorName: res.actorName,
        handoffTo: res.handoffTo,
        cyclesExecuted: 1,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await sql`
        UPDATE cletus_missions SET status = 'halted', updated_at = ${Date.now()} WHERE id = ${missionId}
      `;
      await sql`
        INSERT INTO cletus_logs (id, at, level, source, message)
        VALUES (${nid("log")}, ${Date.now()}, 'error', 'mission', ${msg})
      `;
      return { snapshot: await readSnapshotFromDb(sql), turnError: msg };
    }
  });

const runTurnSchema = z.object({
  workItemId: z.string().optional(),
  targetAgentName: z.string().optional(),
  steps: z.number().int().min(1).max(4).optional(),
  forceEvolution: z.boolean().optional(),
  preferredTrajectorySlug: z
    .enum([
      "research_frontier",
      "capability_forging",
      "mesh_calibration",
      "memory_consolidation",
      "resilience_audit",
    ])
    .optional(),
});

export const runAgentTurnServer = createServerFn({ method: "POST" })
  .validator((input: unknown) => runTurnSchema.parse(input ?? {}))
  .handler(async ({ data }): Promise<TurnActionResult> => {
    const { getSql } = await import("@/lib/db");
    const { readSnapshotFromDb } = await import("./seed.server");
    const { runCletusAgentTurn } = await import("./agent-runner.server");
    const sql = await getSql();
    const steps = data.steps ?? 1;
    let lastSnap: CletusSnapshot | undefined;
    let lastReply = "";
    let lastActor = "";
    let lastHandoff: string | undefined;
    let lastMode: CycleMode | undefined;
    let completedSteps = 0;

    try {
      for (let i = 0; i < steps; i++) {
        const res = await runCletusAgentTurn(sql, {
          targetWorkItemId: i === 0 ? data.workItemId : undefined,
          targetAgentName: i === 0 ? data.targetAgentName : undefined,
          forceEvolution: data.forceEvolution,
          preferredTrajectorySlug: i === 0 ? data.preferredTrajectorySlug : undefined,
        });
        lastSnap = res.snapshot;
        lastReply = res.replyText;
        lastActor = res.actorName;
        lastHandoff = res.handoffTo;
        lastMode = res.mode;
        completedSteps += 1;

        if (lastSnap.vitals.tier === "dead" || lastSnap.vitals.tier === "critical") {
          break;
        }
      }
      return {
        snapshot: lastSnap ?? (await readSnapshotFromDb(sql)),
        replyText: lastReply,
        actorName: lastActor,
        handoffTo: lastHandoff,
        cyclesExecuted: completedSteps,
        mode: lastMode,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await sql`
        INSERT INTO cletus_logs (id, at, level, source, message)
        VALUES (${nid("log")}, ${Date.now()}, 'error', 'inference', ${msg})
      `;
      return {
        snapshot: await readSnapshotFromDb(sql),
        turnError: msg,
        cyclesExecuted: completedSteps,
      };
    }
  });

export const toggleAutoLoopServer = createServerFn({ method: "POST" }).handler(
  async (): Promise<CletusSnapshot> => {
    const { getSql } = await import("@/lib/db");
    const { readSnapshotFromDb } = await import("./seed.server");
    const sql = await getSql();
    const now = Date.now();
    await sql`UPDATE cletus_vitals SET auto_loop = NOT auto_loop, paused = FALSE WHERE id = 1`;
    const rows = await sql<{ auto_loop: boolean }>`SELECT auto_loop FROM cletus_vitals WHERE id = 1`;
    const enabled = Boolean(rows[0]?.auto_loop);
    await sql`
      INSERT INTO cletus_logs (id, at, level, source, message)
      VALUES (${nid("log")}, ${now}, 'info', 'loop', ${`autonomous multi-agent cycle loop ${enabled ? "ENABLED" : "PAUSED"}`})
    `;
    return readSnapshotFromDb(sql);
  },
);

const creditsGovernorSchema = z.object({
  creditsCents: z.number().int().min(0).max(5_000_000),
});

export const setSimulatedCreditsServer = createServerFn({ method: "POST" })
  .validator((input: unknown) => creditsGovernorSchema.parse(input))
  .handler(async ({ data }): Promise<CletusSnapshot> => {
    const { getSql } = await import("@/lib/db");
    const { readSnapshotFromDb } = await import("./seed.server");
    const { tierFromCredits } = await import("./mas-engine");
    const sql = await getSql();
    const now = Date.now();
    const vitals = await sql<{ reserve_cents: number }>`SELECT reserve_cents FROM cletus_vitals WHERE id = 1`;
    const reserve = Number(vitals[0]?.reserve_cents ?? 1000);
    const nextTier = tierFromCredits(data.creditsCents, reserve);

    await sql`
      UPDATE cletus_vitals
      SET credits_cents = ${data.creditsCents},
          credits_synthetic_override = TRUE,
          auto_loop = CASE WHEN ${nextTier === "dead" || nextTier === "critical"} THEN FALSE ELSE auto_loop END
      WHERE id = 1
    `;
    await sql`
      INSERT INTO cletus_logs (id, at, level, source, message)
      VALUES (
        ${nid("log")}, ${now}, ${nextTier === "dead" || nextTier === "critical" ? "warn" : "info"},
        'treasury',
        ${`credit governor set ${(data.creditsCents / 100).toFixed(2)} cr → survival tier [${nextTier}]`}
      )
    `;
    return readSnapshotFromDb(sql);
  });

const configureAgentSchema = z.object({
  agentName: z.string().trim().min(2).max(64),
  role: z.string().trim().min(2).max(64),
  systemPrompt: z.string().trim().min(4).max(2000),
  capabilities: z.array(z.string()).default([]),
  taskNote: z.string().max(300).optional(),
  verifyHealthy: z.boolean().optional(),
});

export const configureAgentServer = createServerFn({ method: "POST" })
  .validator((input: unknown) => configureAgentSchema.parse(input))
  .handler(async ({ data }): Promise<CletusSnapshot> => {
    const { getSql } = await import("@/lib/db");
    const { readSnapshotFromDb } = await import("./seed.server");
    const sql = await getSql();
    const now = Date.now();

    const existing = await sql<{ id: string }>`
      SELECT id FROM cletus_workers WHERE LOWER(name) = LOWER(${data.agentName}) LIMIT 1
    `;

    if (existing[0]) {
      await sql`
        UPDATE cletus_workers
        SET role = ${data.role},
            system_prompt = ${data.systemPrompt},
            capabilities = ${JSON.stringify(data.capabilities)},
            task = COALESCE(${data.taskNote ?? null}, task),
            status = CASE WHEN ${Boolean(data.verifyHealthy)} THEN 'healthy' ELSE status END,
            last_beat_at = ${now},
            error_note = ${null}
        WHERE id = ${existing[0].id}
      `;
    } else {
      await sql`
        INSERT INTO cletus_workers (
          id, name, kind, status, role, last_beat_at, task, latency_ms, funded_cents,
          live, error_note, system_prompt, model, capabilities, autonomy_level, cycle_count
        ) VALUES (
          ${nid("agt")}, ${data.agentName}, 'openclaw', 'healthy', ${data.role},
          ${now}, ${data.taskNote ?? `Active · ${data.role}`}, 24, 0, ${true}, ${null},
          ${data.systemPrompt}, 'nvidia/llama-3.3-nemotron-super-49b-v1', ${JSON.stringify(data.capabilities)}, 'autonomous', 0
        )
      `;
    }

    await sql`
      INSERT INTO cletus_logs (id, at, level, source, message)
      VALUES (${nid("log")}, ${now}, 'info', 'mesh', ${`operator configured agent ${data.agentName} (role=${data.role})`})
    `;
    return readSnapshotFromDb(sql);
  });

const synthesizeToolSchema = z.object({
  name: z.string().trim().min(2).max(64),
  category: z.string().trim().min(2).max(32),
  kind: z.enum(["http_json", "nvidia_analyzer"]),
  description: z.string().trim().min(4).max(500),
  urlTemplate: z.string().max(600).optional(),
  promptTemplate: z.string().max(2000).optional(),
});

export const synthesizeToolServer = createServerFn({ method: "POST" })
  .validator((input: unknown) => synthesizeToolSchema.parse(input))
  .handler(async ({ data }): Promise<CletusSnapshot> => {
    const cleanName = data.name.toLowerCase().replace(/[^a-z0-9_]/g, "_");
    const cfg: JsonObject = {};
    if (data.kind === "http_json") {
      const tpl = (data.urlTemplate ?? "").trim();
      const valid = validatePublicHttpsUrl(tpl.replace(/\{\{[a-zA-Z0-9_]+\}\}/g, "sample"));
      if (!valid.ok) throw new Error(valid.error);
      cfg.urlTemplate = tpl;
      cfg.method = "GET";
    } else {
      cfg.promptTemplate =
        data.promptTemplate?.trim() || "Analyze the supplied JSON parameters and return concise findings.";
    }

    const { getSql } = await import("@/lib/db");
    const { readSnapshotFromDb } = await import("./seed.server");
    const sql = await getSql();
    const now = Date.now();

    await sql`
      INSERT INTO cletus_tools (
        id, name, category, kind, description, input_schema, config_json,
        enabled, created_by, usage_count, last_used_at, created_at
      ) VALUES (
        ${nid("tl")}, ${cleanName}, ${data.category}, ${data.kind}, ${data.description},
        '{"query":"string"}', ${JSON.stringify(cfg)}, ${true}, 'Operator', 0, ${null}, ${now}
      )
      ON CONFLICT (name) DO UPDATE SET
        category = EXCLUDED.category,
        kind = EXCLUDED.kind,
        description = EXCLUDED.description,
        config_json = EXCLUDED.config_json,
        enabled = TRUE
    `;

    await sql`
      INSERT INTO cletus_logs (id, at, level, source, message)
      VALUES (${nid("log")}, ${now}, 'info', 'evolution', ${`registered tool ${cleanName} (${data.kind})`})
    `;
    return readSnapshotFromDb(sql);
  });

const testToolSchema = z.object({
  toolName: z.string().trim().min(1),
  argsJson: z.string().default("{}"),
});

export const testToolServer = createServerFn({ method: "POST" })
  .validator((input: unknown) => testToolSchema.parse(input))
  .handler(async ({ data }): Promise<ToolRunResult> => {
    const { getSql } = await import("@/lib/db");
    const { readSnapshotFromDb } = await import("./seed.server");
    const { invokeRegisteredTool } = await import("./tools.server");
    const sql = await getSql();
    const started = performance.now();

    let args: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(data.argsJson || "{}");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        args = parsed as Record<string, unknown>;
      }
    } catch {
      throw new Error("Invalid JSON arguments.");
    }

    const rows = await sql<{
      id: string;
      name: string;
      category: string;
      kind: string;
      description: string;
      input_schema: string;
      config_json: string;
      enabled: boolean;
      created_by: string;
      usage_count: number;
      last_used_at: number | null;
      created_at: number;
    }>`SELECT * FROM cletus_tools WHERE LOWER(name) = LOWER(${data.toolName}) LIMIT 1`;

    const row = rows[0];
    if (!row) throw new Error(`Tool '${data.toolName}' not found.`);

    const tool: DynamicTool = {
      id: row.id,
      name: row.name,
      category: row.category,
      kind: row.kind as DynamicTool["kind"],
      description: row.description,
      inputSchema: JSON.parse(row.input_schema) as JsonObject,
      configJson: JSON.parse(row.config_json) as JsonObject,
      enabled: Boolean(row.enabled),
      createdBy: row.created_by,
      usageCount: Number(row.usage_count),
      lastUsedAt: row.last_used_at ?? undefined,
      createdAt: Number(row.created_at),
    };

    const output = JSON.parse(
      JSON.stringify(await invokeRegisteredTool(sql, tool, args)),
    ) as JsonObject;
    const durationMs = Math.max(1, Math.round(performance.now() - started));

    await sql`
      INSERT INTO cletus_logs (id, at, level, source, message)
      VALUES (${nid("log")}, ${Date.now()}, 'tool', 'forge', ${`executed ${tool.name} · ${durationMs}ms`})
    `;

    return {
      snapshot: await readSnapshotFromDb(sql),
      ok: output.ok !== false,
      output,
      durationMs,
    };
  });

const agentMessageSchema = z.object({
  fromAgent: z.string().trim().min(1).max(64),
  toAgent: z.string().trim().min(1).max(64),
  messageType: z.enum(["handoff", "plan_proposal", "critique", "tool_share", "status"]),
  subject: z.string().trim().min(1).max(200),
  payloadStr: z.string().default("{}"),
  executeHandoffTurn: z.boolean().optional(),
});

export const sendAgentMessageServer = createServerFn({ method: "POST" })
  .validator((input: unknown) => agentMessageSchema.parse(input))
  .handler(async ({ data }): Promise<TurnActionResult> => {
    const { getSql } = await import("@/lib/db");
    const { readSnapshotFromDb } = await import("./seed.server");
    const { runCletusAgentTurn } = await import("./agent-runner.server");
    const sql = await getSql();
    const now = Date.now();
    const vitals = await sql<{ active_mission_id: string | null }>`
      SELECT active_mission_id FROM cletus_vitals WHERE id = 1
    `;
    let payloadObj: JsonObject = {};
    try {
      const parsed = JSON.parse(data.payloadStr || "{}");
      payloadObj =
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as JsonObject)
          : { note: data.payloadStr };
    } catch {
      payloadObj = { note: data.payloadStr };
    }

    const msgId = nid("msg");
    await sql`
      INSERT INTO cletus_agent_messages (
        id, mission_id, task_id, from_agent, to_agent, message_type, subject, payload, status, created_at
      ) VALUES (
        ${msgId}, ${vitals[0]?.active_mission_id ?? null}, ${null},
        ${data.fromAgent}, ${data.toAgent}, ${data.messageType}, ${data.subject},
        ${JSON.stringify(payloadObj)}, 'pending', ${now}
      )
    `;

    await sql`
      INSERT INTO cletus_logs (id, at, level, source, message)
      VALUES (${nid("log")}, ${now}, 'info', 'mesh', ${`${data.messageType} ${msgId} · ${data.fromAgent} → ${data.toAgent}`})
    `;

    if (!data.executeHandoffTurn) {
      return { snapshot: await readSnapshotFromDb(sql) };
    }

    try {
      const res = await runCletusAgentTurn(sql, { targetAgentName: data.toAgent });
      return {
        snapshot: res.snapshot,
        replyText: res.replyText,
        actorName: res.actorName,
        handoffTo: res.handoffTo,
        cyclesExecuted: 1,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { snapshot: await readSnapshotFromDb(sql), turnError: msg };
    }
  });

const enqueueWorkSchema = z.object({
  source: z.string().trim().min(1).max(64),
  payloadStr: z.string().min(2).max(4000),
  acceptancePredicate: z.string().trim().min(1).max(500),
  priority: z.number().int().min(0).max(1000),
  spendBearing: z.boolean(),
});

export const enqueueWorkItemServer = createServerFn({ method: "POST" })
  .validator((input: unknown) => enqueueWorkSchema.parse(input))
  .handler(async ({ data }): Promise<CletusSnapshot> => {
    let parsedPayload: Record<string, unknown>;
    try {
      const raw = JSON.parse(data.payloadStr);
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new Error("Payload must be a JSON object.");
      }
      parsedPayload = raw as Record<string, unknown>;
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : "Invalid JSON payload");
    }

    const { getSql } = await import("@/lib/db");
    const { readSnapshotFromDb } = await import("./seed.server");
    const sql = await getSql();
    const now = Date.now();
    const id = nid("wrk");
    const vitalsRows = await sql<{ active_mission_id: string | null }>`
      SELECT active_mission_id FROM cletus_vitals WHERE id = 1
    `;
    const activeMissionId = vitalsRows[0]?.active_mission_id ?? null;

    await sql`
      INSERT INTO cletus_work_queue (
        id, mission_id, source, payload, acceptance_predicate, priority, spend_bearing,
        status, attempts, result, error, created_at, updated_at
      ) VALUES (
        ${id}, ${activeMissionId}, ${data.source}, ${JSON.stringify(parsedPayload)}, ${data.acceptancePredicate},
        ${data.priority}, ${data.spendBearing}, 'pending', 0, ${null}, ${null}, ${now}, ${now}
      )
    `;

    await sql`
      INSERT INTO cletus_logs (id, at, level, source, message)
      VALUES (${nid("log")}, ${now}, 'info', 'queue', ${`enqueued ${id} [${data.source}] P:${data.priority}`})
    `;

    return readSnapshotFromDb(sql);
  });

const controlWorkSchema = z.object({
  id: z.string().min(1),
  action: z.enum(["retry", "fail", "delete", "reprioritize", "execute"]),
  newPriority: z.number().int().min(0).max(1000).optional(),
});

export const controlWorkItemServer = createServerFn({ method: "POST" })
  .validator((input: unknown) => controlWorkSchema.parse(input))
  .handler(async ({ data }): Promise<TurnActionResult> => {
    const { getSql } = await import("@/lib/db");
    const { readSnapshotFromDb } = await import("./seed.server");
    const { runCletusAgentTurn } = await import("./agent-runner.server");
    const sql = await getSql();
    const now = Date.now();

    if (data.action === "delete") {
      await sql`DELETE FROM cletus_work_queue WHERE id = ${data.id}`;
      await sql`
        INSERT INTO cletus_logs (id, at, level, source, message)
        VALUES (${nid("log")}, ${now}, 'info', 'queue', ${`removed work item ${data.id}`})
      `;
      return { snapshot: await readSnapshotFromDb(sql) };
    }

    if (data.action === "retry") {
      await sql`
        UPDATE cletus_work_queue
        SET status = 'pending', error = ${null}, updated_at = ${now}
        WHERE id = ${data.id}
      `;
      await sql`
        INSERT INTO cletus_logs (id, at, level, source, message)
        VALUES (${nid("log")}, ${now}, 'info', 'queue', ${`operator retried work item ${data.id}`})
      `;
    } else if (data.action === "fail") {
      await sql`
        UPDATE cletus_work_queue
        SET status = 'failed', error = 'Marked failed by operator', updated_at = ${now}
        WHERE id = ${data.id}
      `;
      await sql`
        INSERT INTO cletus_logs (id, at, level, source, message)
        VALUES (${nid("log")}, ${now}, 'warn', 'queue', ${`operator marked work item ${data.id} failed`})
      `;
    } else if (data.action === "reprioritize" && typeof data.newPriority === "number") {
      await sql`
        UPDATE cletus_work_queue
        SET priority = ${data.newPriority}, updated_at = ${now}
        WHERE id = ${data.id}
      `;
      await sql`
        INSERT INTO cletus_logs (id, at, level, source, message)
        VALUES (${nid("log")}, ${now}, 'info', 'queue', ${`reprioritized work item ${data.id} → ${data.newPriority}`})
      `;
    } else if (data.action === "execute") {
      try {
        const res = await runCletusAgentTurn(sql, { targetWorkItemId: data.id });
        return {
          snapshot: res.snapshot,
          replyText: res.replyText,
          actorName: res.actorName,
          handoffTo: res.handoffTo,
          cyclesExecuted: 1,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await sql`
          INSERT INTO cletus_logs (id, at, level, source, message)
          VALUES (${nid("log")}, ${Date.now()}, 'error', 'inference', ${msg})
        `;
        return { snapshot: await readSnapshotFromDb(sql), turnError: msg };
      }
    }

    return { snapshot: await readSnapshotFromDb(sql) };
  });

const addTaskSchema = z.object({
  goalId: z.string().min(1),
  title: z.string().trim().min(1).max(160),
  detail: z.string().max(600).optional(),
  priority: z.enum(["low", "medium", "high"]).default("medium"),
  assignee: z.string().trim().min(1).max(64),
  role: z.string().trim().min(1).max(64),
  dependsOn: z.array(z.string()).default([]),
});

export const addTaskServer = createServerFn({ method: "POST" })
  .validator((input: unknown) => addTaskSchema.parse(input))
  .handler(async ({ data }): Promise<{ ok: boolean; error?: string; snapshot: CletusSnapshot }> => {
    const { getSql } = await import("@/lib/db");
    const { readSnapshotFromDb } = await import("./seed.server");
    const { wouldCreateTaskCycle } = await import("./mas-engine");
    const { reconcileAndPersistLifecycle } = await import("./heartbeat.server");
    const sql = await getSql();
    const now = Date.now();
    const id = nid("tsk");

    const snap = await readSnapshotFromDb(sql);
    const cleanDeps = data.dependsOn.filter((d) => snap.tasks.some((t) => t.id === d));
    if (wouldCreateTaskCycle(snap.tasks, id, cleanDeps)) {
      return {
        ok: false,
        error: `Rejected task '${data.title}': circular dependency in [${cleanDeps.join(", ")}].`,
        snapshot: snap,
      };
    }

    const parentGoal = snap.goals.find((g) => g.id === data.goalId);
    const missionId = parentGoal?.missionId ?? snap.vitals.activeMissionId ?? null;
    const initialStatus = cleanDeps.length === 0 ? "assigned" : "pending";
    const nextSortOrder =
      snap.tasks.reduce((max, t) => Math.max(max, typeof t.sortOrder === "number" ? t.sortOrder : -1), -1) + 1;

    const { recordTaskEvent } = await import("./task-history.server");
    await sql`
      INSERT INTO cletus_tasks (
        id, goal_id, mission_id, title, detail, status, priority, sort_order, assignee, role, depends_on, result, created_at, updated_at
      ) VALUES (
        ${id}, ${data.goalId}, ${missionId}, ${data.title}, ${data.detail ?? null}, ${initialStatus},
        ${data.priority}, ${nextSortOrder}, ${data.assignee}, ${data.role}, ${JSON.stringify(cleanDeps)}, ${null}, ${now}, ${now}
      )
    `;
    await recordTaskEvent(sql, {
      taskId: id,
      missionId,
      goalId: data.goalId,
      status: initialStatus,
      actor: "Operator",
      note: `${data.title} (${data.priority})`,
      at: now,
    });
    await sql`
      INSERT INTO cletus_logs (id, at, level, source, message)
      VALUES (${nid("log")}, ${now}, 'info', 'orchestrator', ${`added task ${id} (${initialStatus}, ${data.priority}) → ${data.assignee}`})
    `;
    await reconcileAndPersistLifecycle(sql, now);
    return { ok: true, snapshot: await readSnapshotFromDb(sql) };
  });

const updateTaskSchema = z.object({
  id: z.string().min(1),
  status: z.enum(["pending", "assigned", "running", "completed", "failed"]).optional(),
  priority: z.enum(["low", "medium", "high"]).optional(),
  assignee: z.string().trim().min(1).max(64).optional(),
  result: z.string().max(600).optional(),
});

export const updateTaskServer = createServerFn({ method: "POST" })
  .validator((input: unknown) => updateTaskSchema.parse(input))
  .handler(async ({ data }): Promise<{ ok: boolean; error?: string; snapshot: CletusSnapshot }> => {
    const { getSql } = await import("@/lib/db");
    const { readSnapshotFromDb } = await import("./seed.server");
    const { canTransitionTaskStatus } = await import("./mas-engine");
    const { reconcileAndPersistLifecycle } = await import("./heartbeat.server");
    const sql = await getSql();
    const now = Date.now();

    const snap = await readSnapshotFromDb(sql);
    if (data.status) {
      const check = canTransitionTaskStatus(snap.tasks, data.id, data.status);
      if (!check.ok) {
        await sql`
          INSERT INTO cletus_logs (id, at, level, source, message)
          VALUES (${nid("log")}, ${now}, 'warn', 'dag', ${check.error})
        `;
        return { ok: false, error: check.error, snapshot: await readSnapshotFromDb(sql) };
      }
    }

    const prevTask = snap.tasks.find((t) => t.id === data.id);
    await sql`
      UPDATE cletus_tasks
      SET status = COALESCE(${data.status ?? null}, status),
          priority = COALESCE(${data.priority ?? null}, priority),
          assignee = COALESCE(${data.assignee ?? null}, assignee),
          result = COALESCE(${data.result ?? null}, result),
          updated_at = ${now}
      WHERE id = ${data.id}
    `;
    if (data.status && prevTask && prevTask.status !== data.status) {
      const { recordTaskEvent } = await import("./task-history.server");
      await recordTaskEvent(sql, {
        taskId: data.id,
        missionId: prevTask.missionId ?? null,
        goalId: prevTask.goalId,
        previousStatus: prevTask.status,
        status: data.status,
        actor: "Operator",
        note: data.result ?? prevTask.title,
        at: now,
      });
    }
    const updates = [
      data.status ? `status=${data.status}` : null,
      data.priority ? `priority=${data.priority}` : null,
      data.assignee ? `assignee=${data.assignee}` : null,
    ]
      .filter(Boolean)
      .join(", ");
    await sql`
      INSERT INTO cletus_logs (id, at, level, source, message)
      VALUES (${nid("log")}, ${now}, 'info', 'orchestrator', ${`task ${data.id} → ${updates || "updated"}`})
    `;
    await reconcileAndPersistLifecycle(sql, now);
    return { ok: true, snapshot: await readSnapshotFromDb(sql) };
  });

const reorderTasksSchema = z.object({
  orderedIds: z.array(z.string().min(1)).min(1).max(200),
});

export const reorderTasksServer = createServerFn({ method: "POST" })
  .validator((input: unknown) => reorderTasksSchema.parse(input))
  .handler(async ({ data }): Promise<{ ok: boolean; error?: string; snapshot: CletusSnapshot }> => {
    const { getSql } = await import("@/lib/db");
    const { readSnapshotFromDb } = await import("./seed.server");
    const sql = await getSql();
    const now = Date.now();

    const rows = await sql<{ id: string }>`
      SELECT id FROM cletus_tasks ORDER BY sort_order ASC, created_at ASC
    `;
    const existingSet = new Set(rows.map((r) => r.id));
    const seen = new Set<string>();
    const finalOrder: string[] = [];

    for (const id of data.orderedIds) {
      if (existingSet.has(id) && !seen.has(id)) {
        seen.add(id);
        finalOrder.push(id);
      }
    }
    for (const r of rows) {
      if (!seen.has(r.id)) {
        seen.add(r.id);
        finalOrder.push(r.id);
      }
    }

    for (let idx = 0; idx < finalOrder.length; idx++) {
      const taskId = finalOrder[idx]!;
      await sql`
        UPDATE cletus_tasks
        SET sort_order = ${idx}, updated_at = ${now}
        WHERE id = ${taskId}
      `;
    }

    await sql`
      INSERT INTO cletus_logs (id, at, level, source, message)
      VALUES (${nid("log")}, ${now}, 'info', 'orchestrator', ${`reordered ${finalOrder.length} tasks in Task DAG`})
    `;

    return { ok: true, snapshot: await readSnapshotFromDb(sql) };
  });

const heartbeatSweepSchema = z.object({
  forceAll: z.boolean().optional(),
});

export const runHeartbeatSweepServer = createServerFn({ method: "POST" })
  .validator((input: unknown) => heartbeatSweepSchema.parse(input ?? {}))
  .handler(
    async ({
      data,
    }): Promise<{
      ok: boolean;
      executed: string[];
      repairedTotal: number;
      snapshot: CletusSnapshot;
    }> => {
      const { getSql } = await import("@/lib/db");
      const { runHeartbeatSweep } = await import("./heartbeat.server");
      const sql = await getSql();
      const res = await runHeartbeatSweep(sql, {
        forceAll: data.forceAll ?? true,
        minCooldownMs: 0,
      });
      return {
        ok: true,
        executed: res.executed,
        repairedTotal: res.repairedTotal,
        snapshot: res.snapshot,
      };
    },
  );

const missionControlSchema = z.object({
  missionId: z.string().min(1),
  action: z.enum(["complete", "halt", "resume"]),
  extraCycles: z.number().int().min(1).max(20).optional(),
});

export const controlMissionServer = createServerFn({ method: "POST" })
  .validator((input: unknown) => missionControlSchema.parse(input))
  .handler(async ({ data }): Promise<{ ok: boolean; error?: string; snapshot: CletusSnapshot }> => {
    const { getSql } = await import("@/lib/db");
    const { readSnapshotFromDb } = await import("./seed.server");
    const { reconcileAndPersistLifecycle } = await import("./heartbeat.server");
    const sql = await getSql();
    const now = Date.now();

    const rows = await sql<{ id: string; cycle_count: number; max_cycles: number }>`
      SELECT id, cycle_count, max_cycles FROM cletus_missions WHERE id = ${data.missionId} LIMIT 1
    `;
    if (!rows[0]) {
      return { ok: false, error: `Mission '${data.missionId}' not found.`, snapshot: await readSnapshotFromDb(sql) };
    }

    if (data.action === "complete") {
      const { recordTaskEvent } = await import("./task-history.server");
      const openTasks = await sql<{ id: string; mission_id: string | null; goal_id: string; status: string; title: string }>`
        SELECT id, mission_id, goal_id, status, title FROM cletus_tasks
        WHERE mission_id = ${data.missionId} AND status NOT IN ('completed', 'failed')
      `;
      await sql`
        UPDATE cletus_missions SET status = 'completed', updated_at = ${now} WHERE id = ${data.missionId}
      `;
      await sql`
        UPDATE cletus_tasks
        SET status = 'completed',
            result = COALESCE(result, 'Closed on mission completion'),
            updated_at = ${now}
        WHERE mission_id = ${data.missionId} AND status NOT IN ('completed', 'failed')
      `;
      for (const ot of openTasks) {
        await recordTaskEvent(sql, {
          taskId: ot.id,
          missionId: ot.mission_id,
          goalId: ot.goal_id,
          previousStatus: ot.status as TaskStatus,
          status: "completed",
          actor: "Operator",
          note: `Closed on mission ${data.missionId} completion`,
          at: now,
        });
      }
      await sql`
        UPDATE cletus_work_queue
        SET status = 'completed',
            result = COALESCE(result, '{"success":true,"closedOnMissionCompletion":true}'),
            updated_at = ${now}
        WHERE mission_id = ${data.missionId}
          AND status IN ('pending', 'claimed')
          AND priority < 100
      `;
      await sql`
        UPDATE cletus_agent_messages
        SET status = 'processed'
        WHERE mission_id = ${data.missionId} AND status = 'pending'
      `;
    } else if (data.action === "halt") {
      await sql`
        UPDATE cletus_missions SET status = 'halted', updated_at = ${now} WHERE id = ${data.missionId}
      `;
      await sql`UPDATE cletus_vitals SET auto_loop = FALSE WHERE id = 1`;
    } else if (data.action === "resume") {
      const bump = data.extraCycles ?? 6;
      const nextMax =
        rows[0].cycle_count >= rows[0].max_cycles
          ? rows[0].cycle_count + bump
          : rows[0].max_cycles;
      await sql`
        UPDATE cletus_missions
        SET status = 'active', max_cycles = ${nextMax}, updated_at = ${now}
        WHERE id = ${data.missionId}
      `;
      await sql`
        UPDATE cletus_vitals SET active_mission_id = ${data.missionId}, paused = FALSE, state = 'running' WHERE id = 1
      `;
    }

    await sql`
      INSERT INTO cletus_logs (id, at, level, source, message)
      VALUES (${nid("log")}, ${now}, 'info', 'mission', ${`operator action ${data.action} on mission ${data.missionId}`})
    `;
    await reconcileAndPersistLifecycle(sql, now);
    return { ok: true, snapshot: await readSnapshotFromDb(sql) };
  });

export const toggleSleepServer = createServerFn({ method: "POST" }).handler(
  async (): Promise<CletusSnapshot> => {
    const { getSql } = await import("@/lib/db");
    const { readSnapshotFromDb } = await import("./seed.server");
    const sql = await getSql();
    const now = Date.now();
    const rows = await sql<{ state: string }>`SELECT state FROM cletus_vitals WHERE id = 1`;
    const current = rows[0]?.state ?? "running";

    if (current === "sleeping") {
      await sql`UPDATE cletus_vitals SET state = 'running', sleep_until = ${null} WHERE id = 1`;
      await sql`
        INSERT INTO cletus_logs (id, at, level, source, message)
        VALUES (${nid("log")}, ${now}, 'info', 'loop', 'wake issued · sleep_until cleared')
      `;
    } else {
      const until = now + 30 * 60_000;
      await sql`UPDATE cletus_vitals SET state = 'sleeping', sleep_until = ${until}, auto_loop = FALSE WHERE id = 1`;
      await sql`
        INSERT INTO cletus_logs (id, at, level, source, message)
        VALUES (${nid("log")}, ${now}, 'info', 'loop', 'sleep 30m · heartbeats continue, inference paused')
      `;
    }
    return readSnapshotFromDb(sql);
  },
);

export const togglePausedServer = createServerFn({ method: "POST" }).handler(
  async (): Promise<CletusSnapshot> => {
    const { getSql } = await import("@/lib/db");
    const { readSnapshotFromDb } = await import("./seed.server");
    const sql = await getSql();
    const now = Date.now();
    await sql`UPDATE cletus_vitals SET paused = NOT paused, auto_loop = FALSE WHERE id = 1`;
    const rows = await sql<{ paused: boolean }>`SELECT paused FROM cletus_vitals WHERE id = 1 LIMIT 1`;
    const isPaused = Boolean(rows[0]?.paused);
    await sql`
      INSERT INTO cletus_logs (id, at, level, source, message)
      VALUES (${nid("log")}, ${now}, 'info', 'loop', ${isPaused ? "operator paused runtime polling & auto-loop" : "operator resumed runtime polling"})
    `;
    return readSnapshotFromDb(sql);
  },
);

export const toggleSkillServer = createServerFn({ method: "POST" })
  .validator((input: unknown) => z.object({ name: z.string().min(1) }).parse(input))
  .handler(async ({ data }): Promise<CletusSnapshot> => {
    const { getSql } = await import("@/lib/db");
    const { readSnapshotFromDb } = await import("./seed.server");
    const sql = await getSql();
    const now = Date.now();
    await sql`UPDATE cletus_skills SET enabled = NOT enabled WHERE name = ${data.name}`;
    await sql`
      INSERT INTO cletus_logs (id, at, level, source, message)
      VALUES (${nid("log")}, ${now}, 'info', 'skills', ${`toggled skill ${data.name}`})
    `;
    return readSnapshotFromDb(sql);
  });

export const pingWorkerServer = createServerFn({ method: "POST" })
  .validator((input: unknown) => z.object({ workerId: z.string().min(1) }).parse(input))
  .handler(async ({ data }): Promise<CletusSnapshot> => {
    const { getSql } = await import("@/lib/db");
    const { readSnapshotFromDb } = await import("./seed.server");
    const sql = await getSql();
    const started = performance.now();

    const rows = await sql<{ name: string; status: string; capabilities: string }>`
      SELECT name, status, capabilities FROM cletus_workers WHERE id = ${data.workerId}
    `;
    const toolCountRows = await sql<{ cnt: number }>`
      SELECT COUNT(*)::int AS cnt FROM cletus_tools WHERE enabled = TRUE
    `;

    const measuredMs = Math.max(1, Math.round(performance.now() - started));
    const now = Date.now();
    const worker = rows[0];
    if (worker) {
      const nextStatus = worker.status === "starting" ? "healthy" : worker.status;
      await sql`
        UPDATE cletus_workers
        SET status = ${nextStatus},
            last_beat_at = ${now},
            latency_ms = ${measuredMs},
            error_note = ${null},
            autonomy_level = CASE WHEN status = 'starting' THEN 'autonomous' ELSE autonomy_level END,
            task = CASE WHEN status = 'starting' THEN 'wallet_verified · ready for mesh routing' ELSE task END
        WHERE id = ${data.workerId}
      `;
      await sql`
        INSERT INTO cletus_logs (id, at, level, source, message)
        VALUES (
          ${nid("log")},
          ${now},
          'info',
          'mesh',
          ${`verified ${worker.name} · DB+registry roundtrip ${measuredMs}ms · ${toolCountRows[0]?.cnt ?? 0} active tools · status ${nextStatus}`}
        )
      `;
    }
    return readSnapshotFromDb(sql);
  });

export const getNvidiaChatHistoryServer = createServerFn({ method: "GET" })
  .validator((input: unknown) =>
    z
      .object({
        threadId: z.string().trim().min(1).max(64).optional(),
      })
      .parse(input ?? {}),
  )
  .handler(async ({ data }): Promise<{ messages: NvidiaChatMessage[] }> => {
    const { getSql } = await import("@/lib/db");
    const { getChatMessages } = await import("./nvidia-inference.server");
    const sql = await getSql();
    return { messages: await getChatMessages(sql, data.threadId ?? "default") };
  });

export const clearNvidiaChatServer = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
    z
      .object({
        threadId: z.string().trim().min(1).max(64).optional(),
      })
      .parse(input ?? {}),
  )
  .handler(async ({ data }): Promise<{ messages: NvidiaChatMessage[]; snapshot: CletusSnapshot }> => {
    const { getSql } = await import("@/lib/db");
    const { readSnapshotFromDb } = await import("./seed.server");
    const { clearChatMessages, getChatMessages } = await import("./nvidia-inference.server");
    const sql = await getSql();
    await clearChatMessages(sql, data.threadId ?? "default");
    return {
      messages: await getChatMessages(sql, data.threadId ?? "default"),
      snapshot: await readSnapshotFromDb(sql),
    };
  });

const sendNvidiaChatSchema = z.object({
  threadId: z.string().trim().min(1).max(64).optional(),
  message: z.string().trim().min(1).max(4000),
  model: z.enum([
    "nvidia/llama-3.3-nemotron-super-49b-v1",
    "meta/llama-3.3-70b-instruct",
    "deepseek-ai/deepseek-r1",
    "nvidia/llama-3.1-nemotron-nano-8b-v1",
  ]),
  systemRole: z.string().trim().min(1).max(64).default("cletus_mas"),
  customSystemInstruction: z.string().max(2000).optional(),
  groundingMode: z.enum(["none", "search", "maps"]).default("none"),
  includeMissionContext: z.boolean().optional(),
  latLng: z
    .object({
      latitude: z.number().min(-90).max(90),
      longitude: z.number().min(-180).max(180),
    })
    .optional(),
});

export const sendNvidiaChatServer = createServerFn({ method: "POST" })
  .validator((input: unknown) => sendNvidiaChatSchema.parse(input))
  .handler(
    async ({
      data,
    }): Promise<{
      ok: boolean;
      messages: NvidiaChatMessage[];
      reply?: NvidiaChatMessage;
      modelUsed: string;
      error?: string;
      snapshot: CletusSnapshot;
    }> => {
      const { getSql } = await import("@/lib/db");
      const { readSnapshotFromDb } = await import("./seed.server");
      const { sendNvidiaChatTurn } = await import("./nvidia-inference.server");
      const sql = await getSql();
      const res = await sendNvidiaChatTurn(sql, data);
      return {
        ...res,
        snapshot: await readSnapshotFromDb(sql),
      };
    },
  );

const groundingQuerySchema = z.object({
  mode: z.enum(["search", "maps"]),
  query: z.string().trim().min(2).max(1000),
  latLng: z
    .object({
      latitude: z.number().min(-90).max(90),
      longitude: z.number().min(-180).max(180),
    })
    .optional(),
});

export const runGroundingQueryServer = createServerFn({ method: "POST" })
  .validator((input: unknown) => groundingQuerySchema.parse(input))
  .handler(
    async ({
      data,
    }): Promise<{
      ok: boolean;
      mode: "search" | "maps";
      query: string;
      modelUsed: string;
      summary: string;
      webSources: WebGroundingSource[];
      mapsPlaces: GeoGroundingPlace[];
      error?: string;
      snapshot: CletusSnapshot;
    }> => {
      const { getSql } = await import("@/lib/db");
      const { readSnapshotFromDb } = await import("./seed.server");
      const { runStandaloneGrounding } = await import("./nvidia-inference.server");
      const sql = await getSql();
      const res = await runStandaloneGrounding(sql, data);
      return {
        ...res,
        snapshot: await readSnapshotFromDb(sql),
      };
    },
  );

const transcribeAudioSchema = z.object({
  audioBase64: z.string().min(4),
  mimeType: z.string().trim().min(3).max(120).default("audio/webm"),
  prompt: z.string().max(400).optional(),
});

export const transcribeAudioServer = createServerFn({ method: "POST" })
  .validator((input: unknown) => transcribeAudioSchema.parse(input))
  .handler(
    async ({
      data,
    }): Promise<{
      ok: boolean;
      modelUsed: string;
      text: string;
      error?: string;
      snapshot: CletusSnapshot;
    }> => {
      const { getSql } = await import("@/lib/db");
      const { readSnapshotFromDb } = await import("./seed.server");
      const { transcribeAudioWithNvidia } = await import("./nvidia-inference.server");
      const sql = await getSql();
      const res = await transcribeAudioWithNvidia(sql, data);
      return {
        ...res,
        snapshot: await readSnapshotFromDb(sql),
      };
    },
  );

export const getVideoHistoryServer = createServerFn({ method: "GET" }).handler(
  async (): Promise<{ jobs: NvidiaVideoJob[] }> => {
    const { getSql } = await import("@/lib/db");
    const { listVideoGenerations } = await import("./nvidia-inference.server");
    const sql = await getSql();
    return { jobs: await listVideoGenerations(sql) };
  },
);

const generateVideoSchema = z.object({
  prompt: z.string().trim().min(3).max(1500),
  aspectRatio: z.enum(["16:9", "9:16"]).default("16:9"),
  duration: z.enum(["5s", "8s", "10s"]).default("8s"),
});

export const generateVideoServer = createServerFn({ method: "POST" })
  .validator((input: unknown) => generateVideoSchema.parse(input))
  .handler(
    async ({
      data,
    }): Promise<{
      ok: boolean;
      job: NvidiaVideoJob;
      jobs: NvidiaVideoJob[];
      error?: string;
      snapshot: CletusSnapshot;
    }> => {
      const { getSql } = await import("@/lib/db");
      const { readSnapshotFromDb } = await import("./seed.server");
      const { generateVideoWithNvidia } = await import("./nvidia-inference.server");
      const sql = await getSql();
      const res = await generateVideoWithNvidia(sql, data);
      return {
        ...res,
        snapshot: await readSnapshotFromDb(sql),
      };
    },
  );

const domainIdEnum = z.enum([
  "mas_rnd",
  "biomed_clinical",
  "climate_geospatial",
  "finance_secops",
  "policy_supply",
]);

const activateDomainSchema = z.object({
  domainId: domainIdEnum,
  customFocus: z.string().max(300).optional(),
});

export const activateDomainPackServer = createServerFn({ method: "POST" })
  .validator((input: unknown) => activateDomainSchema.parse(input))
  .handler(
    async ({
      data,
    }): Promise<{
      domainId: DomainId;
      missionId: string;
      snapshot: CletusSnapshot;
    }> => {
      const { getSql } = await import("@/lib/db");
      const { activateDomainPack } = await import("./domains.server");
      const sql = await getSql();
      const res = await activateDomainPack(sql, data);
      return {
        domainId: res.pack.id,
        missionId: res.missionId,
        snapshot: res.snapshot,
      };
    },
  );

const runDomainConnectorSchema = z.object({
  domainId: domainIdEnum,
  toolName: z.string().trim().min(1).max(64),
  argsJson: z.string().default("{}"),
  label: z.string().max(160).optional(),
  saveToMemory: z.boolean().optional(),
});

export const runDomainConnectorServer = createServerFn({ method: "POST" })
  .validator((input: unknown) => runDomainConnectorSchema.parse(input))
  .handler(
    async ({
      data,
    }): Promise<{
      ok: boolean;
      toolName: string;
      summary: string;
      output: JsonObject;
      durationMs: number;
      memoryItem?: DomainMemoryItem;
      error?: string;
      snapshot: CletusSnapshot;
    }> => {
      let args: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(data.argsJson || "{}");
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          args = parsed as Record<string, unknown>;
        }
      } catch {
        throw new Error("Connector arguments must be valid JSON.");
      }
      const { getSql } = await import("@/lib/db");
      const { readSnapshotFromDb } = await import("./seed.server");
      const { runDomainConnectorAndStore } = await import("./domains.server");
      const sql = await getSql();
      const res = await runDomainConnectorAndStore(sql, {
        domainId: data.domainId,
        toolName: data.toolName,
        args,
        label: data.label,
        saveToMemory: data.saveToMemory,
      });
      return {
        ...res,
        snapshot: await readSnapshotFromDb(sql),
      };
    },
  );

const analyzeUrlContextSchema = z.object({
  domainId: domainIdEnum,
  urls: z.array(z.string().trim().min(8)).min(1).max(10),
  prompt: z.string().trim().min(3).max(1500),
  title: z.string().max(160).optional(),
});

export const analyzeUrlContextServer = createServerFn({ method: "POST" })
  .validator((input: unknown) => analyzeUrlContextSchema.parse(input))
  .handler(
    async ({
      data,
    }): Promise<{
      ok: boolean;
      urls: string[];
      modelUsed: string;
      analysis: string;
      urlMetadata: Array<{ retrievedUrl: string; status: string }>;
      memoryItem?: DomainMemoryItem;
      error?: string;
      snapshot: CletusSnapshot;
    }> => {
      const { getSql } = await import("@/lib/db");
      const { readSnapshotFromDb } = await import("./seed.server");
      const { analyzeUrlContextAndStore } = await import("./domains.server");
      const sql = await getSql();
      const res = await analyzeUrlContextAndStore(sql, data);
      return {
        ...res,
        snapshot: await readSnapshotFromDb(sql),
      };
    },
  );

const searchMemoriesSchema = z.object({
  domainId: z.union([domainIdEnum, z.literal("all")]).optional(),
  query: z.string().max(400).default(""),
});

export const searchDomainMemoriesServer = createServerFn({ method: "POST" })
  .validator((input: unknown) => searchMemoriesSchema.parse(input))
  .handler(
    async ({
      data,
    }): Promise<{
      ok: boolean;
      mode: "semantic" | "lexical";
      results: RankedMemoryResult[];
    }> => {
      const { getSql } = await import("@/lib/db");
      const { searchDomainMemories } = await import("./domains.server");
      const sql = await getSql();
      return searchDomainMemories(sql, data);
    },
  );

const generateAudioBriefingSchema = z.object({
  domainId: domainIdEnum,
  voiceName: z.string().max(32).optional(),
  customFocus: z.string().max(300).optional(),
});

export const generateAudioBriefingServer = createServerFn({ method: "POST" })
  .validator((input: unknown) => generateAudioBriefingSchema.parse(input))
  .handler(
    async ({
      data,
    }): Promise<{
      ok: boolean;
      briefing?: AudioBriefing;
      error?: string;
      snapshot: CletusSnapshot;
    }> => {
      const { getSql } = await import("@/lib/db");
      const { readSnapshotFromDb } = await import("./seed.server");
      const { generateExecutiveAudioBriefing } = await import("./domains.server");
      const sql = await getSql();
      const res = await generateExecutiveAudioBriefing(sql, data);
      return {
        ...res,
        snapshot: await readSnapshotFromDb(sql),
      };
    },
  );

const trajectorySlugEnum = z.enum([
  "research_frontier",
  "capability_forging",
  "mesh_calibration",
  "memory_consolidation",
  "resilience_audit",
]);

const runEvolutionStepSchema = z.object({
  trajectorySlug: trajectorySlugEnum.optional(),
  steps: z.number().int().min(1).max(3).optional(),
});

export const runEvolutionStepServer = createServerFn({ method: "POST" })
  .validator((input: unknown) => runEvolutionStepSchema.parse(input ?? {}))
  .handler(async ({ data }): Promise<TurnActionResult> => {
    const { getSql } = await import("@/lib/db");
    const { readSnapshotFromDb } = await import("./seed.server");
    const { runCletusAgentTurn } = await import("./agent-runner.server");
    const sql = await getSql();
    const steps = data.steps ?? 1;
    let lastSnap: CletusSnapshot | undefined;
    let lastReply = "";
    let lastActor = "";
    let lastHandoff: string | undefined;
    let completedSteps = 0;

    try {
      for (let i = 0; i < steps; i++) {
        const res = await runCletusAgentTurn(sql, {
          forceEvolution: true,
          preferredTrajectorySlug: i === 0 ? (data.trajectorySlug as EvolutionTrajectorySlug | undefined) : undefined,
        });
        lastSnap = res.snapshot;
        lastReply = res.replyText;
        lastActor = res.actorName;
        lastHandoff = res.handoffTo;
        completedSteps += 1;

        if (lastSnap.vitals.tier === "dead" || lastSnap.vitals.tier === "critical") {
          break;
        }
      }
      return {
        snapshot: lastSnap ?? (await readSnapshotFromDb(sql)),
        replyText: lastReply,
        actorName: lastActor,
        handoffTo: lastHandoff,
        cyclesExecuted: completedSteps,
        mode: "self_evolution",
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await sql`
        INSERT INTO cletus_logs (id, at, level, source, message)
        VALUES (${nid("log")}, ${Date.now()}, 'error', 'evolution', ${msg})
      `;
      return {
        snapshot: await readSnapshotFromDb(sql),
        turnError: msg,
        cyclesExecuted: completedSteps,
      };
    }
  });

const spawnEvolutionMissionSchema = z.object({
  trajectorySlug: trajectorySlugEnum,
});

export const spawnEvolutionMissionServer = createServerFn({ method: "POST" })
  .validator((input: unknown) => spawnEvolutionMissionSchema.parse(input))
  .handler(
    async ({
      data,
    }): Promise<{
      ok: boolean;
      missionId: string;
      snapshot: CletusSnapshot;
    }> => {
      const { getSql } = await import("@/lib/db");
      const { readSnapshotFromDb } = await import("./seed.server");
      const { buildEvolutionGrowthMission, createDefaultEvolutionTrajectories } = await import("./evolution");
      const { reconcileAndPersistLifecycle } = await import("./heartbeat.server");
      const sql = await getSql();
      const now = Date.now();
      const snap = await readSnapshotFromDb(sql);

      const trajectory =
        snap.evolutionTrajectories.find((t) => t.slug === data.trajectorySlug) ??
        createDefaultEvolutionTrajectories(now).find((t) => t.slug === data.trajectorySlug)!;

      const growthPlan = buildEvolutionGrowthMission({
        trajectory,
        activeDomain: snap.activeDomain,
        healthyAgents: snap.children
          .filter((c) => c.status === "healthy")
          .map((c) => ({ name: c.name, role: c.role })),
        idFactory: (prefix) => nid(prefix),
      });

      const missionId = nid("msn");
      await sql`
        UPDATE cletus_missions
        SET status = 'completed', updated_at = ${now}
        WHERE status IN ('active', 'planning')
      `;

      await sql`
        INSERT INTO cletus_missions (
          id, title, objective, status, orchestrator, plan_summary,
          success_criteria, cycle_count, max_cycles, created_at, updated_at
        ) VALUES (
          ${missionId}, ${growthPlan.title}, ${growthPlan.objective}, 'active',
          'Orchestrator-Prime', ${growthPlan.planSummary},
          'Trajectory benchmark verified and evolution milestone recorded.',
          0, 12, ${now}, ${now}
        )
      `;

      for (let i = 0; i < growthPlan.goals.length; i++) {
        const g = growthPlan.goals[i]!;
        await sql`
          INSERT INTO cletus_goals (
            id, mission_id, title, detail, status, progress, expected_revenue_cents, actual_revenue_cents, sort_order
          ) VALUES (${g.id}, ${missionId}, ${g.title}, ${g.detail}, 'active', 0, 0, 0, ${i + 1})
        `;
      }

      const { recordTaskEvent } = await import("./task-history.server");
      for (let i = 0; i < growthPlan.tasks.length; i++) {
        const t = growthPlan.tasks[i]!;
        await sql`
          INSERT INTO cletus_tasks (
            id, goal_id, mission_id, title, detail, status, assignee, role, depends_on, result, created_at, updated_at
          ) VALUES (
            ${t.id}, ${t.goalId}, ${missionId}, ${t.title}, ${t.detail || null}, ${t.status},
            ${t.assignee}, ${t.role}, ${JSON.stringify(t.dependsOn)}, ${null}, ${now + i}, ${now + i}
          )
        `;
        await recordTaskEvent(sql, {
          taskId: t.id,
          missionId,
          goalId: t.goalId,
          status: t.status,
          actor: "Evolution-Planner",
          note: `${trajectory.slug}: ${t.title}`,
          at: now + i,
        });
      }

      const rootTask = growthPlan.tasks[0];
      if (rootTask) {
        await sql`
          INSERT INTO cletus_agent_messages (
            id, mission_id, task_id, from_agent, to_agent, message_type, subject, payload, status, created_at
          ) VALUES (
            ${nid("msg")}, ${missionId}, ${rootTask.id}, 'Orchestrator-Prime', ${rootTask.assignee},
            'handoff', ${`Growth Mission root task: ${rootTask.title}`},
            ${JSON.stringify({ trajectorySlug: trajectory.slug, taskId: rootTask.id })},
            'pending', ${now}
          )
        `;
      }

      await sql`
        UPDATE cletus_vitals
        SET active_mission_id = ${missionId}, state = 'running', sleep_until = ${null}, paused = FALSE
        WHERE id = 1
      `;

      await sql`
        INSERT INTO cletus_logs (id, at, level, source, message)
        VALUES (
          ${nid("log")}, ${now}, 'info', 'evolution',
          ${`spawned growth mission ${missionId} from trajectory '${trajectory.slug}' (${growthPlan.tasks.length} DAG tasks)`}
        )
      `;

      await reconcileAndPersistLifecycle(sql, now);
      return {
        ok: true,
        missionId,
        snapshot: await readSnapshotFromDb(sql),
      };
    },
  );

export const toggleEvolutionTrajectoryServer = createServerFn({ method: "POST" })
  .validator((input: unknown) => z.object({ slug: trajectorySlugEnum }).parse(input))
  .handler(async ({ data }): Promise<CletusSnapshot> => {
    const { getSql } = await import("@/lib/db");
    const { readSnapshotFromDb } = await import("./seed.server");
    const sql = await getSql();
    const now = Date.now();
    await sql`
      UPDATE cletus_evolution_trajectories
      SET status = CASE WHEN status = 'active' THEN 'paused' ELSE 'active' END,
          updated_at = ${now}
      WHERE slug = ${data.slug}
    `;
    await sql`
      INSERT INTO cletus_logs (id, at, level, source, message)
      VALUES (${nid("log")}, ${now}, 'info', 'evolution', ${`toggled trajectory '${data.slug}' status`})
    `;
    return readSnapshotFromDb(sql);
  });

const speakToCletusSchema = z.object({
  text: z.string().trim().min(1).max(4000),
  voiceName: z.string().optional(),
  speakTts: z.boolean().optional(),
});

export const speakToCletusDirectServer = createServerFn({ method: "POST" })
  .validator((input: unknown) => speakToCletusSchema.parse(input))
  .handler(
    async ({
      data,
    }): Promise<{
      ok: boolean;
      reply: string;
      toolsUsed: Array<{ name: string; summary: string }>;
      audioBase64?: string;
      audioMimeType?: string;
      ttsUnavailableReason?: string;
      error?: string;
      snapshot: CletusSnapshot;
    }> => {
      const { getSql } = await import("@/lib/db");
      const { readSnapshotFromDb } = await import("./seed.server");
      const { runCletusDirectVoiceTurn } = await import("./live-bridge.server");
      const sql = await getSql();
      const res = await runCletusDirectVoiceTurn(sql, data);
      return {
        ...res,
        snapshot: await readSnapshotFromDb(sql),
      };
    },
  );


