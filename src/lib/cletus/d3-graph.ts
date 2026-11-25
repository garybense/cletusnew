import type {
  AgentMessage,
  Child,
  ExecutionCycle,
  Goal,
  Mission,
  MissionStatus,
  ModelSpend,
  Task,
  TaskStatus,
  TaskStatusEvent,
  ToolSpend,
} from "./types";

export type D3NodeKind = "mission" | "goal" | "task" | "worker";
export type D3EdgeKind = "mission_goal" | "goal_task" | "task_dep" | "task_worker";

export interface D3GraphNode {
  id: string;
  entityId: string;
  kind: D3NodeKind;
  title: string;
  subtitle: string;
  meta: string;
  status: string;
  progress: number;
  tone: "ok" | "warn" | "crit" | "mute";
  layer: number;
  x: number;
  y: number;
  width: number;
  height: number;
  blockedBy?: string[];
  missionId?: string;
  goalId?: string;
}

export interface D3GraphEdge {
  id: string;
  kind: D3EdgeKind;
  sourceId: string;
  targetId: string;
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
  satisfied: boolean;
}

export interface D3GraphLayout {
  nodes: D3GraphNode[];
  edges: D3GraphEdge[];
  headers: Array<{ label: string; x: number; width: number }>;
  width: number;
  height: number;
  summary: {
    missionsCount: number;
    goalsCount: number;
    tasksCount: number;
    tasksCompleted: number;
    workersCount: number;
    overallProgressPct: number;
  };
}

function missionTone(status: MissionStatus): "ok" | "warn" | "crit" | "mute" {
  if (status === "completed") return "ok";
  if (status === "active" || status === "planning") return "warn";
  if (status === "failed" || status === "halted") return "crit";
  return "mute";
}

function goalTone(status: Goal["status"]): "ok" | "warn" | "crit" | "mute" {
  if (status === "completed") return "ok";
  if (status === "blocked") return "crit";
  return "warn";
}

function taskTone(status: TaskStatus): "ok" | "warn" | "crit" | "mute" {
  if (status === "completed") return "ok";
  if (status === "running" || status === "assigned") return "warn";
  if (status === "failed") return "crit";
  return "mute";
}

function taskProgress(status: TaskStatus): number {
  switch (status) {
    case "completed":
      return 100;
    case "running":
      return 60;
    case "assigned":
      return 25;
    case "pending":
    case "failed":
    default:
      return 0;
  }
}

function workerTone(status: Child["status"]): "ok" | "warn" | "crit" | "mute" {
  if (status === "healthy") return "ok";
  if (status === "starting") return "warn";
  if (status === "unhealthy") return "crit";
  return "mute";
}

/**
 * Compute topological depth (0-indexed) across visible tasks based on `dependsOn` edges.
 */
export function computeTaskTopologicalLayers(tasks: Task[]): Map<string, number> {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const memo = new Map<string, number>();

  function visit(id: string, stack: Set<string>): number {
    if (memo.has(id)) return memo.get(id)!;
    if (stack.has(id)) return 0;
    const task = byId.get(id);
    if (!task) return 0;

    stack.add(id);
    let maxParent = -1;
    for (const depId of task.dependsOn) {
      if (!byId.has(depId)) continue;
      maxParent = Math.max(maxParent, visit(depId, stack));
    }
    stack.delete(id);
    const layer = maxParent + 1;
    memo.set(id, layer);
    return layer;
  }

  for (const t of tasks) {
    visit(t.id, new Set());
  }
  return memo;
}

/**
 * Compute incomplete upstream dependency IDs for each task.
 */
export function getIncompleteUpstreamIds(tasks: Task[], task: Task): string[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return task.dependsOn.filter((depId) => {
    const dep = byId.get(depId);
    return dep !== undefined && dep.status !== "completed";
  });
}

/**
 * Build deterministic hierarchical + topological D3 graph layout for Missions -> Goals -> Tasks -> Agents.
 */
