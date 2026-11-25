import { useEffect, useState } from "react";
import {
  FastForward,
  Loader2,
  Moon,
  Pause,
  Play,
  RefreshCw,
  Repeat,
  Sun,
  Zap,
} from "lucide-react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { Toaster, toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { getDomainPack } from "@/lib/cletus/domains";
import {
  agentTone,
  formatCents,
  formatCredits,
  formatUptime,
  stateLabel,
  tierLabel,
  tierTone,
  toneTextClass,
} from "@/lib/cletus/format";
import { useCletusStore } from "@/lib/cletus/store";
import type { CletusSnapshot } from "@/lib/cletus/types";
import { cn } from "@/lib/utils";
import { AgentBusPanel } from "./agent-bus-panel";
import { DecreeBar } from "./decree-bar";
import { DialoguePanel } from "./dialogue-panel";
import { LogsPanel } from "./logs-panel";
import { NvidiaChatPanel } from "./nvidia-chat-panel";
import { PolicySpendPanel } from "./policy-spend-panel";
import { InitialSnapshotContext, useMissionClock, useMissionField } from "./snapshot-context";
import { StatusDot } from "./status";
import { TaskGraphPanel } from "./task-graph-panel";
import { FleetStreamProvider } from "./use-fleet-status-stream";
import { VoiceLivePanel } from "./voice-live-panel";
import { WorkQueuePanel } from "./work-queue-panel";

type RightTab = "dialogue" | "chat" | "voice" | "bus" | "queue" | "policy";

function shortAddr(addr: string): string {
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}

