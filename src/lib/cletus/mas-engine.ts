import type {
  AgentMessage,
  AgentMessageType,
  Child,
  Goal,
  GoalStatus,
  InboxMessage,
  Mission,
  MissionStatus,
  SurvivalTier,
  Task,
  TaskStatus,
  WorkItem,
} from "./types";

export interface TierPolicy {
  tier: SurvivalTier;
  canRunInference: boolean;
  allowContinuousAutoLoop: boolean;
  allowSpawnWorkers: boolean;
  allowToolSynthesis: boolean;
  maxRoundsPerTurn: number;
  maxChildFundingCents: number;
  directive: string;
}

export function tierFromCredits(creditsCents: number, reserveCents: number): SurvivalTier {
  if (creditsCents <= 0) return "dead";
  if (creditsCents < reserveCents) return "critical";
  if (creditsCents < reserveCents * 3) return "low_compute";
  if (creditsCents > 50_000) return "high";
  return "normal";
}

export function getTierPolicy(tier: SurvivalTier, reserveCents: number): TierPolicy {
  switch (tier) {
    case "dead":
      return {
        tier,
        canRunInference: false,
        allowContinuousAutoLoop: false,
        allowSpawnWorkers: false,
        allowToolSynthesis: false,
        maxRoundsPerTurn: 0,
        maxChildFundingCents: 0,
        directive:
          "CREDIT DEPLETION HALT: Remaining credits are 0.00 cr. All inference cycles and spend ops are suspended until credits are restored.",
      };
    case "critical":
      return {
        tier,
        canRunInference: true,
        allowContinuousAutoLoop: false,
        allowSpawnWorkers: false,
        allowToolSynthesis: false,
        maxRoundsPerTurn: 2,
        maxChildFundingCents: 0,
        directive: `CRITICAL SURVIVAL MODE (< ${(reserveCents / 100).toFixed(2)} cr reserve): Conserve compute. Halt child funding and speculative research; close only highest-priority ready deliverables or enter low-power sleep.`,
      };
    case "low_compute":
      return {
        tier,
        canRunInference: true,
        allowContinuousAutoLoop: true,
        allowSpawnWorkers: false,
        allowToolSynthesis: true,
        maxRoundsPerTurn: 3,
        maxChildFundingCents: 500,
        directive:
          "LOW-COMPUTE CONSERVATION MODE: Restrict reasoning rounds to 3, cap child allocations at 5.00 cr, and prioritize deterministic completion of dependency-ready tasks.",
      };
    case "high":
      return {
        tier,
        canRunInference: true,
        allowContinuousAutoLoop: true,
        allowSpawnWorkers: true,
        allowToolSynthesis: true,
        maxRoundsPerTurn: 5,
        maxChildFundingCents: 2500,
        directive:
          "HIGH-COMPUTE EXPANSION MODE: Full autonomous planning, dynamic specialist role spawning, and live external research/tool synthesis authorized.",
      };
    case "normal":
    default:
      return {
        tier: "normal",
        canRunInference: true,
        allowContinuousAutoLoop: true,
        allowSpawnWorkers: true,
        allowToolSynthesis: true,
        maxRoundsPerTurn: 4,
        maxChildFundingCents: 2500,
        directive:
          "NOMINAL AUTONOMOUS MODE: Balance multi-agent delegation, verified tool synthesis, and capital preservation above the reserve floor.",
      };
  }
}

/**
 * Return tasks whose upstream DAG dependencies (`dependsOn`) are all `completed`.
 */
export function getReadyTasks(tasks: Task[]): Task[] {
  const statusById = new Map(tasks.map((t) => [t.id, t.status]));
  return tasks.filter((t) => {
    if (t.status === "completed" || t.status === "failed") return false;
    return t.dependsOn.every((depId) => statusById.get(depId) === "completed");
  });
}

/**
 * Check whether transitioning `taskId` to `nextStatus` violates upstream DAG prerequisites.
 */