export function buildD3TaskHierarchyGraph(input: {
  missions: Mission[];
  goals: Goal[];
  tasks: Task[];
  children: Child[];
  activeMissionId?: string | null;
  missionOnly?: boolean;
  goalFilter?: string;
}): D3GraphLayout {
  const {
    missions,
    goals,
    tasks,
    children,
    activeMissionId,
    missionOnly = false,
    goalFilter = "all",
  } = input;

  // 1. Scope Goals & Tasks cleanly
  let visibleGoals = goals;
  if (missionOnly && activeMissionId) {
    const scoped = visibleGoals.filter((g) => g.missionId === activeMissionId);
    if (scoped.length > 0) visibleGoals = scoped;
  }
  if (goalFilter !== "all") {
    visibleGoals = visibleGoals.filter((g) => g.id === goalFilter);
  }

  let visibleTasks = tasks;
  if (missionOnly && activeMissionId) {
    const scoped = visibleTasks.filter((t) => t.missionId === activeMissionId);
    if (scoped.length > 0) visibleTasks = scoped;
  }
  if (goalFilter !== "all") {
    visibleTasks = visibleTasks.filter((t) => t.goalId === goalFilter);
  }

  const referencedMissionIds = new Set<string>();
  for (const g of visibleGoals) {
    if (g.missionId) referencedMissionIds.add(g.missionId);
  }
  for (const t of visibleTasks) {
    if (t.missionId) referencedMissionIds.add(t.missionId);
  }
  if (activeMissionId && !missionOnly) {
    referencedMissionIds.add(activeMissionId);
  }

  const visibleMissions = missions.filter(
    (m) =>
      referencedMissionIds.has(m.id) ||
      (!missionOnly && goalFilter === "all" && (m.status === "active" || m.status === "planning")),
  );

  // Order tasks topologically by layer, and within each layer by goal order & creation time
  const goalOrder = new Map(visibleGoals.map((g, idx) => [g.id, idx]));
  const depthMap = computeTaskTopologicalLayers(visibleTasks);
  const maxTaskDepth = visibleTasks.reduce(
    (max, t) => Math.max(max, depthMap.get(t.id) ?? 0),
    0,
  );

  const taskColumns = new Map<number, Task[]>();
  for (let d = 0; d <= maxTaskDepth; d++) {
    taskColumns.set(d, []);
  }
  for (const t of visibleTasks) {
    const d = depthMap.get(t.id) ?? 0;
    taskColumns.get(d)!.push(t);
  }
  for (const list of taskColumns.values()) {
    list.sort((a, b) => {
      const ga = goalOrder.get(a.goalId) ?? 999;
      const gb = goalOrder.get(b.goalId) ?? 999;
      if (ga !== gb) return ga - gb;
      const sa = typeof a.sortOrder === "number" ? a.sortOrder : Number.MAX_SAFE_INTEGER;
      const sb = typeof b.sortOrder === "number" ? b.sortOrder : Number.MAX_SAFE_INTEGER;
      if (sa !== sb) return sa - sb;
      return (a.createdAt ?? 0) - (b.createdAt ?? 0);
    });
  }

  // Visible workers = all configured workers + any assignee referenced on visible tasks
  const workerNames = Array.from(
    new Set([
      ...children.map((c) => c.name),
      ...visibleTasks.map((t) => t.assignee),
    ]),
  );

  // Geometry constants
  const PAD_X = 20;
  const TOP_Y = 44;
  const COL_GAP = 56;
  const ROW_GAP = 14;

  const MISSION_W = 224;
  const MISSION_H = 74;
  const GOAL_W = 224;
  const GOAL_H = 70;
  const TASK_W = 248;
  const TASK_H = 72;
  const WORKER_W = 212;
  const WORKER_H = 62;

  const hasMissions = visibleMissions.length > 0;
  const missionX = PAD_X;
  const goalX = hasMissions ? missionX + MISSION_W + COL_GAP : PAD_X;
  const taskStartX = goalX + GOAL_W + COL_GAP;
  const taskLayerCount = visibleTasks.length > 0 ? maxTaskDepth + 1 : 1;
  const workerX = taskStartX + taskLayerCount * (TASK_W + COL_GAP);

  const nodes: D3GraphNode[] = [];
  const nodeById = new Map<string, D3GraphNode>();

  const pushNode = (n: D3GraphNode) => {
    nodes.push(n);
    nodeById.set(n.id, n);
  };

  // Place Missions
  visibleMissions.forEach((m, idx) => {
    const scopedTasks = tasks.filter((t) => t.missionId === m.id);
    const fallbackTasks = scopedTasks.length > 0 ? scopedTasks : visibleTasks;
    const done = fallbackTasks.filter((t) => t.status === "completed").length;
    const pct =
      fallbackTasks.length > 0
        ? Math.round((done / fallbackTasks.length) * 100)
        : m.status === "completed"
          ? 100
          : 0;

    pushNode({
      id: `mission:${m.id}`,
      entityId: m.id,
      kind: "mission",
      title: m.title,
      subtitle: `${m.status.toUpperCase()} · ${done}/${fallbackTasks.length} tasks (${pct}%)`,
      meta: `${m.id} · ${m.cycleCount}/${m.maxCycles} cycles`,
      status: m.status,
      progress: pct,
      tone: missionTone(m.status),
      layer: 0,
      x: missionX,
      y: TOP_Y + idx * (MISSION_H + ROW_GAP),
      width: MISSION_W,
      height: MISSION_H,
      missionId: m.id,
    });
  });

  // Place Goals
  visibleGoals.forEach((g, idx) => {
    const gTasks = visibleTasks.filter((t) => t.goalId === g.id);
    const doneCount = gTasks.filter((t) => t.status === "completed").length;
    pushNode({
      id: `goal:${g.id}`,
      entityId: g.id,
      kind: "goal",
      title: g.title,
      subtitle: `${g.status.toUpperCase()} · ${g.progress}% (${doneCount}/${gTasks.length})`,
      meta: g.missionId ? `${g.id} · ${g.missionId}` : g.id,
      status: g.status,
      progress: g.progress,
      tone: goalTone(g.status),
      layer: 1,
      x: goalX,
      y: TOP_Y + idx * (GOAL_H + ROW_GAP),
      width: GOAL_W,
      height: GOAL_H,
      missionId: g.missionId,
      goalId: g.id,
    });
  });

  // Place Tasks per topological layer
  for (let d = 0; d <= maxTaskDepth; d++) {
    const colTasks = taskColumns.get(d) ?? [];
    const colX = taskStartX + d * (TASK_W + COL_GAP);
    colTasks.forEach((t, idx) => {
      const blockedBy = getIncompleteUpstreamIds(tasks, t);
      const statusTxt =
        t.status === "completed"
          ? "DONE"
          : t.status === "running"
            ? "RUNNING"
            : t.status === "assigned"
              ? "ASSIGNED"
              : t.status === "failed"
                ? "FAILED"
                : blockedBy.length > 0
                  ? "BLOCKED"
                  : "PENDING";

      pushNode({
        id: `task:${t.id}`,
        entityId: t.id,
        kind: "task",
        title: t.title,
        subtitle: `${statusTxt} · ${t.assignee}`,
        meta: `${t.id} · ${t.role}${t.dependsOn.length > 0 ? ` · deps:${t.dependsOn.length}` : ""}`,
        status: t.status,
        progress: taskProgress(t.status),
        tone: taskTone(t.status),
        layer: 2 + d,
        x: colX,
        y: TOP_Y + idx * (TASK_H + ROW_GAP),
        width: TASK_W,
        height: TASK_H,
        blockedBy,
        missionId: t.missionId,
        goalId: t.goalId,
      });
    });
  }

  // Place Mesh Workers
  workerNames.forEach((name, idx) => {
    const worker = children.find((c) => c.name.toLowerCase() === name.toLowerCase());
    const openCount = visibleTasks.filter(
      (t) => t.assignee.toLowerCase() === name.toLowerCase() && t.status !== "completed" && t.status !== "failed",
    ).length;
    const totalAssigned = visibleTasks.filter(
      (t) => t.assignee.toLowerCase() === name.toLowerCase(),
    ).length;
    const doneAssigned = visibleTasks.filter(
      (t) => t.assignee.toLowerCase() === name.toLowerCase() && t.status === "completed",
    ).length;
    const pct = totalAssigned > 0 ? Math.round((doneAssigned / totalAssigned) * 100) : 100;
    const entityId = worker ? worker.id : name;

    pushNode({
      id: `worker:${name.toLowerCase()}`,
      entityId,
      kind: "worker",
      title: name,
      subtitle: `${worker?.role ?? "agent"} · ${worker?.status ?? "healthy"}`,
      meta: `${openCount} open · ${worker?.cycleCount ?? 0} cycles${worker?.latencyMs ? ` · ${worker.latencyMs}ms` : ""}`,
      status: worker?.status ?? "healthy",
      progress: pct,
      tone: worker ? workerTone(worker.status) : "ok",
      layer: 2 + taskLayerCount,
      x: workerX,
      y: TOP_Y + idx * (WORKER_H + ROW_GAP),
      width: WORKER_W,
      height: WORKER_H,
    });
  });

  // 2. Build Edges: Mission -> Goal -> Root Task -> Dependent Task -> Worker
  const edges: D3GraphEdge[] = [];
  const visibleTaskIds = new Set(visibleTasks.map((t) => t.id));
  const taskById = new Map(tasks.map((t) => [t.id, t]));

  // Mission -> Goal
  for (const g of visibleGoals) {
    if (!g.missionId) continue;
    const src = nodeById.get(`mission:${g.missionId}`);
    const dst = nodeById.get(`goal:${g.id}`);
    if (!src || !dst) continue;
    edges.push({
      id: `edge:mg:${src.entityId}:${dst.entityId}`,
      kind: "mission_goal",
      sourceId: src.id,
      targetId: dst.id,
      sourceX: src.x + src.width,
      sourceY: src.y + src.height / 2,
      targetX: dst.x,
      targetY: dst.y + dst.height / 2,
      satisfied: dst.status === "completed",
    });
  }

  // Goal -> Root Tasks (or tasks without visible upstream task dependencies)
  for (const t of visibleTasks) {
    const hasVisibleParentTask = t.dependsOn.some((depId) => visibleTaskIds.has(depId));
    if (!hasVisibleParentTask) {
      const src = nodeById.get(`goal:${t.goalId}`);
      const dst = nodeById.get(`task:${t.id}`);
      if (src && dst) {
        edges.push({
          id: `edge:gt:${src.entityId}:${dst.entityId}`,
          kind: "goal_task",
          sourceId: src.id,
          targetId: dst.id,
          sourceX: src.x + src.width,
          sourceY: src.y + src.height / 2,
          targetX: dst.x,
          targetY: dst.y + dst.height / 2,
          satisfied: t.status === "completed",
        });
      }
    }
  }

  // Task -> Dependent Task (`dependsOn`)
  for (const t of visibleTasks) {
    const dst = nodeById.get(`task:${t.id}`);
    if (!dst) continue;
    for (const depId of t.dependsOn) {
      const src = nodeById.get(`task:${depId}`);
      if (!src) continue;
      const upstream = taskById.get(depId);
      edges.push({
        id: `edge:dep:${depId}:${t.id}`,
        kind: "task_dep",
        sourceId: src.id,
        targetId: dst.id,
        sourceX: src.x + src.width,
        sourceY: src.y + src.height / 2,
        targetX: dst.x,
        targetY: dst.y + dst.height / 2,
        satisfied: upstream?.status === "completed",
      });
    }
  }

  // Task -> Assigned Worker
  for (const t of visibleTasks) {
    const src = nodeById.get(`task:${t.id}`);
    const dst = nodeById.get(`worker:${t.assignee.toLowerCase()}`);
    if (!src || !dst) continue;
    edges.push({
      id: `edge:tw:${t.id}:${t.assignee.toLowerCase()}`,
      kind: "task_worker",
      sourceId: src.id,
      targetId: dst.id,
      sourceX: src.x + src.width,
      sourceY: src.y + src.height / 2,
      targetX: dst.x,
      targetY: dst.y + dst.height / 2,
      satisfied: t.status === "completed",
    });
  }

  const headers: Array<{ label: string; x: number; width: number }> = [];
  if (hasMissions) {
    headers.push({ label: `Missions (${visibleMissions.length})`, x: missionX, width: MISSION_W });
  }
  headers.push({ label: `Goals (${visibleGoals.length})`, x: goalX, width: GOAL_W });
  for (let d = 0; d < taskLayerCount; d++) {
    const count = taskColumns.get(d)?.length ?? 0;
    headers.push({
      label: taskLayerCount > 1 ? `Tasks · Stage ${d + 1} (${count})` : `Tasks (${count})`,
      x: taskStartX + d * (TASK_W + COL_GAP),
      width: TASK_W,
    });
  }
  headers.push({ label: `Agent Mesh (${workerNames.length})`, x: workerX, width: WORKER_W });

  const maxNodeBottom = nodes.reduce((max, n) => Math.max(max, n.y + n.height), 260);
  const width = workerX + WORKER_W + PAD_X;
  const height = Math.max(300, maxNodeBottom + 24);

  const tasksCompleted = visibleTasks.filter((t) => t.status === "completed").length;
  const overallProgressPct =
    visibleTasks.length > 0 ? Math.round((tasksCompleted / visibleTasks.length) * 100) : 0;

  return {
    nodes,
    edges,
    headers,
    width,
    height,
    summary: {
      missionsCount: visibleMissions.length,
      goalsCount: visibleGoals.length,
      tasksCount: visibleTasks.length,
      tasksCompleted,
      workersCount: workerNames.length,
      overallProgressPct,
    },
  };
}