function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = useState(true);

  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    setIsDesktop(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setIsDesktop(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  return isDesktop;
}

export function MissionDashboard({
  initialSnapshot,
}: {
  initialSnapshot?: CletusSnapshot;
}) {
  return (
    <InitialSnapshotContext.Provider value={initialSnapshot ?? null}>
      <FleetStreamProvider>
        <MissionWorkspace initialSnapshot={initialSnapshot} />
      </FleetStreamProvider>
    </InitialSnapshotContext.Provider>
  );
}

function MissionWorkspace({
  initialSnapshot,
}: {
  initialSnapshot?: CletusSnapshot;
}) {
  const isDesktop = useIsDesktop();
  const paused = useMissionField((s) => s.paused);
  const vitals = useMissionField((s) => s.vitals);
  const activeDomain = useMissionField((s) => s.activeDomain);
  const tasks = useMissionField((s) => s.tasks);
  const workQueue = useMissionField((s) => s.workQueue);
  const agentMessages = useMissionField((s) => s.agentMessages);
  const alerts = useMissionField((s) => s.alerts);
  const now = useMissionClock();

  const togglePaused = useCletusStore((s) => s.togglePaused);
  const toggleSleep = useCletusStore((s) => s.toggleSleep);
  const toggleAutoLoop = useCletusStore((s) => s.toggleAutoLoop);
  const runTurn = useCletusStore((s) => s.runTurn);
  const refresh = useCletusStore((s) => s.refresh);
  const loading = useCletusStore((s) => s.loading);
  const turnRunning = useCletusStore((s) => s.turnRunning);

  const [rightTab, setRightTab] = useState<RightTab>("dialogue");

  useEffect(() => {
    void useCletusStore.getState().hydrate(initialSnapshot);

    const clockId = window.setInterval(() => {
      useCletusStore.getState().tickClock();
    }, 5_000);

    const pollId = window.setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      if (typeof navigator !== "undefined" && navigator.onLine === false) return;
      const s = useCletusStore.getState();
      if (s.paused || s.turnRunning || s.loading) return;
      if (
        s.vitals.autoLoop &&
        s.vitals.state === "running" &&
        s.nvidiaConfigured &&
        s.vitals.tier !== "dead" &&
        s.vitals.tier !== "critical"
      ) {
        void s.runTurn({ steps: 1 });
      } else {
        void s.refresh({ silent: true });
      }
    }, 9_000);

    return () => {
      window.clearInterval(clockId);
      window.clearInterval(pollId);
    };
  }, [initialSnapshot]);

  const activeTasks = tasks.filter(
    (t) => t.status === "running" || t.status === "assigned",
  ).length;
  const pendingQueue = workQueue.filter(
    (w) => w.status === "pending" || w.status === "claimed",
  ).length;
  const pendingHandoffs = agentMessages.filter((m) => m.status === "pending").length;

  async function handleRunTurn(steps: number) {
    const res = await runTurn({ steps });
    if (res.ok) {
      toast.success(
        steps > 1
          ? `Executed ${res.cyclesExecuted ?? steps} multi-agent handoff cycles.`
          : res.mode === "self_evolution"
            ? `${res.actorName ?? "Agent"} advanced Self-Evolution cycle${res.handoffTo ? ` → handed off to ${res.handoffTo}` : ""}.`
            : `${res.actorName ?? "Agent"} completed cycle${res.handoffTo ? ` → handed off to ${res.handoffTo}` : ""}.`,
      );
    } else if (res.error) {
      toast.error(res.error);
    }
  }

  const rightRailContent = (
    <section className="flex h-full min-h-[380px] flex-col overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex flex-none items-center gap-1 border-b border-border px-2 py-2 overflow-x-auto">
        {(
          [
            { id: "dialogue", label: "Bridge" },
            { id: "chat", label: "NVIDIA Chat" },
            { id: "voice", label: "Voice Live" },
            { id: "bus", label: `Bus (${pendingHandoffs})` },
            { id: "queue", label: `Queue (${pendingQueue})` },
            { id: "policy", label: "Policy" },
          ] as Array<{ id: RightTab; label: string }>
        ).map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setRightTab(tab.id)}
            className={cn(
              "h-7 rounded px-2 text-[11px] font-medium whitespace-nowrap shrink-0 tabular-nums transition-colors",
              rightTab === tab.id
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-secondary hover:text-foreground",
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {rightTab === "dialogue" ? (
          <DialoguePanel onOpenVoiceLive={() => setRightTab("voice")} />
        ) : null}
        {rightTab === "chat" ? <NvidiaChatPanel /> : null}
        {rightTab === "voice" ? <VoiceLivePanel /> : null}
        {rightTab === "bus" ? <AgentBusPanel /> : null}
        {rightTab === "queue" ? <WorkQueuePanel /> : null}
        {rightTab === "policy" ? <PolicySpendPanel /> : null}
      </div>
    </section>
  );

  return (
    <TooltipProvider delayDuration={200}>
      <div
        id="mission-root"
        className="flex min-h-dvh flex-col overflow-x-hidden bg-background text-foreground lg:h-dvh lg:overflow-hidden"
      >
        {/* 3-Zone Top Command Bar */}
        <header className="flex-none border-b border-border bg-card/95 px-3 py-2 sm:px-4">
          <div className="mx-auto flex max-w-[1800px] flex-wrap items-center justify-between gap-2 xl:flex-nowrap">
            {/* Zone 1: Brand + Sigil */}
            <div className="flex min-w-0 max-w-full items-center gap-2.5">
              <span className="flex size-7 shrink-0 items-center justify-center rounded bg-primary font-mono text-xs font-semibold text-primary-foreground">
                C
              </span>
              <div className="min-w-0 leading-tight">
                <p className="text-sm font-semibold tracking-tight text-foreground truncate">
                  Cletus Mission Control
                </p>
                <p className="font-mono text-[11px] text-muted-foreground truncate">
                  {vitals.sigil} · {getDomainPack(activeDomain).shortLabel} · {vitals.model}
                </p>
              </div>
            </div>

            {/* Zone 2: Inline Telemetry Strip */}
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px] tabular-nums text-muted-foreground">
              <span className="inline-flex items-center gap-1.5 text-foreground whitespace-nowrap">
                <StatusDot tone={paused ? "mute" : agentTone(vitals.state)} />
                <span>{paused ? "Paused" : stateLabel(vitals.state)}</span>
              </span>
              <span>·</span>
              <span className="whitespace-nowrap">
                Credits{" "}
                <strong className={cn("font-medium", toneTextClass(tierTone(vitals.tier)))}>
                  {formatCredits(vitals.creditsCents)}
                </strong>{" "}
                ({tierLabel(vitals.tier)}
                {vitals.creditsSyntheticOverride ? " · gov" : ""})
              </span>
              <span className="hidden sm:inline">·</span>
              <span className="hidden sm:inline whitespace-nowrap">
                USDC <strong className="font-medium text-foreground">{formatCents(vitals.usdcCents)}</strong>
              </span>
              <span className="hidden md:inline">·</span>
              <span className="hidden md:inline whitespace-nowrap">
                Turns <strong className="font-medium text-foreground">{vitals.turns}</strong>
              </span>
              <span className="hidden 2xl:inline">·</span>
              <span className="hidden 2xl:inline whitespace-nowrap">
                <strong className="font-medium text-foreground">{activeTasks}</strong> tasks ·{" "}
                <strong className="font-medium text-foreground">{pendingHandoffs}</strong> handoffs
              </span>
              <span className="hidden 2xl:inline">·</span>
              <span className="hidden 2xl:inline whitespace-nowrap">
                Uptime {formatUptime(vitals.startedAt, now)} · Root {shortAddr(vitals.creator)}
              </span>
            </div>

            {/* Zone 3: Operator Actions */}
            <div className="flex flex-wrap items-center gap-1.5 sm:shrink-0">
              <Button
                type="button"
                size="sm"
                disabled={turnRunning}
                onClick={() => void handleRunTurn(1)}
                className="h-8 whitespace-nowrap shrink-0 px-3 text-xs"
              >
                {turnRunning ? (
                  <>
                    <Loader2 className="size-3.5 animate-spin" />
                    <span>Running</span>
                  </>
                ) : (
                  <>
                    <Zap className="size-3.5" />
                    <span>Step Cycle</span>
                  </>
                )}
              </Button>

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={turnRunning}
                    onClick={() => void handleRunTurn(3)}
                    className="h-8 whitespace-nowrap shrink-0 px-2.5 text-xs"
                  >
                    <FastForward className="size-3.5" />
                    <span className="hidden sm:inline">3-Step Mesh</span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Execute 3 consecutive cross-agent handoff turns</TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant={vitals.autoLoop ? "default" : "outline"}
                    size="sm"
                    disabled={loading}
                    onClick={() => void toggleAutoLoop()}
                    className={cn(
                      "h-8 whitespace-nowrap shrink-0 px-2.5 text-xs",
                      vitals.autoLoop && "bg-ok text-black hover:bg-ok/90",
                    )}
                  >
                    <Repeat className="size-3.5" />
                    <span>{vitals.autoLoop ? "Loop ON" : "Auto-Loop"}</span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {vitals.autoLoop
                    ? "Continuous autonomous multi-agent loop active (click to stop)"
                    : "Enable continuous autonomous cycle execution"}
                </TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon-sm"
                    disabled={loading}
                    onClick={() => void toggleSleep()}
                    aria-label={vitals.state === "sleeping" ? "Wake Cletus" : "Sleep 30m"}
                    className="size-8"
                  >
                    {vitals.state === "sleeping" ? <Sun className="size-3.5" /> : <Moon className="size-3.5" />}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{vitals.state === "sleeping" ? "Wake Runtime" : "Sleep 30m"}</TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon-sm"
                    disabled={loading}
                    onClick={() => void togglePaused()}
                    aria-label={paused ? "Resume polling" : "Pause polling"}
                    className="size-8"
                  >
                    {paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{paused ? "Resume polling" : "Pause polling"}</TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon-sm"
                    disabled={loading}
                    onClick={() => void refresh()}
                    aria-label="Refresh state from database"
                    className="size-8"
                  >
                    <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Refresh snapshot</TooltipContent>
              </Tooltip>
            </div>
          </div>
        </header>

        {/* Mission Command Strip */}
        <DecreeBar />

        {/* Slim Alert Banner */}
        {alerts.length > 0 ? (
          <div className="flex-none border-b border-border bg-secondary/30 px-4 py-1.5">
            <div className="mx-auto flex max-w-[1800px] flex-wrap items-center gap-x-5 gap-y-1 font-mono text-[11px]">
              {alerts.map((a) => (
                <span key={a.id} className="inline-flex items-center gap-1.5 text-muted-foreground">
                  <StatusDot
                    tone={a.severity === "crit" ? "crit" : a.severity === "warn" ? "warn" : "ok"}
                  />
                  <strong className="font-medium text-foreground">{a.title}:</strong>
                  <span>{a.detail}</span>
                </span>
              ))}
            </div>
          </div>
        ) : null}

        {isDesktop ? (
          /* Desktop Split-Pane Terminal & Live Graph Layout */
          <main className="mx-auto flex min-h-0 w-full max-w-[1800px] flex-1 p-3">
            <Group orientation="horizontal" className="min-h-0 flex-1">
              <Panel defaultSize="62%" minSize="38%">
                <Group orientation="vertical" className="h-full min-h-0">
                  <Panel defaultSize="60%" minSize="30%">
                    <TaskGraphPanel />
                  </Panel>
                  <Separator className="my-1.5 h-1 rounded-full bg-border/60 transition-colors hover:bg-primary/50" />
                  <Panel defaultSize="40%" minSize="22%">
                    <LogsPanel />
                  </Panel>
                </Group>
              </Panel>

              <Separator className="mx-1.5 w-1 rounded-full bg-border/60 transition-colors hover:bg-primary/50" />

              <Panel defaultSize="38%" minSize="26%">
                {rightRailContent}
              </Panel>
            </Group>
          </main>
        ) : (
          /* Mobile / Tablet Responsive Stack */
          <main className="flex flex-1 flex-col gap-3 p-3">
            <div className="min-h-[640px] h-[720px]">
              <TaskGraphPanel />
            </div>
            <div className="h-[460px]">{rightRailContent}</div>
            <div className="h-[320px]">
              <LogsPanel />
            </div>
          </main>
        )}

        <Toaster
          theme="dark"
          position="bottom-center"
          toastOptions={{ className: "bg-card text-card-foreground border-border" }}
        />
      </div>
    </TooltipProvider>
  );
}