export function canTransitionTaskStatus(
  tasks: Task[],
  taskId: string,
  nextStatus: TaskStatus,
): { ok: true } | { ok: false; blockedBy: string[]; error: string } {
  const target = tasks.find((t) => t.id === taskId);
  if (!target) {
    return { ok: false, blockedBy: [], error: `Task '${taskId}' not found in Task DAG.` };
  }
  if (nextStatus === "completed" || nextStatus === "running") {
    const statusById = new Map(tasks.map((t) => [t.id, t.status]));
    const blockedBy = target.dependsOn.filter((depId) => {
      const st = statusById.get(depId);
      return st !== undefined && st !== "completed";
    });
    if (blockedBy.length > 0) {
      return {
        ok: false,
        blockedBy,
        error: `Cannot mark task ${taskId} as '${nextStatus}' while upstream prerequisite(s) [${blockedBy.join(", ")}] remain incomplete.`,
      };
    }
  }
  return { ok: true };
}

/**
 * Check if adding `dependsOn` to `taskId` would introduce a cycle in the Task DAG.
 */
export function wouldCreateTaskCycle(
  tasks: Task[],
  taskId: string,
  candidateDependsOn: string[],
): boolean {
  if (candidateDependsOn.includes(taskId)) return true;
  const depMap = new Map<string, string[]>();
  for (const t of tasks) {
    depMap.set(t.id, t.dependsOn);
  }
  depMap.set(taskId, candidateDependsOn);

  const visited = new Set<string>();
  const stack = [...candidateDependsOn];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (cur === taskId) return true;
    if (visited.has(cur)) continue;
    visited.add(cur);
    const nextDeps = depMap.get(cur) ?? [];
    for (const d of nextDeps) stack.push(d);
  }
  return false;
}

export interface NextActorDecision {
  agentName: string;
  agentRole: string;
  reason: string;
  mode?: "handoff" | "urgent_directive" | "mission_task" | "work_item" | "self_evolution";
  pendingMessageId?: string;
  focusTaskId?: string;
  focusWorkItemId?: string;
}

const MESSAGE_TYPE_PRIORITY: Record<AgentMessageType, number> = {
  critique: 0,
  handoff: 1,
  plan_proposal: 2,
  tool_share: 3,
  status: 4,
};

function countDownstreamDependents(tasks: Task[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const t of tasks) {
    if (t.status === "completed") continue;
    for (const dep of t.dependsOn) {
      counts.set(dep, (counts.get(dep) ?? 0) + 1);
    }
  }
  return counts;
}

function isUrgentDirectiveWork(w: WorkItem): boolean {
  return (
    (w.status === "claimed" || w.status === "pending") &&
    (w.priority >= 100 || w.source === "operator_directive" || w.source === "live_voice")
  );
}

/**
 * Deterministic multi-agent turn scheduler (DRAMA / Supervisor-Mesh pattern):
 * 1. Explicit healthy operator target.
 * 2. Unread inter-agent `critique` / `handoff` messages addressed to healthy agents (for open missions).
 * 3. Urgent operator / live-voice directives in the work queue (priority >= 100).
 * 4. Dependency-ready tasks (excluding completed/halted missions), ranked by
 *    running > assigned > pending, critical-path downstream unblock weight, and creation order.
 * 5. Remaining open work queue items (`claimed` > `pending`, highest priority first).
 * 6. Idle default -> Self-Evolution (`mode: "self_evolution"`) targeting the selected trajectory specialist.
 */