export interface ConnectedLineage {
  nodeIds: Set<string>;
  edgeIds: Set<string>;
  upstreamNodeIds: Set<string>;
  downstreamNodeIds: Set<string>;
  upstreamEdgeIds: Set<string>;
  downstreamEdgeIds: Set<string>;
}

/**
 * Transitive BFS from `selectedGraphNodeId`:
 * - Upstream: walks backward along incoming edges (e.targetId === curr -> e.sourceId)
 * - Downstream: walks forward along outgoing edges (e.sourceId === curr -> e.targetId)
 */
export function getConnectedLineage(
  selectedGraphNodeId: string | null,
  edges: D3GraphEdge[],
): ConnectedLineage {
  const nodeIds = new Set<string>();
  const edgeIds = new Set<string>();
  const upstreamNodeIds = new Set<string>();
  const downstreamNodeIds = new Set<string>();
  const upstreamEdgeIds = new Set<string>();
  const downstreamEdgeIds = new Set<string>();

  if (!selectedGraphNodeId) {
    return {
      nodeIds,
      edgeIds,
      upstreamNodeIds,
      downstreamNodeIds,
      upstreamEdgeIds,
      downstreamEdgeIds,
    };
  }

  nodeIds.add(selectedGraphNodeId);

  const incoming = new Map<string, D3GraphEdge[]>();
  const outgoing = new Map<string, D3GraphEdge[]>();
  for (const e of edges) {
    const inList = incoming.get(e.targetId) ?? [];
    inList.push(e);
    incoming.set(e.targetId, inList);

    const outList = outgoing.get(e.sourceId) ?? [];
    outList.push(e);
    outgoing.set(e.sourceId, outList);
  }

  const upQueue: string[] = [selectedGraphNodeId];
  const upVisited = new Set<string>([selectedGraphNodeId]);
  while (upQueue.length > 0) {
    const curr = upQueue.shift()!;
    for (const e of incoming.get(curr) ?? []) {
      upstreamEdgeIds.add(e.id);
      edgeIds.add(e.id);
      if (!upVisited.has(e.sourceId)) {
        upVisited.add(e.sourceId);
        upstreamNodeIds.add(e.sourceId);
        nodeIds.add(e.sourceId);
        upQueue.push(e.sourceId);
      }
    }
  }

  const downQueue: string[] = [selectedGraphNodeId];
  const downVisited = new Set<string>([selectedGraphNodeId]);
  while (downQueue.length > 0) {
    const curr = downQueue.shift()!;
    for (const e of outgoing.get(curr) ?? []) {
      downstreamEdgeIds.add(e.id);
      edgeIds.add(e.id);
      if (!downVisited.has(e.targetId)) {
        downVisited.add(e.targetId);
        downstreamNodeIds.add(e.targetId);
        nodeIds.add(e.targetId);
        downQueue.push(e.targetId);
      }
    }
  }

  return {
    nodeIds,
    edgeIds,
    upstreamNodeIds,
    downstreamNodeIds,
    upstreamEdgeIds,
    downstreamEdgeIds,
  };
}

