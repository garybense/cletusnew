import { normalizeTaskPriority } from "./format";
import type { Task, TaskPriority, TaskStatus } from "./types";

const PRIORITY_WEIGHT: Record<TaskPriority, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

/**
 * Deterministically sort tasks by manual `sortOrder`, falling back to `createdAt` and `id`.
 */
export function sortTasksBySequence(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    const sa = typeof a.sortOrder === "number" ? a.sortOrder : Number.MAX_SAFE_INTEGER;
    const sb = typeof b.sortOrder === "number" ? b.sortOrder : Number.MAX_SAFE_INTEGER;
    if (sa !== sb) return sa - sb;
    const ca = a.createdAt ?? 0;
    const cb = b.createdAt ?? 0;
    if (ca !== cb) return ca - cb;
    return a.id.localeCompare(b.id);
  });
}

/**
 * Reorder `allTasks` when `draggedId` is dropped before or after `targetId`.
 * Returns a full list of task IDs in the new canonical sequence.
 */
export function computeReorderedTaskIds(
  allTasks: Task[],
  draggedId: string,
  targetId: string,
  position: "before" | "after" = "before",
): string[] {
  const ordered = sortTasksBySequence(allTasks);
  if (!draggedId || !targetId || draggedId === targetId) {
    return ordered.map((t) => t.id);
  }

  const fromIdx = ordered.findIndex((t) => t.id === draggedId);
  const targetIdx = ordered.findIndex((t) => t.id === targetId);
  if (fromIdx === -1 || targetIdx === -1) {
    return ordered.map((t) => t.id);
  }

  const next = [...ordered];
  const [moved] = next.splice(fromIdx, 1);
  if (!moved) return ordered.map((t) => t.id);

  const newTargetIdx = next.findIndex((t) => t.id === targetId);
  const insertAt = position === "after" ? newTargetIdx + 1 : newTargetIdx;
  next.splice(Math.max(0, Math.min(next.length, insertAt)), 0, moved);
  return next.map((t) => t.id);
}

/**
 * Compute task IDs sorted by Priority (High -> Medium -> Low), preserving relative sequence within equal priorities.
 */
export function computePrioritySortedTaskIds(allTasks: Task[]): string[] {
  return sortTasksBySequence(allTasks)
    .sort((a, b) => {
      const pa = PRIORITY_WEIGHT[normalizeTaskPriority(a.priority)];
      const pb = PRIORITY_WEIGHT[normalizeTaskPriority(b.priority)];
      if (pa !== pb) return pa - pb;
      return 0;
    })
    .map((t) => t.id);
}

/**
 * Apply an explicit `orderedIds` permutation to `tasks`, normalizing contiguous `sortOrder` indices.
 */
export function applyTaskOrder(tasks: Task[], orderedIds: string[]): Task[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const seen = new Set<string>();
  const result: Task[] = [];

  for (const id of orderedIds) {
    if (seen.has(id)) continue;
    const task = byId.get(id);
    if (!task) continue;
    seen.add(id);
    result.push({ ...task, sortOrder: result.length });
  }

  for (const t of sortTasksBySequence(tasks)) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    result.push({ ...t, sortOrder: result.length });
  }

  return result;
}

/**
 * Optimistically apply a single task status/priority/assignee/result update in memory
 * so UI controls (e.g. animated completion checkboxes) respond immediately.
 */
export function applyOptimisticTaskUpdate(
  tasks: Task[],
  patch: {
    id: string;
    status?: TaskStatus;
    priority?: TaskPriority;
    assignee?: string;
    result?: string;
  },
): Task[] {
  return tasks.map((task) => {
    if (task.id !== patch.id) return task;
    return {
      ...task,
      status: patch.status ?? task.status,
      priority: patch.priority ?? task.priority,
      assignee: patch.assignee ?? task.assignee,
      result: patch.result !== undefined ? patch.result : task.result,
    };
  });
}