export function selectNextActor(input: {
  children: Child[];
  tasks: Task[];
  workQueue: WorkItem[];
  agentMessages: AgentMessage[];
  missions?: Mission[];
  activeMissionId?: string | null;
  preferredAgentName?: string;
  forceEvolution?: boolean;
  idleEvolutionTarget?: {
    agentName: string;
    agentRole: string;
    reason: string;
  };
}): NextActorDecision {
  const {
    children,
    tasks,
    workQueue,
    agentMessages,
    missions,
    activeMissionId,
    preferredAgentName,
    forceEvolution,
    idleEvolutionTarget,
  } = input;
  const agentByName = new Map(children.map((c) => [c.name.toLowerCase(), c]));
  const healthyWorkers = children.filter((c) => c.status === "healthy");
  const orchestrator =
    healthyWorkers.find((c) => c.role === "orchestrator") ??
    healthyWorkers[0] ??
    children[0];
  const fallbackName = orchestrator?.name ?? "Orchestrator-Prime";
  const fallbackRole = orchestrator?.role ?? "orchestrator";

  const missionStatusById = new Map((missions ?? []).map((m) => [m.id, m.status]));
  const isClosedMission = (mId?: string): boolean => {
    if (!mId) return false;
    const st = missionStatusById.get(mId);
    return st === "completed" || st === "halted" || st === "failed";
  };

  if (preferredAgentName) {
    const target = agentByName.get(preferredAgentName.toLowerCase());
    if (target && target.status === "healthy") {
      return {
        agentName: target.name,
        agentRole: target.role,
        mode: forceEvolution ? "self_evolution" : "mission_task",
        reason: forceEvolution
          ? `Self-Evolution step targeted at ${target.name}`
          : `Operator explicitly targeted ${target.name}`,
      };
    }
  }

  if (forceEvolution) {
    if (idleEvolutionTarget) {
      return {
        agentName: idleEvolutionTarget.agentName,
        agentRole: idleEvolutionTarget.agentRole,
        mode: "self_evolution",
        reason: idleEvolutionTarget.reason,
      };
    }
    return {
      agentName: fallbackName,
      agentRole: fallbackRole,
      mode: "self_evolution",
      reason: "Explicit Self-Evolution cycle triggered",
    };
  }

  // 1. Pending inter-agent messages (prefer active mission, skip already closed/halted missions)
  const pendingMsgs = agentMessages
    .filter((m) => m.status === "pending" && !isClosedMission(m.missionId))
    .slice()
    .sort((a, b) => {
      const aMissionMatch = activeMissionId && a.missionId === activeMissionId ? 0 : 1;
      const bMissionMatch = activeMissionId && b.missionId === activeMissionId ? 0 : 1;
      if (aMissionMatch !== bMissionMatch) return aMissionMatch - bMissionMatch;
      const pa = MESSAGE_TYPE_PRIORITY[a.messageType] ?? 5;
      const pb = MESSAGE_TYPE_PRIORITY[b.messageType] ?? 5;
      if (pa !== pb) return pa - pb;
      return a.createdAt - b.createdAt;
    });

  for (const msg of pendingMsgs) {
    const target = agentByName.get(msg.toAgent.toLowerCase());
    if (target && target.status === "healthy") {
      return {
        agentName: target.name,
        agentRole: target.role,
        mode: "handoff",
        reason: `Pending ${msg.messageType} from ${msg.fromAgent}: ${msg.subject}`,
        pendingMessageId: msg.id,
        focusTaskId: msg.taskId,
      };
    }
  }

  // 2. Urgent operator / live-voice directives in work queue preempt background DAG tasks
  const urgentWork = workQueue
    .filter(isUrgentDirectiveWork)
    .sort((a, b) => {
      if (a.status !== b.status) return a.status === "claimed" ? -1 : 1;
      if (b.priority !== a.priority) return b.priority - a.priority;
      return a.createdAt - b.createdAt;
    });

  if (urgentWork[0]) {
    const w = urgentWork[0];
    const requested =
      typeof w.payload.targetAgent === "string"
        ? agentByName.get(w.payload.targetAgent.toLowerCase())
        : undefined;
    const chosen = requested && requested.status === "healthy" ? requested : orchestrator;
    return {
      agentName: chosen?.name ?? fallbackName,
      agentRole: chosen?.role ?? fallbackRole,
      mode: "urgent_directive",
      reason: `Urgent ${w.source} work item ${w.id} (P:${w.priority})`,
      focusWorkItemId: w.id,
    };
  }

  // 3. Dependency-ready tasks (scope to activeMissionId if open; exclude closed/halted missions)
  const openTasks = tasks.filter((t) => !isClosedMission(t.missionId));
  const missionScopedTasks =
    activeMissionId && openTasks.some((t) => t.missionId === activeMissionId)
      ? openTasks.filter((t) => t.missionId === activeMissionId)
      : openTasks;
  const readyTasks = getReadyTasks(missionScopedTasks);
  const downstreamWeight = countDownstreamDependents(missionScopedTasks);
  const statusRank = (s: Task["status"]) =>
    s === "running" ? 0 : s === "assigned" ? 1 : s === "pending" ? 2 : 3;
  const priorityRank = (p: Task["priority"]) =>
    p === "high" ? 0 : p === "low" ? 2 : 1;

  readyTasks.sort((a, b) => {
    const sr = statusRank(a.status) - statusRank(b.status);
    if (sr !== 0) return sr;
    const dw = (downstreamWeight.get(b.id) ?? 0) - (downstreamWeight.get(a.id) ?? 0);
    if (dw !== 0) return dw;
    const pr = priorityRank(a.priority) - priorityRank(b.priority);
    if (pr !== 0) return pr;
    const soA = typeof a.sortOrder === "number" ? a.sortOrder : Number.MAX_SAFE_INTEGER;
    const soB = typeof b.sortOrder === "number" ? b.sortOrder : Number.MAX_SAFE_INTEGER;
    if (soA !== soB) return soA - soB;
    return (a.createdAt ?? 0) - (b.createdAt ?? 0);
  });

  for (const t of readyTasks) {
    const assignee = agentByName.get(t.assignee.toLowerCase());
    if (assignee && assignee.status === "healthy") {
      return {
        agentName: assignee.name,
        agentRole: assignee.role,
        mode: "mission_task",
        reason: `Dependency-ready task ${t.id} (${t.status}) assigned to ${assignee.name}`,
        focusTaskId: t.id,
      };
    }
    // If original assignee is missing/unhealthy/stopped (and not explicitly gated), route to healthy role-match
    if (!assignee || assignee.status !== "starting") {
      const roleMatch = healthyWorkers.find(
        (w) => w.role.toLowerCase() === t.role.toLowerCase(),
      );
      if (roleMatch) {
        return {
          agentName: roleMatch.name,
          agentRole: roleMatch.role,
          mode: "mission_task",
          reason: `Re-routed ready task ${t.id} from unavailable ${t.assignee} → ${roleMatch.name}`,
          focusTaskId: t.id,
        };
      }
    }
  }

  // 4. Remaining claimed/pending work queue items sorted by status & priority
  const queuedWork = workQueue
    .filter((w) => (w.status === "claimed" || w.status === "pending") && !isClosedMission(w.missionId))
    .slice()
    .sort((a, b) => {
      if (a.status !== b.status) return a.status === "claimed" ? -1 : 1;
      if (b.priority !== a.priority) return b.priority - a.priority;
      return a.createdAt - b.createdAt;
    });

  const nextWork = queuedWork[0];
  if (nextWork) {
    const requested =
      typeof nextWork.payload.targetAgent === "string"
        ? agentByName.get(nextWork.payload.targetAgent.toLowerCase())
        : undefined;
    const chosen = requested && requested.status === "healthy" ? requested : orchestrator;
    return {
      agentName: chosen?.name ?? fallbackName,
      agentRole: chosen?.role ?? fallbackRole,
      mode: "work_item",
      reason: `Work item ${nextWork.id} [${nextWork.source} P:${nextWork.priority}] queued for ${chosen?.name ?? fallbackName}`,
      focusWorkItemId: nextWork.id,
    };
  }

  // 5. No operational tasks, handoffs, or queued work active -> Always default to Self-Evolution
  if (idleEvolutionTarget) {
    return {
      agentName: idleEvolutionTarget.agentName,
      agentRole: idleEvolutionTarget.agentRole,
      mode: "self_evolution",
      reason: idleEvolutionTarget.reason,
    };
  }

  return {
    agentName: fallbackName,
    agentRole: fallbackRole,
    mode: "self_evolution",
    reason: "No active operational tasks — defaulting to Self-Evolution",
  };
}