export interface TaskComputedMetadata {
  taskId: string;
  startTime: number | null;
  updatedTime: number | null;
  elapsedMs: number | null;
  missionTitle: string | null;
  goalTitle: string | null;
  upstreamTasks: Task[];
  downstreamTasks: Task[];
  resourceUsage: {
    cyclesCount: number;
    totalDurationMs: number;
    spendCents: number;
    toolInvocations: number;
    handoffMessages: number;
    modelName: string | null;
  };
  recentEvents: TaskStatusEvent[];
}

export function computeTaskMetadata(
  task: Task,
  ctx: {
    tasks: Task[];
    goals: Goal[];
    missions: Mission[];
    children: Child[];
    cycles: ExecutionCycle[];
    spendByModel: ModelSpend[];
    toolSpends: ToolSpend[];
    agentMessages: AgentMessage[];
    taskEvents: TaskStatusEvent[];
    now: number;
  },
): TaskComputedMetadata {
  const taskById = new Map(ctx.tasks.map((t) => [t.id, t]));
  const goal = ctx.goals.find((g) => g.id === task.goalId);
  const missionId = task.missionId ?? goal?.missionId;
  const mission = missionId ? ctx.missions.find((m) => m.id === missionId) : undefined;
  const worker = ctx.children.find(
    (c) => c.name.toLowerCase() === task.assignee.toLowerCase() || c.id === task.assignee,
  );

  // Transitive upstream & downstream task dependencies
  const upstreamTasks: Task[] = [];
  const upSeen = new Set<string>([task.id]);
  const upStack = [...task.dependsOn];
  while (upStack.length > 0) {
    const depId = upStack.shift()!;
    if (upSeen.has(depId)) continue;
    upSeen.add(depId);
    const depTask = taskById.get(depId);
    if (depTask) {
      upstreamTasks.push(depTask);
      for (const parentId of depTask.dependsOn) {
        if (!upSeen.has(parentId)) upStack.push(parentId);
      }
    }
  }

  const downstreamTasks: Task[] = [];
  const downSeen = new Set<string>([task.id]);
  const downQueue = [task.id];
  while (downQueue.length > 0) {
    const currId = downQueue.shift()!;
    for (const candidate of ctx.tasks) {
      if (!downSeen.has(candidate.id) && candidate.dependsOn.includes(currId)) {
        downSeen.add(candidate.id);
        downstreamTasks.push(candidate);
        downQueue.push(candidate.id);
      }
    }
  }

  const eventsForTask = ctx.taskEvents
    .filter((ev) => ev.taskId === task.id)
    .slice()
    .sort((a, b) => a.createdAt - b.createdAt);

  const startedEvent =
    eventsForTask.find((ev) => ev.status === "running") ??
    eventsForTask.find((ev) => ev.status === "assigned") ??
    eventsForTask[0];

  const startTime = task.createdAt ?? startedEvent?.createdAt ?? null;
  const latestEvent = eventsForTask[eventsForTask.length - 1];
  const updatedTime = task.updatedAt ?? latestEvent?.createdAt ?? startTime;

  let elapsedMs: number | null = null;
  if (startTime !== null) {
    if (task.status === "completed" || task.status === "failed") {
      elapsedMs = Math.max(0, (updatedTime ?? ctx.now) - startTime);
    } else {
      elapsedMs = Math.max(0, ctx.now - startTime);
    }
  }

  const matchingCycles = ctx.cycles.filter((c) => {
    const sameAgent = c.agentName.toLowerCase() === task.assignee.toLowerCase();
    const sameMission = !missionId || !c.missionId || c.missionId === missionId;
    const mentionsTask =
      c.phaseAct.includes(task.id) ||
      c.phaseReason.includes(task.id) ||
      c.phaseObserve.includes(task.id);
    return mentionsTask || (sameAgent && sameMission);
  });

  const cyclesCount = matchingCycles.length;
  const totalDurationMs = matchingCycles.reduce((acc, c) => acc + Math.max(0, c.durationMs || 0), 0);
  const spendCents = matchingCycles.reduce((acc, c) => acc + Math.max(0, c.costCents || 0), 0);
  const toolInvocations = matchingCycles.reduce(
    (acc, c) => acc + (Array.isArray(c.toolsUsed) ? c.toolsUsed.length : 0),
    0,
  );
  const handoffMessages = ctx.agentMessages.filter(
    (m) =>
      m.taskId === task.id ||
      m.fromAgent.toLowerCase() === task.assignee.toLowerCase() ||
      m.toAgent.toLowerCase() === task.assignee.toLowerCase(),
  ).length;

  return {
    taskId: task.id,
    startTime,
    updatedTime,
    elapsedMs,
    missionTitle: mission?.title ?? null,
    goalTitle: goal?.title ?? null,
    upstreamTasks,
    downstreamTasks,
    resourceUsage: {
      cyclesCount,
      totalDurationMs,
      spendCents,
      toolInvocations,
      handoffMessages,
      modelName: worker?.model ?? null,
    },
    recentEvents: eventsForTask.slice(-8).reverse(),
  };
}
