import { useState, type FormEvent } from "react";
import {
  ArrowDown,
  ArrowUp,
  Play,
  Plus,
  RefreshCw,
  Trash2,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatAgo, toneTextClass, workItemTone } from "@/lib/cletus/format";
import { useCletusStore } from "@/lib/cletus/store";
import { cn } from "@/lib/utils";
import { useMissionClock, useMissionField } from "./snapshot-context";
import { StatusDot } from "./status";

export function WorkQueuePanel() {
  const workQueue = useMissionField((s) => s.workQueue);
  const now = useMissionClock();
  const enqueueWork = useCletusStore((s) => s.enqueueWork);
  const controlWork = useCletusStore((s) => s.controlWork);
  const refresh = useCletusStore((s) => s.refresh);
  const loading = useCletusStore((s) => s.loading);
  const turnRunning = useCletusStore((s) => s.turnRunning);

  const [showEnqueue, setShowEnqueue] = useState(false);
  const [source, setSource] = useState("orchestrator");
  const [priority, setPriority] = useState(60);
  const [acceptancePredicate, setAcceptancePredicate] = useState("result.verified === true");
  const [spendBearing, setSpendBearing] = useState(false);
  const [payloadStr, setPayloadStr] = useState('{\n  "task": "synthesize_research_brief"\n}');
  const [payloadError, setPayloadError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const pendingCount = workQueue.filter((w) => w.status === "pending").length;
  const claimedCount = workQueue.filter((w) => w.status === "claimed").length;
  const completedCount = workQueue.filter((w) => w.status === "completed").length;
  const failedCount = workQueue.filter(
    (w) => w.status === "failed" || w.status === "expired",
  ).length;

  async function handleEnqueue(e: FormEvent) {
    e.preventDefault();
    setPayloadError(null);
    try {
      const parsed = JSON.parse(payloadStr);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        setPayloadError("Payload must be a JSON object.");
        return;
      }
    } catch {
      setPayloadError("Invalid JSON syntax in payload.");
      return;
    }

    await enqueueWork({
      source: source.trim() || "orchestrator",
      payloadStr,
      acceptancePredicate: acceptancePredicate.trim() || "result.verified === true",
      priority: Number(priority) || 0,
      spendBearing,
    });
    toast.success("Work item enqueued.");
    setShowEnqueue(false);
    setPayloadStr('{\n  "task": "synthesize_research_brief"\n}');
  }

  async function handleControl(
    id: string,
    action: "retry" | "fail" | "delete" | "reprioritize" | "execute",
    newPriority?: number,
  ) {
    const res = await controlWork(id, action, newPriority);
    if (action === "execute") {
      if (res.ok) toast.success(`Processed work item ${id}.`);
      else if (res.error) toast.error(res.error);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-none flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div className="min-w-0">
          <p className="text-xs font-medium text-foreground">Work Queue Control</p>
          <p className="font-mono text-[11px] text-muted-foreground tabular-nums">
            {pendingCount} pending · {claimedCount} claimed · {completedCount} done
            {failedCount > 0 ? ` · ${failedCount} failed` : ""}
          </p>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setShowEnqueue((v) => !v)}
            className="h-7 px-2.5 text-xs whitespace-nowrap shrink-0"
          >
            <Plus className="size-3.5" />
            <span>{showEnqueue ? "Cancel" : "Enqueue"}</span>
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={loading}
            onClick={() => void refresh()}
            aria-label="Refresh work queue"
            className="size-7"
          >
            <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
          </Button>
        </div>
      </div>

      {showEnqueue ? (
        <form
          onSubmit={handleEnqueue}
          className="flex-none space-y-2 border-b border-border bg-secondary/40 p-3 text-xs"
        >
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="mb-1 block font-mono text-[10px] uppercase text-muted-foreground">
                Source
              </label>
              <Input
                value={source}
                onChange={(e) => setSource(e.target.value)}
                className="h-7 bg-term text-xs"
                required
              />
            </div>
            <div>
              <label className="mb-1 block font-mono text-[10px] uppercase text-muted-foreground">
                Priority (0–1000)
              </label>
              <Input
                type="number"
                value={priority}
                onChange={(e) => setPriority(Number(e.target.value))}
                min={0}
                max={1000}
                className="h-7 bg-term text-xs tabular-nums"
              />
            </div>
          </div>

          <div>
            <label className="mb-1 block font-mono text-[10px] uppercase text-muted-foreground">
              Acceptance Predicate
            </label>
            <Input
              value={acceptancePredicate}
              onChange={(e) => setAcceptancePredicate(e.target.value)}
              className="h-7 bg-term font-mono text-xs"
              required
            />
          </div>

          <div>
            <div className="mb-1 flex items-center justify-between">
              <label className="font-mono text-[10px] uppercase text-muted-foreground">
                Payload (JSON)
              </label>
              <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-muted-foreground">
                <input
                  type="checkbox"
                  checked={spendBearing}
                  onChange={(e) => setSpendBearing(e.target.checked)}
                />
                <span>Spend-bearing</span>
              </label>
            </div>
            <textarea
              value={payloadStr}
              onChange={(e) => setPayloadStr(e.target.value)}
              rows={3}
              className="w-full rounded border border-border bg-term px-2.5 py-1.5 font-mono text-[11px] text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            />
            {payloadError ? (
              <p className="mt-1 font-mono text-[11px] text-destructive">{payloadError}</p>
            ) : null}
          </div>

          <div className="flex justify-end">
            <Button type="submit" size="sm" disabled={loading} className="h-7 text-xs">
              Enqueue Item
            </Button>
          </div>
        </form>
      ) : null}

      <div className="min-h-0 flex-1 divide-y divide-border/60 overflow-auto bg-term/60">
        {workQueue.length === 0 ? (
          <p className="py-10 text-center font-mono text-xs text-muted-foreground">
            Work queue is empty.
          </p>
        ) : (
          workQueue.map((item) => {
            const isExpanded = expandedId === item.id;
            const tone = workItemTone(item.status);
            return (
              <div key={item.id} className="px-3 py-2.5 text-xs hover:bg-secondary/20">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5 font-mono text-[11px]">
                      <StatusDot tone={tone} />
                      <span className={cn("uppercase font-medium", toneTextClass(tone))}>
                        {item.status}
                      </span>
                      <span className="text-muted-foreground">· {item.id}</span>
                      <span className="text-foreground">· [{item.source}]</span>
                      <span className="text-muted-foreground tabular-nums">P:{item.priority}</span>
                      {item.attempts > 0 ? (
                        <span className="text-muted-foreground tabular-nums">· try:{item.attempts}</span>
                      ) : null}
                      {item.missionId ? (
                        <span className="text-muted-foreground">· {item.missionId}</span>
                      ) : null}
                      {item.spendBearing ? <span className="text-warn">· $$$</span> : null}
                    </div>
                    <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
                      {String(item.payload.task ?? item.payload.directive ?? item.acceptancePredicate)}
                    </p>
                  </div>

                  <div className="flex items-center gap-0.5 shrink-0">
                    <span className="mr-1 font-mono text-[10px] text-muted-foreground tabular-nums">
                      {formatAgo(item.createdAt, now)}
                    </span>
                    {(item.status === "pending" || item.status === "failed") && (
                      <button
                        type="button"
                        disabled={turnRunning}
                        onClick={() => void handleControl(item.id, "execute")}
                        title="Execute via Agent Cycle"
                        className="flex size-6 items-center justify-center rounded text-ok hover:bg-secondary disabled:opacity-40"
                      >
                        <Play className="size-3" />
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={loading}
                      onClick={() =>
                        void handleControl(item.id, "reprioritize", item.priority + 10)
                      }
                      title="Increase Priority (+10)"
                      className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-secondary hover:text-foreground"
                    >
                      <ArrowUp className="size-3" />
                    </button>
                    <button
                      type="button"
                      disabled={loading}
                      onClick={() =>
                        void handleControl(
                          item.id,
                          "reprioritize",
                          Math.max(0, item.priority - 10),
                        )
                      }
                      title="Decrease Priority (-10)"
                      className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-secondary hover:text-foreground"
                    >
                      <ArrowDown className="size-3" />
                    </button>
                    {(item.status === "failed" ||
                      item.status === "expired" ||
                      item.status === "claimed") && (
                      <button
                        type="button"
                        disabled={loading}
                        onClick={() => void handleControl(item.id, "retry")}
                        title="Re-queue item"
                        className="flex size-6 items-center justify-center rounded text-warn hover:bg-secondary"
                      >
                        <RefreshCw className="size-3" />
                      </button>
                    )}
                    {(item.status === "pending" || item.status === "claimed") && (
                      <button
                        type="button"
                        disabled={loading}
                        onClick={() => void handleControl(item.id, "fail")}
                        title="Mark failed"
                        className="flex size-6 items-center justify-center rounded text-destructive hover:bg-secondary"
                      >
                        <XCircle className="size-3" />
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={loading}
                      onClick={() => void handleControl(item.id, "delete")}
                      title="Delete item"
                      className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-secondary hover:text-destructive"
                    >
                      <Trash2 className="size-3" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setExpandedId(isExpanded ? null : item.id)}
                      className="ml-1 rounded px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground hover:bg-secondary hover:text-foreground"
                    >
                      {isExpanded ? "Hide" : "JSON"}
                    </button>
                  </div>
                </div>

                {isExpanded ? (
                  <div className="mt-2 space-y-1.5 rounded border border-border bg-card p-2 font-mono text-[11px]">
                    <p className="text-muted-foreground">
                      predicate: <span className="text-foreground">{item.acceptancePredicate}</span>{" "}
                      · attempts: {item.attempts}
                    </p>
                    {item.error ? <p className="text-destructive">error: {item.error}</p> : null}
                    <pre className="overflow-x-auto text-[10px] text-foreground/90 whitespace-pre-wrap">
                      {JSON.stringify(item.payload, null, 2)}
                    </pre>
                    {item.result ? (
                      <pre className="overflow-x-auto text-[10px] text-ok whitespace-pre-wrap">
                        {item.result}
                      </pre>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