/**
 * Compute deterministic goal completion % from attached tasks.
 */
export function computeGoalProgress(goal: Goal, tasks: Task[]): number {
  const goalTasks = tasks.filter((t) => t.goalId === goal.id);
  if (goalTasks.length === 0) return goal.progress;
  const completed = goalTasks.filter((t) => t.status === "completed").length;
  const active = goalTasks.filter((t) => t.status === "running" || t.status === "assigned").length;
  return Math.min(100, Math.round(((completed + active * 0.25) / goalTasks.length) * 100));
}

export interface NormalizedGoalInput {
  id: string;
  title: string;
  detail: string;
}

export interface NormalizedTaskInput {
  id: string;
  goalId: string;
  title: string;
  detail: string;
  status: TaskStatus;
  assignee: string;
  role: string;
  dependsOn: string[];
}

/**
 * Validate, deduplicate, cycle-strip, and normalize an LLM or operator Mission Plan.
 * Root tasks (`dependsOn.length === 0`) automatically start in `'assigned'` so they can execute immediately.
 */
export function validateAndNormalizePlan(input: {
  goalsIn: Array<Record<string, unknown>>;
  tasksIn: Array<Record<string, unknown>>;
  healthyAgents: ReadonlyArray<{ name: string; role: string }>;
  existingTasks?: Task[];
  idFactory?: (prefix: string, idx: number) => string;
}): {
  goals: NormalizedGoalInput[];
  tasks: NormalizedTaskInput[];
  strippedEdges: number;
} {
  const makeId = input.idFactory ?? ((prefix, idx) => `${prefix}_plan_${idx + 1}_${Date.now().toString(36)}`);
  const healthyMap = new Map(input.healthyAgents.map((a) => [a.name.toLowerCase(), a]));
  const orchestrator =
    input.healthyAgents.find((a) => a.role.toLowerCase() === "orchestrator") ??
    input.healthyAgents[0] ?? { name: "Orchestrator-Prime", role: "orchestrator" };

  const goalIdMap = new Map<string, string>();
  const goals: NormalizedGoalInput[] = [];
  for (let i = 0; i < input.goalsIn.length; i++) {
    const g = input.goalsIn[i]!;
    const rawId = g.id ? String(g.id) : `gol_${i + 1}`;
    const dbId = makeId("gol", i);
    goalIdMap.set(rawId, dbId);
    goals.push({
      id: dbId,
      title: String(g.title ?? "Mission Goal").slice(0, 140),
      detail: String(g.detail ?? ""),
    });
  }

  if (goals.length === 0) {
    const fallbackGoalId = makeId("gol", 0);
    goalIdMap.set("gol_1", fallbackGoalId);
    goals.push({
      id: fallbackGoalId,
      title: "Deliver Verified Mission Outcome",
      detail: "Execute multi-agent discovery, synthesis, and independent verification.",
    });
  }

  const taskIdMap = new Map<string, string>();
  for (let i = 0; i < input.tasksIn.length; i++) {
    const t = input.tasksIn[i]!;
    const rawId = t.id ? String(t.id) : `tsk_${i + 1}`;
    taskIdMap.set(rawId, makeId("tsk", i));
  }

  const validTaskIds = new Set<string>([
    ...(input.existingTasks ?? []).map((t) => t.id),
    ...taskIdMap.values(),
  ]);

  let strippedEdges = 0;
  const runningDag: Task[] = [...(input.existingTasks ?? [])];
  const tasks: NormalizedTaskInput[] = [];

  for (let i = 0; i < input.tasksIn.length; i++) {
    const t = input.tasksIn[i]!;
    const rawId = t.id ? String(t.id) : `tsk_${i + 1}`;
    const dbTaskId = taskIdMap.get(rawId)!;
    const rawGoal = String(t.goalId ?? "gol_1");
    const dbGoalId = goalIdMap.get(rawGoal) ?? goals[0]!.id;

    const rawAssignee = String(t.assignee ?? "").trim();
    const role = String(t.role ?? "specialist").trim() || "specialist";
    const matchedAgent =
      healthyMap.get(rawAssignee.toLowerCase()) ??
      input.healthyAgents.find((a) => a.role.toLowerCase() === role.toLowerCase()) ??
      orchestrator;

    const rawDeps = Array.isArray(t.dependsOn)
      ? t.dependsOn.map((d) => taskIdMap.get(String(d)) ?? String(d))
      : [];

    // Filter to known task IDs, remove duplicates, and drop any edge that creates a cycle
    const safeDeps: string[] = [];
    for (const depId of rawDeps) {
      if (!depId || depId === dbTaskId || !validTaskIds.has(depId) || safeDeps.includes(depId)) {
        if (depId) strippedEdges += 1;
        continue;
      }
      if (wouldCreateTaskCycle(runningDag, dbTaskId, [...safeDeps, depId])) {
        strippedEdges += 1;
        continue;
      }
      safeDeps.push(depId);
    }

    const status: TaskStatus = safeDeps.length === 0 ? "assigned" : "pending";
    const normalized: NormalizedTaskInput = {
      id: dbTaskId,
      goalId: dbGoalId,
      title: String(t.title ?? "Mission Task").slice(0, 140),
      detail: t.detail ? String(t.detail) : "",
      status,
      assignee: matchedAgent.name,
      role: matchedAgent.role || role,
      dependsOn: safeDeps,
    };

    runningDag.push({
      id: normalized.id,
      goalId: normalized.goalId,
      title: normalized.title,
      detail: normalized.detail,
      status: normalized.status,
      assignee: normalized.assignee,
      role: normalized.role,
      dependsOn: normalized.dependsOn,
    });
    tasks.push(normalized);
  }

  return { goals, tasks, strippedEdges };
}

