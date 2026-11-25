import { useState } from "react";
import {
  Activity,
  CheckCircle2,
  Cpu,
  GitBranch,
  Pause,
  Play,
  RefreshCw,
  Rocket,
  Zap,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { getDomainPack } from "@/lib/cletus/domains";
import { formatAgo } from "@/lib/cletus/format";
import { useCletusStore } from "@/lib/cletus/store";
import type { EvolutionActionKind, EvolutionHorizon, EvolutionTrajectorySlug } from "@/lib/cletus/types";
import { cn } from "@/lib/utils";
import { useMissionClock, useMissionField } from "./snapshot-context";
import { StatusDot } from "./status";

const HORIZON_ORDER: EvolutionHorizon[] = ["seed", "explore", "synthesize", "benchmark", "mastered"];

function horizonClass(horizon: EvolutionHorizon): string {
  switch (horizon) {
    case "mastered":
      return "border-ok/40 bg-ok/15 text-ok";
    case "benchmark":
      return "border-primary/40 bg-primary/15 text-primary";
    case "synthesize":
      return "border-warn/40 bg-warn/15 text-warn";
    case "explore":
      return "border-border bg-secondary text-foreground";
    default:
      return "border-border bg-term text-muted-foreground";
  }
}

function actionLabel(kind: EvolutionActionKind): string {
  switch (kind) {
    case "research_discovery":
      return "RESEARCH";
    case "tool_synthesized":
      return "FORGED";
    case "tool_benchmarked":
      return "BENCHMARKED";
    case "agent_upgraded":
      return "MESH TUNED";
    case "memory_distilled":
      return "MEMORY";
    case "resilience_hardened":
      return "RESILIENCE";
  }
}

export function EvolutionPanel() {
  const trajectories = useMissionField((s) => s.evolutionTrajectories);
  const events = useMissionField((s) => s.evolutionEvents);
  const summary = useMissionField((s) => s.evolutionSummary);
  const activeDomain = useMissionField((s) => s.activeDomain);
  const nvidiaConfigured = useMissionField((s) => s.nvidiaConfigured);
  const now = useMissionClock();

  const runEvolutionStep = useCletusStore((s) => s.runEvolutionStep);
  const spawnEvolutionMission = useCletusStore((s) => s.spawnEvolutionMission);
  const toggleEvolutionTrajectory = useCletusStore((s) => s.toggleEvolutionTrajectory);
  const runHeartbeatSweep = useCletusStore((s) => s.runHeartbeatSweep);
  const loading = useCletusStore((s) => s.loading);
  const turnRunning = useCletusStore((s) => s.turnRunning);

  const [pulsing, setPulsing] = useState(false);
  const domainPack = getDomainPack(activeDomain);

  async function handleEvolve(slug?: EvolutionTrajectorySlug, steps = 1) {
    const res = await runEvolutionStep(slug, steps);
    if (res.ok) {
      toast.success(
        `${res.actorName ?? "Specialist"} completed ${res.cyclesExecuted ?? steps} Self-Evolution step(s).`,
      );
    } else if (res.error) {
      toast.error(res.error);
    }
  }

  async function handleSpawnMission(slug: EvolutionTrajectorySlug) {
    const res = await spawnEvolutionMission(slug);
    if (res.ok) {
      toast.success(`Launched Self-Evolution Growth DAG (${res.missionId ?? "active"}).`);
    } else if (res.error) {
      toast.error(res.error);
    }
  }

  async function handlePulse() {
    setPulsing(true);
    try {
      const res = await runHeartbeatSweep(true);
      if (res.ok) {
        toast.success(`Evolution gap recalibration & heartbeat sweep complete (${res.executed?.length ?? 0} cadences).`);
      } else if (res.error) {
        toast.error(res.error);
      }
    } finally {
      setPulsing(false);
    }
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto bg-term/60 p-3 space-y-3 text-xs">
      {/* Top Autonomous Growth Status Banner */}
      <section className="rounded-md border border-border bg-card p-3 space-y-2.5">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex flex-wrap items-center gap-2 font-mono text-[11px]">
              <StatusDot tone={summary.isIdle ? "ok" : "warn"} />
              <span className={cn("font-semibold uppercase", summary.isIdle ? "text-ok" : "text-warn")}>
                {summary.isIdle ? "IDLE → SELF-EVOLUTION DEFAULT ARMED" : "MISSION ACTIVE · EVOLUTION STANDBY"}
              </span>
              <span className="text-muted-foreground">· {domainPack.shortLabel}</span>
            </div>
            <p className="text-foreground/90">{summary.idleReason}</p>
            <p className="font-mono text-[11px] text-muted-foreground">
              Next trajectory: <span className="text-foreground">{summary.nextTrajectoryTitle}</span> via{" "}
              <span className="text-warn">{summary.nextActorName}</span>
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-1.5 shrink-0">
            <Button
              type="button"
              size="sm"
              disabled={turnRunning || !nvidiaConfigured}
              onClick={() => void handleEvolve(undefined, 1)}
              className="h-7 px-2.5 text-[11px] whitespace-nowrap shrink-0"
            >
              <Cpu className="size-3" />
              <span>Evolve Now (1 Step)</span>
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={turnRunning || !nvidiaConfigured}
              onClick={() => void handleEvolve(undefined, 2)}
              className="h-7 px-2.5 text-[11px] whitespace-nowrap shrink-0"
            >
              <Zap className="size-3" />
              <span>2-Step Burst</span>
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={loading || pulsing}
              onClick={() => void handlePulse()}
              className="h-7 px-2.5 text-[11px] whitespace-nowrap shrink-0"
            >
              <RefreshCw className={cn("size-3", pulsing && "animate-spin")} />
              <span>Pulse Gap Check</span>
            </Button>
          </div>
        </div>

        {/* Summary Metrics & Capability Gap Counters */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 font-mono text-[11px] tabular-nums">
          <div className="rounded border border-border/70 bg-term px-2.5 py-1.5">
            <span className="block text-[10px] uppercase text-muted-foreground">Overall Maturity</span>
            <span className="text-sm font-semibold text-foreground">{summary.overallMaturity}/100</span>
          </div>
          <div className="rounded border border-border/70 bg-term px-2.5 py-1.5">
            <span className="block text-[10px] uppercase text-muted-foreground">Capabilities Unlocked</span>
            <span className="text-sm font-semibold text-ok">{summary.capabilitiesUnlockedCount}</span>
          </div>
          <div className="rounded border border-border/70 bg-term px-2.5 py-1.5">
            <span className="block text-[10px] uppercase text-muted-foreground">Self-Evo Cycles</span>
            <span className="text-sm font-semibold text-foreground">{summary.selfEvolutionCyclesCount}</span>
          </div>
          <div className="rounded border border-border/70 bg-term px-2.5 py-1.5">
            <span className="block text-[10px] uppercase text-muted-foreground">Domain Memories</span>
            <span className="text-sm font-semibold text-foreground">{summary.gaps.domainMemoryCount}</span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded border border-border/60 bg-term px-2.5 py-1.5 font-mono text-[10px] text-muted-foreground tabular-nums">
          <span>
            Missing Domain Tools:{" "}
            <strong className={summary.gaps.missingDomainCapabilities.length > 0 ? "text-warn" : "text-ok"}>
              {summary.gaps.missingDomainCapabilities.length > 0
                ? summary.gaps.missingDomainCapabilities.join(", ")
                : "none"}
            </strong>
          </span>
          <span>
            Untested Tools:{" "}
            <strong className={summary.gaps.untestedTools.length > 0 ? "text-warn" : "text-ok"}>
              {summary.gaps.untestedTools.length}
            </strong>
          </span>
          <span>
            Unbound Tools:{" "}
            <strong className={summary.gaps.unboundTools.length > 0 ? "text-warn" : "text-ok"}>
              {summary.gaps.unboundTools.length}
            </strong>
          </span>
          <span>
            Faults / Denials:{" "}
            <strong className={summary.gaps.recentFaultCount > 0 ? "text-destructive" : "text-foreground"}>
              {summary.gaps.recentFaultCount} / {summary.gaps.recentDenialCount}
            </strong>
          </span>
        </div>
      </section>

      {/* 5 Growth Trajectories */}
      <section className="space-y-2">
        <div className="flex items-center justify-between px-0.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
          <span>Autonomous Growth Trajectories ({trajectories.length})</span>
          <span>Horizon: Seed → Explore → Synthesize → Benchmark → Mastered</span>
        </div>

        <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2">
          {trajectories.map((tr) => {
            const isRecommended = summary.nextTrajectorySlug === tr.slug;
            const isPaused = tr.status === "paused";
            const stageIdx = HORIZON_ORDER.indexOf(tr.horizon);

            return (
              <div
                key={tr.id}
                className={cn(
                  "flex flex-col justify-between rounded-md border bg-card p-3 space-y-2.5 transition-colors",
                  isRecommended && !isPaused ? "border-primary/60" : "border-border",
                  isPaused && "opacity-75",
                )}
              >
                <div className="space-y-1.5">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-semibold text-foreground">{tr.title}</span>
                        {isRecommended && !isPaused ? (
                          <span className="rounded border border-ok/40 bg-ok/15 px-1.5 py-0.5 font-mono text-[9px] uppercase text-ok">
                            NEXT
                          </span>
                        ) : null}
                      </div>
                      <p className="font-mono text-[10px] text-muted-foreground">
                        {tr.slug} · weight {tr.priorityWeight} · {tr.cyclesCompleted} cycles
                      </p>
                    </div>
                    <span
                      className={cn(
                        "rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase shrink-0",
                        horizonClass(tr.horizon),
                      )}
                    >
                      {tr.horizon}
                    </span>
                  </div>

                  <div className="space-y-1">
                    <div className="flex items-center justify-between font-mono text-[10px] tabular-nums">
                      <span className="text-muted-foreground truncate">
                        Target: <span className="text-foreground">{tr.targetCapability}</span>
                      </span>
                      <span className="font-medium text-foreground shrink-0">{tr.maturityScore}/100</span>
                    </div>
                    <Progress value={tr.maturityScore} />
                    <div className="grid grid-cols-5 gap-1 pt-0.5">
                      {HORIZON_ORDER.map((stage, idx) => (
                        <div
                          key={stage}
                          className={cn(
                            "h-1 rounded-full",
                            idx <= stageIdx ? "bg-primary/80" : "bg-secondary",
                          )}
                          title={stage}
                        />
                      ))}
                    </div>
                  </div>

                  {tr.lastOutcome ? (
                    <p className="line-clamp-2 text-[11px] text-muted-foreground">{tr.lastOutcome}</p>
                  ) : null}
                </div>

                <div className="flex flex-wrap items-center justify-between gap-1.5 border-t border-border/60 pt-2">
                  <button
                    type="button"
                    disabled={loading}
                    onClick={() => void toggleEvolutionTrajectory(tr.slug)}
                    aria-label={`${isPaused ? "Activate" : "Pause"} trajectory ${tr.title}`}
                    className={cn(
                      "inline-flex h-6 items-center gap-1 rounded border px-2 font-mono text-[10px] whitespace-nowrap shrink-0 transition-colors",
                      isPaused
                        ? "border-warn/40 bg-warn/10 text-warn hover:bg-warn/20"
                        : "border-border bg-term text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {isPaused ? <Play className="size-2.5" /> : <Pause className="size-2.5" />}
                    <span>{isPaused ? "Paused → Activate" : "Active → Pause"}</span>
                  </button>

                  <div className="flex items-center gap-1.5">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={turnRunning || !nvidiaConfigured}
                      onClick={() => void handleEvolve(tr.slug, 1)}
                      className="h-6 px-2 font-mono text-[10px] whitespace-nowrap shrink-0"
                    >
                      <Activity className="size-2.5" />
                      <span>Evolve Step</span>
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={loading || turnRunning}
                      onClick={() => void handleSpawnMission(tr.slug)}
                      className="h-6 px-2 font-mono text-[10px] whitespace-nowrap shrink-0"
                    >
                      <Rocket className="size-2.5" />
                      <span>Spawn Growth DAG</span>
                    </Button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Verified Evolution Ledger */}
      <section className="rounded-md border border-border bg-card">
        <div className="flex items-center justify-between border-b border-border px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
          <span>Verified Self-Evolution Ledger ({events.length})</span>
          <span className="inline-flex items-center gap-1 text-ok">
            <GitBranch className="size-3" />
            <span>Persistent Trajectory Audit</span>
          </span>
        </div>

        {events.length === 0 ? (
          <p className="p-4 text-center font-mono text-[11px] text-muted-foreground">
            No evolution milestones logged yet. Trigger &ldquo;Evolve Now&rdquo; or let Auto-Loop enter idle Self-Evolution.
          </p>
        ) : (
          <div className="divide-y divide-border/60">
            {events.slice(0, 15).map((ev) => (
              <div key={ev.id} className="px-3 py-2 space-y-1 hover:bg-secondary/20">
                <div className="flex flex-wrap items-center justify-between gap-2 font-mono text-[10px]">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="inline-flex items-center gap-1 rounded border border-ok/40 bg-ok/15 px-1.5 py-0.5 text-ok">
                      <CheckCircle2 className="size-2.5" />
                      <span>{actionLabel(ev.actionKind)}</span>
                    </span>
                    <span className="font-semibold text-foreground">{ev.agentName}</span>
                    <span className="text-muted-foreground">· {ev.trajectorySlug}</span>
                    {ev.capabilityGained ? (
                      <span className="text-warn">· +{ev.capabilityGained}</span>
                    ) : null}
                  </div>
                  <span className="text-muted-foreground tabular-nums">
                    +{ev.maturityDelta} mat · {formatAgo(ev.createdAt, now)}
                  </span>
                </div>
                <p className="text-[11px] text-foreground/90">{ev.summary}</p>
                {ev.artifactRef ? (
                  <p className="font-mono text-[10px] text-muted-foreground">ref: {ev.artifactRef}</p>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
