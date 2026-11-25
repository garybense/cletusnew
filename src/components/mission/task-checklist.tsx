import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { ArrowUpDown, GripVertical, Lock } from "lucide-react";
import { getIncompleteUpstreamIds } from "@/lib/cletus/d3-graph";
import {
  normalizeTaskPriority,
  taskPriorityBadgeClass,
  taskPriorityLabel,
  taskStatusLabel,
  taskTone,
  toneTextClass,
} from "@/lib/cletus/format";
import type { SelectedNode } from "@/lib/cletus/store";
import {
  computePrioritySortedTaskIds,
  computeReorderedTaskIds,
  sortTasksBySequence,
} from "@/lib/cletus/task-order";
import type { Goal, Mission, Task } from "@/lib/cletus/types";
import { cn } from "@/lib/utils";
import { TaskStatusCheckbox } from "./task-status-checkbox";

interface TaskChecklistProps {
  missions: Mission[];
  goals: Goal[];
  tasks: Task[];
  activeMissionId?: string | null;
  missionOnly?: boolean;
  goalFilter?: string;
  selectedNode: SelectedNode | null;
  onSelectNode: (node: SelectedNode | null) => void;
  onToggleTaskComplete: (task: Task) => void;
  onReorderTasks: (orderedIds: string[]) => void;
  updatingTaskId: string | null;
  loading: boolean;
}

type ChecklistViewMode = "grouped" | "sequence";