/**
 * Deterministic fallback plan synthesizer so a launched mission NEVER stalls in empty 'planning'
 * if model inference omits decompose_mission.
 */
export function buildFallbackMissionPlan(input: {
  objective: string;
  healthyAgents: ReadonlyArray<{ name: string; role: string }>;
  idFactory?: (prefix: string, idx: number) => string;
}): {
  planSummary: string;
  goals: NormalizedGoalInput[];
  tasks: NormalizedTaskInput[];
} {
  const researchAgent =
    input.healthyAgents.find((a) => a.role.includes("research") || a.role.includes("scout") || a.role.includes("analyst")) ??
    input.healthyAgents[0] ?? { name: "Orchestrator-Prime", role: "orchestrator" };
  const execAgent =
    input.healthyAgents.find((a) => a.role.includes("engineer") || a.role.includes("grid") || a.role.includes("supply") || a.role.includes("macro")) ??
    input.healthyAgents[0] ?? { name: "Orchestrator-Prime", role: "orchestrator" };
  const verifyAgent =
    input.healthyAgents.find((a) => a.role.includes("verification")) ??
    input.healthyAgents[0] ?? { name: "Orchestrator-Prime", role: "orchestrator" };

  const shortObj = input.objective.trim().slice(0, 96);
  const normalized = validateAndNormalizePlan({
    goalsIn: [
      {
        id: "gol_1",
        title: `Execute & Verify: ${shortObj.slice(0, 48)}`,
        detail: `Gather live telemetry, synthesize deliverable, and verify acceptance criteria for: ${input.objective}`,
      },
    ],
    tasksIn: [
      {
        id: "tsk_1",
        goalId: "gol_1",
        title: `Gather live evidence for "${shortObj.slice(0, 44)}"`,
        detail: "Query primary live external APIs / search grounding and archive concrete sources.",
        assignee: researchAgent.name,
        role: researchAgent.role,
        dependsOn: [],
      },
      {
        id: "tsk_2",
        goalId: "gol_1",
        title: "Synthesize structured execution brief & deliverable",
        detail: "Transform verified evidence into actionable implementation or operational recommendation.",
        assignee: execAgent.name,
        role: execAgent.role,
        dependsOn: ["tsk_1"],
      },
      {
        id: "tsk_3",
        goalId: "gol_1",
        title: "Audit acceptance criteria & close mission deliverables",
        detail: "Confirm zero fabricated claims, verify reserve compliance, and finalize outputs.",
        assignee: verifyAgent.name,
        role: verifyAgent.role,
        dependsOn: ["tsk_2"],
      },
    ],
    healthyAgents: input.healthyAgents,
    idFactory: input.idFactory,
  });

  return {
    planSummary: `Structured 3-stage pipeline: ${researchAgent.name} (evidence) → ${execAgent.name} (synthesis) → ${verifyAgent.name} (audit).`,
    goals: normalized.goals,
    tasks: normalized.tasks,
  };
}

