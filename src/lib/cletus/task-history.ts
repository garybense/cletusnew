import type { Task, TaskStatus, TaskStatusEvent } from "./types";

export interface TaskTimelinePoint {
  timestamp: number;
  completed: number;
  running: number;
  assigned: number;
  pending: number;
  failed: number;
  total: number;
  events: TaskStatusEvent[];
}

export interface ReconstructedOperationalState {
  timestamp: number;
  counts: {
    completed: number;
    running: number;
    assigned: number;
    pending: number;
    failed: number;
    total: number;
  };
  statusesByTaskId: Map<string, TaskStatus>;
  eventsAtOrBefore: TaskStatusEvent[];
  latestEvent: TaskStatusEvent | null;
}

function makeEmptyCounts() {
  return {
    completed: 0,
    running: 0,
    assigned: 0,
    pending: 0,
    failed: 0,
    total: 0,
  };
}

function tallyStatuses(statuses: Iterable<TaskStatus>) {
  const counts = makeEmptyCounts();
  for (const st of statuses) {
    counts.total += 1;
    if (st === "completed") counts.completed += 1;
    else if (st === "running") counts.running += 1;
    else if (st === "assigned") counts.assigned += 1;
    else if (st === "failed") counts.failed += 1;
    else counts.pending += 1;
  }
  return counts;
}

/**
 * Synthesize baseline events if a task exists in DB without any recorded transition event yet.
 */
export function mergeTaskEventsWithFallback(
  events: TaskStatusEvent[],
  tasks: Task[],
  now: number,
): TaskStatusEvent[] {
  const sorted = events
    .slice()
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));

  const seenTaskIds = new Set(sorted.map((ev) => ev.taskId));
  const fallback: TaskStatusEvent[] = [];

  for (const task of tasks) {
    if (seenTaskIds.has(task.id)) continue;
    const createdAt = task.createdAt ?? Math.max(0, now - 60_000);
    fallback.push({
      id: `evt_init_${task.id}`,
      taskId: task.id,
      missionId: task.missionId,
      goalId: task.goalId,
      status: task.status === "completed" ? "pending" : task.status,
      actor: task.assignee,
      note: task.title,
      createdAt,
    });
    if (task.status === "completed" && (task.updatedAt ?? now) > createdAt) {
      fallback.push({
        id: `evt_done_${task.id}`,
        taskId: task.id,
        missionId: task.missionId,
        goalId: task.goalId,
        previousStatus: "running",
        status: "completed",
        actor: task.assignee,
        note: task.result ?? task.title,
        createdAt: task.updatedAt ?? now,
      });
    }
  }

  return [...sorted, ...fallback].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

/**
 * Build ordered time-series points from persisted task status events, appending the current `now` point
 * so D3 line charts always reflect live operational telemetry up to the present moment.
 */
export function buildTaskStatusTimeline(
  rawEvents: TaskStatusEvent[],
  tasks: Task[],
  now: number,
  missionId?: string | null,
): TaskTimelinePoint[] {
  const scopedTasks = missionId ? tasks.filter((t) => !t.missionId || t.missionId === missionId) : tasks;
  const scopedTaskIds = new Set(scopedTasks.map((t) => t.id));
  const rawScoped = missionId
    ? rawEvents.filter((ev) => ev.missionId === missionId || scopedTaskIds.has(ev.taskId))
    : rawEvents;

  const events = mergeTaskEventsWithFallback(rawScoped, scopedTasks, now);
  if (events.length === 0) {
    const counts = tallyStatuses(scopedTasks.map((t) => t.status));
    return [
      {
        timestamp: now,
        ...counts,
        events: [],
      },
    ];
  }

  // Group events with identical timestamps so simultaneous transitions produce one clean snapshot step
  const grouped: Array<{ timestamp: number; events: TaskStatusEvent[] }> = [];
  for (const ev of events) {
    const last = grouped[grouped.length - 1];
    if (last && last.timestamp === ev.createdAt) {
      last.events.push(ev);
    } else {
      grouped.push({ timestamp: ev.createdAt, events: [ev] });
    }
  }

  const statusesByTask = new Map<string, TaskStatus>();
  const points: TaskTimelinePoint[] = [];

  for (const bucket of grouped) {
    for (const ev of bucket.events) {
      statusesByTask.set(ev.taskId, ev.status);
    }
    const counts = tallyStatuses(statusesByTask.values());
    points.push({
      timestamp: bucket.timestamp,
      ...counts,
      events: bucket.events,
    });
  }

  // Reconcile terminal point with authoritative current tasks at `now`
  const currentStatuses = new Map(statusesByTask);
  for (const t of scopedTasks) {
    currentStatuses.set(t.id, t.status);
  }
  const currentCounts = tallyStatuses(currentStatuses.values());
  const lastPoint = points[points.length - 1];
  if (!lastPoint || now > lastPoint.timestamp) {
    points.push({
      timestamp: Math.max(now, (lastPoint?.timestamp ?? now) + 1),
      ...currentCounts,
      events: [],
    });
  } else {
    lastPoint.completed = currentCounts.completed;
    lastPoint.running = currentCounts.running;
    lastPoint.assigned = currentCounts.assigned;
    lastPoint.pending = currentCounts.pending;
    lastPoint.failed = currentCounts.failed;
    lastPoint.total = currentCounts.total;
  }

  return points;
}

/**
 * Reconstruct exact operational state (counts, task statuses, and transitions) at `targetTimestamp`.
 */
export function reconstructOperationalStateAt(
  rawEvents: TaskStatusEvent[],
  tasks: Task[],
  targetTimestamp: number,
  now: number,
  missionId?: string | null,
): ReconstructedOperationalState {
  const scopedTasks = missionId ? tasks.filter((t) => !t.missionId || t.missionId === missionId) : tasks;
  const scopedTaskIds = new Set(scopedTasks.map((t) => t.id));
  const rawScoped = missionId
    ? rawEvents.filter((ev) => ev.missionId === missionId || scopedTaskIds.has(ev.taskId))
    : rawEvents;

  const events = mergeTaskEventsWithFallback(rawScoped, scopedTasks, now);
  const eventsAtOrBefore = events.filter((ev) => ev.createdAt <= targetTimestamp);
  const statusesByTaskId = new Map<string, TaskStatus>();

  for (const ev of eventsAtOrBefore) {
    statusesByTaskId.set(ev.taskId, ev.status);
  }

  // If scrubbed at or past current time, ensure authoritative task rows align
  if (targetTimestamp >= now) {
    for (const t of scopedTasks) {
      statusesByTaskId.set(t.id, t.status);
    }
  }

  const counts = tallyStatuses(statusesByTaskId.values());
  return {
    timestamp: targetTimestamp,
    counts,
    statusesByTaskId,
    eventsAtOrBefore,
    latestEvent: eventsAtOrBefore[eventsAtOrBefore.length - 1] ?? null,
  };
}
