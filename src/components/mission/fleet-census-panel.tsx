import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  childStatusLabel,
  childTone,
  formatAgo,
  formatCents,
  peerTone,
  toneTextClass,
} from "@/lib/cletus/format";
import { useCletusStore } from "@/lib/cletus/store";
import { cn } from "@/lib/utils";
import { useMissionClock, useMissionField } from "./snapshot-context";
import { StatusDot } from "./status";

export function FleetCensusPanel() {
  const children = useMissionField((s) => s.children);
  const peers = useMissionField((s) => s.peers);
  const now = useMissionClock();
  const pingWorker = useCletusStore((s) => s.pingWorker);
  const setSelectedNode = useCletusStore((s) => s.setSelectedNode);
  const loading = useCletusStore((s) => s.loading);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-auto bg-term/60">
      <div className="flex flex-none items-center justify-between border-b border-border bg-card px-3 py-2">
        <p className="text-xs font-medium text-foreground">
          Agent Mesh ({children.length})
        </p>
        <span className="font-mono text-[11px] text-muted-foreground">
          Local + OpenClaw specialists
        </span>
      </div>

      <div className="divide-y divide-border/60">
        {children.map((w) => {
          const tone = childTone(w.status);
          return (
            <div
              key={w.id}
              onClick={() => setSelectedNode({ kind: "worker", id: w.id })}
              className="cursor-pointer px-3 py-2.5 text-xs hover:bg-secondary/25"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <StatusDot tone={tone} />
                  <span className="font-medium text-foreground truncate">{w.name}</span>
                  <span className={cn("font-mono text-[10px] uppercase", toneTextClass(tone))}>
                    {childStatusLabel(w.status)}
                  </span>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={loading}
                  onClick={(e) => {
                    e.stopPropagation();
                    void pingWorker(w.id);
                  }}
                  className="h-6 px-2 text-[10px] whitespace-nowrap shrink-0"
                >
                  <RefreshCw className="size-3" />
                  <span>Probe</span>
                </Button>
              </div>
              <p className="mt-1 font-mono text-[11px] text-muted-foreground tabular-nums">
                {w.role} · {w.latencyMs ? `${w.latencyMs}ms` : "—"} ·{" "}
                {w.fundedCents ? formatCents(w.fundedCents) : "$0.00"} ·{" "}
                {formatAgo(now - w.lastBeatAgoMs, now)}
              </p>
              {w.task ? <p className="mt-1 text-foreground/90">{w.task}</p> : null}
              {w.errorNote ? (
                <p className="mt-1 font-mono text-[11px] text-destructive">{w.errorNote}</p>
              ) : null}
            </div>
          );
        })}
      </div>

      <div className="flex flex-none items-center justify-between border-y border-border bg-card px-3 py-2">
        <p className="text-xs font-medium text-foreground">External Intelligence Feeds ({peers.length})</p>
        <span className="font-mono text-[11px] text-muted-foreground">Live API connectors</span>
      </div>

      <div className="divide-y divide-border/60">
        {peers.map((p) => {
          const tone = peerTone(p.status);
          return (
            <div key={p.id} className="px-3 py-2.5 text-xs">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <StatusDot tone={tone} />
                  <span className="font-medium text-foreground truncate">{p.name}</span>
                  <span className="font-mono text-[11px] text-muted-foreground">{p.handle}</span>
                </div>
                <span className={cn("font-mono text-[10px] uppercase", toneTextClass(tone))}>
                  {p.claimed ? "connected" : "pending"}
                </span>
              </div>
              <p className="mt-1 text-muted-foreground">{p.note}</p>
              <p className="mt-1 font-mono text-[10px] text-muted-foreground tabular-nums">
                queries {p.posts} · {formatAgo(now - p.lastAgoMs, now)}
              </p>
            </div>
          );
        })}
      </div>
    </div>
  );
}