export interface LifecycleReconciliationResult {
  tasksToUnlock: string[];
  goalUpdates: Array<{ id: string; progress: number; status: GoalStatus; changed: boolean }>;
  missionUpdate?: {
    missionId: string;
    nextStatus: MissionStatus;
    reason: string;
  };
}

/**
 * Pure lifecycle reconciler across Tasks -> Goals -> Mission:
 * - Unlocks 'pending' tasks whose upstream dependencies are all 'completed' -> 'assigned'.
 * - Computes deterministic Goal progress & transitions Goal status ('active' <-> 'completed' | 'blocked').
 * - Transitions Mission status: 'planning' -> 'active', 'active' -> 'completed' when all scoped tasks done,
 *   or 'halted' if cycleCount >= maxCycles while work remains open.
 */
export function reconcileLifecycle(input: {
  mission?: Mission;
  goals: Goal[];
  tasks: Task[];
  workQueue: WorkItem[];
}): LifecycleReconciliationResult {
  const { mission, goals, tasks, workQueue } = input;
  const statusById = new Map(tasks.map((t) => [t.id, t.status]));

  const tasksToUnlock = tasks
    .filter(
      (t) =>
        t.status === "pending" &&
        t.dependsOn.every((depId) => statusById.get(depId) === "completed"),
    )
    .map((t) => t.id);

  // Project unlocked state when computing goal progress
  const unlockSet = new Set(tasksToUnlock);
  const effectiveTasks = tasks.map((t) =>
    unlockSet.has(t.id) ? { ...t, status: "assigned" as const } : t,
  );

  const goalUpdates = goals.map((g) => {
    const gTasks = effectiveTasks.filter((t) => t.goalId === g.id);
    const progress = computeGoalProgress(g, effectiveTasks);
    let nextStatus: GoalStatus = g.status;
    if (gTasks.length > 0) {
      if (gTasks.every((t) => t.status === "completed")) {
        nextStatus = "completed";
      } else if (
        gTasks.some((t) => t.status === "failed") &&
        gTasks.every((t) => t.status === "completed" || t.status === "failed")
      ) {
        nextStatus = "blocked";
      } else {
        nextStatus = "active";
      }
    }
    return {
      id: g.id,
      progress,
      status: nextStatus,
      changed: progress !== g.progress || nextStatus !== g.status,
    };
  });

  let missionUpdate: LifecycleReconciliationResult["missionUpdate"];
  if (mission && (mission.status === "planning" || mission.status === "active")) {
    const scopedTasks = effectiveTasks.some((t) => t.missionId === mission.id)
      ? effectiveTasks.filter((t) => t.missionId === mission.id)
      : effectiveTasks;
    const scopedOpenWork = workQueue.filter(
      (w) =>
        (w.status === "pending" || w.status === "claimed") &&
        (!w.missionId || w.missionId === mission.id),
    );

    if (
      scopedTasks.length > 0 &&
      scopedTasks.every((t) => t.status === "completed") &&
      scopedOpenWork.length === 0
    ) {
      missionUpdate = {
        missionId: mission.id,
        nextStatus: "completed",
        reason: `All ${scopedTasks.length} mission task(s) verified completed.`,
      };
    } else if (mission.cycleCount >= mission.maxCycles) {
      missionUpdate = {
        missionId: mission.id,
        nextStatus: "halted",
        reason: `Cycle budget exhausted (${mission.cycleCount}/${mission.maxCycles}).`,
      };
    } else if (mission.status === "planning" && scopedTasks.length > 0) {
      missionUpdate = {
        missionId: mission.id,
        nextStatus: "active",
        reason: `Plan decomposed into ${scopedTasks.length} DAG task(s).`,
      };
    }
  }

  return { tasksToUnlock, goalUpdates, missionUpdate };
}

