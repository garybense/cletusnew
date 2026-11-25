import { useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import { formatAgo, formatClock } from "@/lib/cletus/format";
import type { LogLevel } from "@/lib/cletus/types";
import { cn } from "@/lib/utils";
import { useMissionClock, useMissionField } from "./snapshot-context";

type TerminalTab = "logs" | "thoughts";
type Filter = "all" | "tool" | "thought" | "err";

const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: "all", label: "All" },
  { id: "tool", label: "Tools" },
  { id: "thought", label: "Thoughts" },
  { id: "err", label: "Errors" },
];

function matches(level: LogLevel, filter: Filter): boolean {
  if (filter === "all") return true;
  if (filter === "tool") return level === "tool";
  if (filter === "thought") return level === "thought";
  return level === "error" || level === "warn";
}

function lineClass(level: LogLevel): string {
  if (level === "error") return "text-destructive";
  if (level === "warn") return "text-warn";
  if (level === "thought") return "text-ok";
  if (level === "tool") return "text-foreground";
  return "text-muted-foreground";
}

export function LogsPanel() {
  const logs = useMissionField((s) => s.logs);
  const thoughts = useMissionField((s) => s.thoughts);
  const now = useMissionClock();
  const [tab, setTab] = useState<TerminalTab>("logs");
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [autoscroll, setAutoscroll] = useState(true);
  const [expandedThoughtId, setExpandedThoughtId] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return logs
      .filter((l) => {
        if (!matches(l.level, filter)) return false;
        if (!q) return true;
        return (
          l.message.toLowerCase().includes(q) ||
          l.source.toLowerCase().includes(q) ||
          l.level.toLowerCase().includes(q)
        );
      })
      .slice()
      .reverse();
  }, [logs, filter, query]);

  useEffect(() => {
    if (tab !== "logs" || !autoscroll) return;
    const el = scroller.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [filtered, autoscroll, tab]);

  return (
    <section className="flex h-full min-h-[220px] flex-col overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex flex-none flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setTab("logs")}
            className={cn(
              "h-7 rounded px-2.5 text-xs font-medium whitespace-nowrap shrink-0 transition-colors",
              tab === "logs"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-secondary hover:text-foreground",
            )}
          >
            Activity Log ({logs.length})
          </button>
          <button
            type="button"
            onClick={() => setTab("thoughts")}
            className={cn(
              "h-7 rounded px-2.5 text-xs font-medium whitespace-nowrap shrink-0 transition-colors",
              tab === "thoughts"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-secondary hover:text-foreground",
            )}
          >
            Thought Trace ({thoughts.length})
          </button>
        </div>

        {tab === "logs" ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Filter logs…"
                aria-label="Filter logs"
                className="h-7 w-32 rounded border border-border bg-term pl-6 pr-2 font-mono text-[11px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring sm:w-40"
              />
            </div>
            <div className="flex items-center gap-1">
              {FILTERS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => setFilter(f.id)}
                  className={cn(
                    "h-7 rounded px-2 text-[11px] font-medium whitespace-nowrap shrink-0 transition-colors",
                    filter === f.id
                      ? "bg-secondary text-foreground ring-1 ring-border"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {f.label}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setAutoscroll((v) => !v)}
              className={cn(
                "h-7 rounded border border-border px-2 font-mono text-[11px] whitespace-nowrap shrink-0 transition-colors",
                autoscroll ? "bg-secondary text-foreground" : "bg-transparent text-muted-foreground",
              )}
            >
              Follow {autoscroll ? "on" : "off"}
            </button>
          </div>
        ) : (
          <span className="font-mono text-[11px] text-muted-foreground">
            Click a turn to expand full reasoning
          </span>
        )}
      </div>

      {tab === "logs" ? (
        <div
          ref={scroller}
          className="min-h-0 flex-1 overflow-auto bg-term px-3 py-2 font-mono text-xs leading-relaxed"
          role="log"
          aria-live="polite"
          aria-relevant="additions"
        >
          {filtered.length === 0 ? (
            <p className="py-4 text-muted-foreground">No log lines match the active filter.</p>
          ) : (
            filtered.map((line) => (
              <div
                key={line.id}
                className={cn(
                  "grid grid-cols-[4.5rem_3.75rem_6.25rem_minmax(0,1fr)] gap-x-2 py-0.5",
                  lineClass(line.level),
                )}
              >
                <span className="text-muted-foreground tabular-nums">{formatClock(line.at)}</span>
                <span className="uppercase opacity-75">{line.level}</span>
                <span className="truncate opacity-75">{line.source}</span>
                <span className="min-w-0 break-words">{line.message}</span>
              </div>
            ))
          )}
        </div>
      ) : (
        <div className="min-h-0 flex-1 divide-y divide-border/60 overflow-auto bg-term px-3 py-1">
          {thoughts.length === 0 ? (
            <p className="py-6 text-center font-mono text-xs text-muted-foreground">
              No reasoning turns recorded yet.
            </p>
          ) : (
            thoughts.map((t) => {
              const isOpen = expandedThoughtId === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setExpandedThoughtId(isOpen ? null : t.id)}
                  className="flex w-full flex-col gap-1 py-2.5 text-left transition-colors hover:bg-secondary/20"
                >
                  <div className="flex items-center justify-between gap-2 font-mono text-[11px]">
                    <span className="text-ok">turn/{t.id.slice(-6)}</span>
                    <span className="text-muted-foreground tabular-nums">
                      {formatAgo(t.at, now)}
                      {t.tools.length > 0 ? ` · ${t.tools.join(" · ")}` : ""}
                    </span>
                  </div>
                  <p className={cn("text-xs text-foreground", !isOpen && "line-clamp-2")}>
                    {t.thinking}
                  </p>
                  {t.speech && isOpen ? (
                    <p className="mt-1 border-l-2 border-ok/50 pl-2 text-xs italic text-muted-foreground">
                      “{t.speech}”
                    </p>
                  ) : null}
                </button>
              );
            })
          )}
        </div>
      )}
    </section>
  );
}
