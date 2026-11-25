import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

interface TaskStatusCheckboxProps {
  taskId: string;
  taskTitle: string;
  isDone: boolean;
  isBusy: boolean;
  isBlocked: boolean;
  blockedBy: string[];
  disabled: boolean;
  onToggle: () => void;
  onCompletedAnimationStart?: () => void;
}

export function TaskStatusCheckbox({
  taskId,
  taskTitle,
  isDone,
  isBusy,
  isBlocked,
  blockedBy,
  disabled,
  onToggle,
  onCompletedAnimationStart,
}: TaskStatusCheckboxProps) {
  const [justCompleted, setJustCompleted] = useState(false);
  const prevDoneRef = useRef(isDone);
  const onCompletedRef = useRef(onCompletedAnimationStart);
  onCompletedRef.current = onCompletedAnimationStart;

  useEffect(() => {
    const wasDone = prevDoneRef.current;
    prevDoneRef.current = isDone;

    if (!wasDone && isDone) {
      setJustCompleted(true);
      onCompletedRef.current?.();
      const timer = window.setTimeout(() => setJustCompleted(false), 540);
      return () => window.clearTimeout(timer);
    }

    if (!isDone) {
      setJustCompleted(false);
    }
  }, [isDone]);

  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={isDone}
      aria-busy={isBusy || undefined}
      data-testid={`task-checkbox-${taskId}`}
      data-completed={isDone ? "true" : "false"}
      data-animating={justCompleted ? "true" : "false"}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      aria-label={`Mark task ${taskTitle} completed`}
      title={
        isBlocked
          ? `Blocked until ${blockedBy.join(", ")} completes`
          : isDone
            ? "Mark task assigned (reopen)"
            : "Mark task completed in database"
      }
      className={cn(
        "group relative flex size-4 shrink-0 items-center justify-center rounded-[4px] border transition-[background-color,border-color,transform,box-shadow] duration-200 ease-out",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-card",
        "disabled:cursor-not-allowed",
        isDone
          ? "border-ok bg-ok text-primary-foreground shadow-[0_0_0_1px_rgba(126,163,122,0.38)]"
          : isBlocked
            ? "border-border/60 bg-term/60 text-transparent opacity-45"
            : "border-border bg-term text-transparent hover:border-ok/80 hover:bg-ok/12 active:scale-90",
        justCompleted && "task-check-pop",
      )}
    >
      {justCompleted ? (
        <span
          aria-hidden="true"
          data-testid={`task-checkbox-ring-${taskId}`}
          className="task-check-ring pointer-events-none absolute -inset-0.5 rounded-[5px] border border-ok/85"
        />
      ) : null}

      <svg
        aria-hidden="true"
        viewBox="0 0 12 12"
        fill="none"
        className="pointer-events-none size-3"
      >
        <path
          d="M2.4 6.2L4.9 8.7L9.6 3.5"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          data-checked={isDone ? "true" : "false"}
          className={cn("task-check-stroke", isDone ? "opacity-100" : "opacity-0")}
        />
      </svg>
    </button>
  );
}