export function parseHeartbeatCadenceMs(cadence: string): number {
  const match = cadence.match(/(\d+)\s*(s|m|h)/i);
  if (!match) return 300_000;
  const n = Number(match[1]);
  const unit = match[2]!.toLowerCase();
  if (unit === "s") return n * 1_000;
  if (unit === "h") return n * 3_600_000;
  return n * 60_000;
}

export function isHeartbeatDue(
  heartbeat: { cadence: string; lastRunAt: number },
  now: number,
): boolean {
  return now - heartbeat.lastRunAt >= parseHeartbeatCadenceMs(heartbeat.cadence);
}

export interface StaleReapPlan {
  workToRetry: string[];
  workToExpire: string[];
  tasksToResetAssigned: string[];
  inboxToClose: string[];
  workersToFlagUnhealthy: string[];
}

/**
 * Pure stale-slot & orphan detector used by `stale_slot_reaper` heartbeat:
 * - Work items stuck in `'claimed'` > 3m: retry (`attempts < 3`) or expire (`attempts >= 3`).
 * - Tasks stuck in `'running'` > 10m: reset to `'assigned'` for rescheduling.
 * - Unclaimed old `'creator'` inbox entries (> 10m) with no active work: close as `'done'`.
 * - Non-orchestrator openclaw workers silent > 15m (excluding intentionally gated `'starting'` workers): flag `'unhealthy'`.
 */