export function TaskChecklist({
  missions,
  goals,
  tasks,
  activeMissionId,
  missionOnly = false,
  goalFilter = "all",
  selectedNode,
  onSelectNode,
  onToggleTaskComplete,
  onReorderTasks,
  updatingTaskId,
  loading,
}: TaskChecklistProps) {
  const [viewMode, setViewMode] = useState<ChecklistViewMode>("grouped");
  const [draggingTaskId, setDraggingTaskId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{
    taskId: string;
    position: "before" | "after";
  } | null>(null);

  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const suppressClickRef = useRef(false);
  const dragSessionRef = useRef<{
    taskId: string;
    startX: number;
    startY: number;
    active: boolean;
  } | null>(null);
  const dropTargetRef = useRef<{ taskId: string; position: "before" | "after" } | null>(null);

  const orderedAllTasks = sortTasksBySequence(tasks);

  let visibleGoals = goals;
  if (missionOnly && activeMissionId) {
    const scoped = visibleGoals.filter((g) => g.missionId === activeMissionId);
    if (scoped.length > 0) visibleGoals = scoped;
  }
  if (goalFilter !== "all") {
    visibleGoals = visibleGoals.filter((g) => g.id === goalFilter);
  }

  let visibleTasks = orderedAllTasks;
  if (missionOnly && activeMissionId) {
    const scoped = visibleTasks.filter((t) => t.missionId === activeMissionId);
    if (scoped.length > 0) visibleTasks = scoped;
  }
  if (goalFilter !== "all") {
    visibleTasks = visibleTasks.filter((t) => t.goalId === goalFilter);
  }

  const missionById = new Map(missions.map((m) => [m.id, m]));
  const taskById = new Map(orderedAllTasks.map((t) => [t.id, t]));
  const totalCount = visibleTasks.length;
  const completedCount = visibleTasks.filter((t) => t.status === "completed").length;
  const completionPct = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;

  const goalIdsSet = new Set(visibleGoals.map((g) => g.id));
  const orphanTasks = visibleTasks.filter((t) => !goalIdsSet.has(t.goalId));

  const latestRef = useRef({
    orderedAllTasks,
    viewMode,
    goalIdsSet,
    taskById,
    onReorderTasks,
  });
  latestRef.current = {
    orderedAllTasks,
    viewMode,
    goalIdsSet,
    taskById,
    onReorderTasks,
  };

  useEffect(() => {
    const canDropBetween = (sourceId: string, targetTask: Task): boolean => {
      if (sourceId === targetTask.id) return false;
      const { viewMode: vm, taskById: byId, goalIdsSet: gSet } = latestRef.current;
      if (vm === "sequence") return true;
      const sourceTask = byId.get(sourceId);
      if (!sourceTask) return false;
      const sourceOrphan = !gSet.has(sourceTask.goalId);
      const targetOrphan = !gSet.has(targetTask.goalId);
      if (sourceOrphan && targetOrphan) return true;
      return sourceTask.goalId === targetTask.goalId;
    };

    const handlePointerMove = (e: globalThis.PointerEvent) => {
      const session = dragSessionRef.current;
      if (!session) return;

      if (!session.active) {
        const dist = Math.hypot(e.clientX - session.startX, e.clientY - session.startY);
        if (dist < 5) return;
        session.active = true;
        suppressClickRef.current = true;
        setDraggingTaskId(session.taskId);
      }

      const scroller = scrollContainerRef.current;
      if (scroller) {
        const sRect = scroller.getBoundingClientRect();
        if (e.clientY < sRect.top + 28) {
          scroller.scrollTop -= 12;
        } else if (e.clientY > sRect.bottom - 28) {
          scroller.scrollTop += 12;
        }

        const rowEls = scroller.querySelectorAll<HTMLElement>("[data-task-row-id]");
        let nextDrop: { taskId: string; position: "before" | "after" } | null = null;
        for (const rowEl of rowEls) {
          const targetId = rowEl.dataset.taskRowId;
          if (!targetId) continue;
          const targetTask = latestRef.current.taskById.get(targetId);
          if (!targetTask || !canDropBetween(session.taskId, targetTask)) continue;

          const rect = rowEl.getBoundingClientRect();
          if (e.clientY >= rect.top - 4 && e.clientY <= rect.bottom + 4) {
            const position: "before" | "after" =
              e.clientY < rect.top + rect.height / 2 ? "before" : "after";
            nextDrop = { taskId: targetId, position };
            break;
          }
        }

        const prev = dropTargetRef.current;
        if (prev?.taskId !== nextDrop?.taskId || prev?.position !== nextDrop?.position) {
          dropTargetRef.current = nextDrop;
          setDropTarget(nextDrop);
        }
      }
    };

    const finishDrag = () => {
      const session = dragSessionRef.current;
      const target = dropTargetRef.current;
      dragSessionRef.current = null;
      dropTargetRef.current = null;
      setDraggingTaskId(null);
      setDropTarget(null);

      if (session?.active) {
        window.setTimeout(() => {
          suppressClickRef.current = false;
        }, 60);
        if (target) {
          const nextOrder = computeReorderedTaskIds(
            latestRef.current.orderedAllTasks,
            session.taskId,
            target.taskId,
            target.position,
          );
          latestRef.current.onReorderTasks(nextOrder);
        }
      }
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", finishDrag);
    window.addEventListener("pointercancel", finishDrag);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", finishDrag);
      window.removeEventListener("pointercancel", finishDrag);
    };
  }, []);

  const handleSortByPriority = () => {
    const nextOrder = computePrioritySortedTaskIds(orderedAllTasks);
    onReorderTasks(nextOrder);
  };

  const handleHandleKeyDown = (
    e: KeyboardEvent<HTMLButtonElement>,
    task: Task,
    scopeTasks: Task[],
  ) => {
    if (loading || updatingTaskId === task.id) return;
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    const idx = scopeTasks.findIndex((t) => t.id === task.id);
    if (idx === -1) return;
    const neighborIdx = e.key === "ArrowUp" ? idx - 1 : idx + 1;
    const neighbor = scopeTasks[neighborIdx];
    if (!neighbor) return;
    const position = e.key === "ArrowUp" ? "before" : "after";
    const nextOrder = computeReorderedTaskIds(orderedAllTasks, task.id, neighbor.id, position);
    onReorderTasks(nextOrder);
  };

  const renderTaskRow = (task: Task, scopeTasks: Task[]) => {
    const isDone = task.status === "completed";
    const blockedBy = getIncompleteUpstreamIds(tasks, task);
    const isBlocked = !isDone && blockedBy.length > 0;
    const isBusy = updatingTaskId === task.id;
    const isSelected = selectedNode?.kind === "task" && selectedNode.id === task.id;
    const isDragging = draggingTaskId === task.id;
    const isDropBefore = dropTarget?.taskId === task.id && dropTarget.position === "before";
    const isDropAfter = dropTarget?.taskId === task.id && dropTarget.position === "after";
    const tone = taskTone(task.status);
    const priority = normalizeTaskPriority(task.priority);

    const handleRowPointerDown = (e: ReactPointerEvent<HTMLLIElement>) => {
      if (loading || isBusy) return;
      if (e.button !== 0 && e.pointerType === "mouse") return;
      const targetEl = e.target as HTMLElement | null;
      if (targetEl?.closest("input[type='checkbox'], [role='checkbox']")) return;
      dragSessionRef.current = {
        taskId: task.id,
        startX: e.clientX,
        startY: e.clientY,
        active: false,
      };
    };

    return (
      <li
        key={task.id}
        onPointerDown={handleRowPointerDown}
        data-task-row-id={task.id}
        data-testid={`task-checklist-item-${task.id}`}
        data-task-status={task.status}
        data-task-priority={priority}
        data-sort-order={task.sortOrder ?? 0}
        className={cn(
          "task-checklist-row relative flex items-start gap-1.5 px-2 py-1.5 select-none transition-colors duration-200 hover:bg-secondary/25",
          isSelected && "bg-secondary/45",
          isDragging && "opacity-45 bg-secondary/50",
          (isDropBefore || isDropAfter) && "bg-primary/10",
        )}
      >
        {isDropBefore ? (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 top-0 z-10 h-0.5 bg-primary"
          />
        ) : null}
        {isDropAfter ? (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-0.5 bg-primary"
          />
        ) : null}

        <button
          type="button"
          data-testid={`task-drag-handle-${task.id}`}
          onKeyDown={(e) => handleHandleKeyDown(e, task, scopeTasks)}
          disabled={loading || isBusy}
          aria-label={`Reorder task ${task.title}. Drag or use Arrow Up and Arrow Down keys`}
          title="Drag to reorder (or press ↑ / ↓)"
          className="mt-0.5 flex h-4 w-4 shrink-0 touch-none cursor-grab items-center justify-center rounded text-muted-foreground/65 hover:bg-secondary/60 hover:text-foreground active:cursor-grabbing disabled:cursor-not-allowed disabled:opacity-40"
        >
          <GripVertical className="size-3" />
        </button>

        <div className="flex h-4 items-center pt-0.5">
          <TaskStatusCheckbox
            taskId={task.id}
            taskTitle={task.title}
            isDone={isDone}
            isBusy={isBusy}
            isBlocked={isBlocked}
            blockedBy={blockedBy}
            disabled={loading || isBusy || isBlocked}
            onToggle={() => onToggleTaskComplete(task)}
          />
        </div>

        <button
          type="button"
          onClick={() => {
            if (suppressClickRef.current) return;
            onSelectNode({ kind: "task", id: task.id });
          }}
          className="min-w-0 flex-1 text-left"
        >
          <div className="flex items-start justify-between gap-1.5">
            <p
              className={cn(
                "min-w-0 flex-1 text-xs leading-snug transition-colors duration-200",
                isDone ? "line-through text-muted-foreground" : "text-foreground",
              )}
            >
              {task.title}
            </p>
            <span
              data-testid={`task-priority-badge-${task.id}`}
              data-priority={priority}
              className={cn(
                "mt-0.5 rounded border px-1.5 py-0.5 font-mono text-[9.5px] font-medium uppercase leading-none tracking-wide whitespace-nowrap shrink-0",
                taskPriorityBadgeClass(priority),
              )}
            >
              {taskPriorityLabel(priority)}
            </span>
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 font-mono text-[10px]">
            <span className={cn("uppercase font-medium", toneTextClass(tone))}>
              {taskStatusLabel(task.status)}
            </span>
            <span className="text-muted-foreground">· {task.assignee}</span>
            {isBlocked ? (
              <span className="inline-flex items-center gap-0.5 text-warn">
                <Lock className="size-2.5" />
                <span>needs {blockedBy.join(", ")}</span>
              </span>
            ) : null}
          </div>
        </button>
      </li>
    );
  };

  return (
    <div
      data-testid="task-checklist"
      className="flex h-full min-h-0 flex-col bg-term/60"
    >
      <div className="flex flex-none items-center justify-between gap-1.5 border-b border-border/60 bg-card/40 px-2.5 py-1.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate font-mono text-[10px] font-semibold uppercase tracking-wider text-foreground">
            Tasks
          </span>
          <span className="font-mono text-[10px] text-muted-foreground tabular-nums whitespace-nowrap">
            <strong className="text-ok">{completedCount}</strong>/{totalCount}
            <span className="hidden xl:inline"> ({completionPct}%)</span>
          </span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            data-testid="task-list-mode-toggle"
            onClick={() => setViewMode((m) => (m === "grouped" ? "sequence" : "grouped"))}
            title={
              viewMode === "grouped"
                ? "Switch to flat Sequence view to drag tasks across all goals"
                : "Switch back to Goal-grouped view"
            }
            className={cn(
              "inline-flex h-5 items-center rounded border px-1.5 font-mono text-[9.5px] uppercase whitespace-nowrap shrink-0 transition-colors",
              viewMode === "sequence"
                ? "border-primary bg-primary/15 text-foreground"
                : "border-border bg-term text-muted-foreground hover:text-foreground",
            )}
          >
            {viewMode === "grouped" ? "Sequence" : "By Goal"}
          </button>
          <button
            type="button"
            data-testid="task-sort-priority-btn"
            disabled={loading || visibleTasks.length < 2}
            onClick={handleSortByPriority}
            title="Sort tasks High → Medium → Low and persist order"
            className="inline-flex h-5 items-center gap-1 rounded border border-border bg-term px-1.5 font-mono text-[9.5px] uppercase text-muted-foreground whitespace-nowrap shrink-0 hover:text-foreground disabled:opacity-45"
          >
            <ArrowUpDown className="size-2.5" />
            <span>Priority</span>
          </button>
        </div>
      </div>

      <div
        ref={scrollContainerRef}
        className="min-h-0 flex-1 space-y-2 overflow-auto p-2"
      >
        {visibleTasks.length === 0 ? (
          <p className="py-6 text-center font-mono text-xs text-muted-foreground">
            No tasks matching current scope.
          </p>
        ) : viewMode === "sequence" ? (
          <div className="rounded-md border border-border/80 bg-card/70">
            <div className="border-b border-border/50 px-2.5 py-1 font-mono text-[9.5px] uppercase text-muted-foreground">
              Drag to Reorder Sequence ({visibleTasks.length})
            </div>
            <ul data-testid="task-sequence-list" className="divide-y divide-border/40">
              {visibleTasks.map((t) => renderTaskRow(t, visibleTasks))}
            </ul>
          </div>
        ) : (
          <>
            {visibleGoals.map((goal) => {
              const goalTasks = visibleTasks.filter((t) => t.goalId === goal.id);
              if (goalTasks.length === 0 && goalFilter === "all") return null;
              const mission = goal.missionId ? missionById.get(goal.missionId) : undefined;
              const isGoalSelected = selectedNode?.kind === "goal" && selectedNode.id === goal.id;

              return (
                <div
                  key={goal.id}
                  className={cn(
                    "rounded-md border bg-card/70 transition-colors",
                    isGoalSelected ? "border-primary/70" : "border-border/80",
                  )}
                >
                  <button
                    type="button"
                    onClick={() => onSelectNode({ kind: "goal", id: goal.id })}
                    className="flex w-full items-center justify-between gap-2 border-b border-border/50 px-2.5 py-1 text-left hover:bg-secondary/30"
                  >
                    <div className="min-w-0 flex-1">
                      {mission ? (
                        <p className="truncate font-mono text-[9.5px] uppercase tracking-wide text-muted-foreground">
                          {mission.title}
                        </p>
                      ) : null}
                      <p className="truncate text-xs font-medium text-foreground">{goal.title}</p>
                    </div>
                    <span className="shrink-0 font-mono text-[10px] text-warn tabular-nums">
                      {goal.progress}%
                    </span>
                  </button>

                  <ul data-testid={`task-goal-list-${goal.id}`} className="divide-y divide-border/40">
                    {goalTasks.map((t) => renderTaskRow(t, goalTasks))}
                  </ul>
                </div>
              );
            })}

            {orphanTasks.length > 0 ? (
              <div className="rounded-md border border-border/80 bg-card/70">
                <div className="border-b border-border/50 px-2.5 py-1 font-mono text-[10px] uppercase text-muted-foreground">
                  Unassigned Goal Tasks
                </div>
                <ul className="divide-y divide-border/40">
                  {orphanTasks.map((t) => renderTaskRow(t, orphanTasks))}
                </ul>
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