export function computeStaleReapActions(input: {
  tasks: Task[];
  workQueue: WorkItem[];
  inbox: InboxMessage[];
  children: Child[];
  now: number;
}): StaleReapPlan {
  const { tasks, workQueue, inbox, children, now } = input;
  const STALE_WORK_MS = 3 * 60_000;
  const STALE_TASK_MS = 10 * 60_000;
  const STALE_INBOX_MS = 10 * 60_000;
  const STALE_WORKER_MS = 15 * 60_000;

  const workToRetry: string[] = [];
  const workToExpire: string[] = [];
  for (const w of workQueue) {
    if (w.status === "claimed" && now - w.updatedAt >= STALE_WORK_MS) {
      if (w.attempts >= 3) workToExpire.push(w.id);
      else workToRetry.push(w.id);
    }
  }

  const tasksToResetAssigned: string[] = [];
  for (const t of tasks) {
    const lastTouched = t.updatedAt ?? t.createdAt ?? now;
    if (t.status === "running" && now - lastTouched >= STALE_TASK_MS) {
      tasksToResetAssigned.push(t.id);
    }
  }

  const hasPendingWork = workQueue.some((w) => w.status === "pending" || w.status === "claimed");
  const inboxToClose: string[] = [];
  if (!hasPendingWork) {
    for (const m of inbox) {
      if (
        m.from === "creator" &&
        (m.status === "received" || m.status === "claimed") &&
        now - m.at >= STALE_INBOX_MS
      ) {
        inboxToClose.push(m.id);
      }
    }
  }

  const workersToFlagUnhealthy: string[] = [];
  for (const c of children) {
    if (
      c.kind === "openclaw" &&
      c.status === "healthy" &&
      c.lastBeatAgoMs >= STALE_WORKER_MS
    ) {
      workersToFlagUnhealthy.push(c.id);
    }
  }

  return {
    workToRetry,
    workToExpire,
    tasksToResetAssigned,
    inboxToClose,
    workersToFlagUnhealthy,
  };
}

const PRIVATE_IP_PATTERNS = [
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\./,
  /^172\.(1[6-9]|2\d|3[0-1])\./,
  /^::1$/i,
  /^fc/i,
  /^fd/i,
  /^fe80:/i,
];

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
  "metadata",
  "169.254.169.254",
]);

/**
 * Strict SSRF guard for user/agent-supplied public HTTPS URLs.
 */
export function validatePublicHttpsUrl(rawUrl: string): { ok: true; url: URL } | { ok: false; error: string } {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return { ok: false, error: "Invalid URL syntax." };
  }

  if (parsed.protocol !== "https:") {
    return { ok: false, error: "Only HTTPS URLs are permitted for external tool execution." };
  }

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host || BLOCKED_HOSTNAMES.has(host) || host.endsWith(".local") || host.endsWith(".internal")) {
    return { ok: false, error: `Blocked non-public host: ${host}` };
  }

  for (const pat of PRIVATE_IP_PATTERNS) {
    if (pat.test(host)) {
      return { ok: false, error: `Blocked private/loopback IP host: ${host}` };
    }
  }

  return { ok: true, url: parsed };
}

/**
 * Safely substitute `{{param}}` placeholders in a URL template with URI-encoded values.
 */
export function renderUrlTemplate(template: string, params: Record<string, unknown>): string {
  return template.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_, key: string) => {
    const val = params[key];
    return val === undefined || val === null ? "" : encodeURIComponent(String(val));
  });
}
