import { useEffect, useRef, useState, type FormEvent } from "react";
import { AlertTriangle, CheckCircle2, CornerDownLeft, Cpu, Loader2, Mic, Rocket, Square, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { pickRecorderMimeType, prepareAudioBlobForAsr } from "@/lib/cletus/browser-audio";
import { getDomainPack } from "@/lib/cletus/domains";
import { formatAgo } from "@/lib/cletus/format";
import { transcribeAudioServer } from "@/lib/cletus/server";
import { useCletusStore } from "@/lib/cletus/store";
import { cn } from "@/lib/utils";
import { MicLevelIndicator, useMicAudioLevel } from "./mic-level-indicator";
import { useMissionClock, useMissionField } from "./snapshot-context";

type CommandMode = "mission" | "directive";

export function DecreeBar() {
  const [mode, setMode] = useState<CommandMode>("mission");
  const [text, setText] = useState("");
  const [enableLoopOnLaunch, setEnableLoopOnLaunch] = useState(false);
  const launchMission = useCletusStore((s) => s.launchMission);
  const issueDecree = useCletusStore((s) => s.issueDecree);
  const controlMission = useCletusStore((s) => s.controlMission);
  const runEvolutionStep = useCletusStore((s) => s.runEvolutionStep);
  const turnRunning = useCletusStore((s) => s.turnRunning);
  const loading = useCletusStore((s) => s.loading);
  const turnError = useCletusStore((s) => s.turnError);
  const clearTurnError = useCletusStore((s) => s.clearTurnError);
  const applySnapshot = useCletusStore((s) => s.applySnapshot);
  const envReadiness = useMissionField((s) => s.envReadiness);
  const nvidiaConfigured = useMissionField((s) => s.nvidiaConfigured);
  const missions = useMissionField((s) => s.missions);
  const tasks = useMissionField((s) => s.tasks);
  const vitals = useMissionField((s) => s.vitals);
  const activeDomain = useMissionField((s) => s.activeDomain);
  const evolutionSummary = useMissionField((s) => s.evolutionSummary);
  const domainPack = getDomainPack(activeDomain);
  const now = useMissionClock();

  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [micStream, setMicStream] = useState<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const micLevel = useMicAudioLevel(micStream, recording);

  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  async function toggleDictation() {
    if (transcribing || turnRunning) return;
    if (recording) {
      recorderRef.current?.stop();
      setRecording(false);
      return;
    }
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      toast.error("Microphone capture unavailable in this browser.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      setMicStream(stream);
      const mimeType = pickRecorderMimeType();
      const recorder = new MediaRecorder(stream, { mimeType });
      chunksRef.current = [];
      recorder.ondataavailable = (ev) => {
        if (ev.data.size > 0) chunksRef.current.push(ev.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        setMicStream(null);
        const blob = new Blob(chunksRef.current, { type: mimeType });
        chunksRef.current = [];
        if (blob.size < 100) return;
        void (async () => {
          setTranscribing(true);
          try {
            const prepared = await prepareAudioBlobForAsr(blob, mimeType);
            const res = await transcribeAudioServer({ data: prepared });
            applySnapshot(res.snapshot);
            if (res.ok && res.text) {
              setText((prev) => (prev.trim() ? `${prev.trim()} ${res.text}` : res.text));
              toast.success("Dictated via nvidia/parakeet-ctc-1.1b-asr.");
            } else if (res.error) {
              toast.error(res.error);
            }
          } catch (err) {
            toast.error(err instanceof Error ? err.message : String(err));
          } finally {
            setTranscribing(false);
          }
        })();
      };
      recorderRef.current = recorder;
      recorder.start();
      setRecording(true);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Microphone permission denied.");
    }
  }

  const activeMission =
    missions.find((m) => m.id === vitals.activeMissionId) ?? missions[0];

  const missionTasks = activeMission
    ? tasks.some((t) => t.missionId === activeMission.id)
      ? tasks.filter((t) => t.missionId === activeMission.id)
      : tasks
    : [];
  const missionDoneCount = missionTasks.filter((t) => t.status === "completed").length;
  const missionPct =
    missionTasks.length > 0 ? Math.round((missionDoneCount / missionTasks.length) * 100) : 0;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = text.trim();
    if (!trimmed || turnRunning) return;
    setText("");

    if (mode === "mission") {
      const res = await launchMission({
        objective: trimmed,
        autoLoop: enableLoopOnLaunch,
      });
      if (res.ok) {
        toast.success("Mission decomposed: Goals, DAG tasks, tools & handoffs persisted.");
      } else if (res.error) {
        toast.error(res.error);
      }
    } else {
      const res = await issueDecree(trimmed);
      if (res.ok) {
        toast.success("Directive processed by Orchestrator-Prime.");
      } else if (res.error) {
        toast.error(res.error);
      }
    }
  }

  return (
    <section className="border-b border-border bg-card/90 px-4 py-2.5">
      <div className="mx-auto flex max-w-[1800px] flex-col gap-2">
        <form onSubmit={onSubmit} className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="flex items-center rounded border border-border bg-term p-0.5 shrink-0">
            <button
              type="button"
              onClick={() => setMode("mission")}
              className={cn(
                "h-7 rounded px-2.5 font-mono text-[11px] font-medium whitespace-nowrap transition-colors",
                mode === "mission"
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              Mission Plan
            </button>
            <button
              type="button"
              onClick={() => setMode("directive")}
              className={cn(
                "h-7 rounded px-2.5 font-mono text-[11px] font-medium whitespace-nowrap transition-colors",
                mode === "directive"
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              Directive
            </button>
          </div>

          <div className="relative flex flex-1 items-center">
            <span
              aria-hidden="true"
              className="pointer-events-none absolute left-3 font-mono text-xs text-warn"
            >
              &gt;
            </span>
            <Input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={
                mode === "mission"
                  ? `[${domainPack.shortLabel}] ${domainPack.decreeExamples[0] ?? "Enter a domain mission objective…"}`
                  : `[${domainPack.shortLabel}] Send direct supreme operator directive to Orchestrator-Prime…`
              }
              aria-label="Mission or operator directive input"
              disabled={turnRunning}
              className="h-9 flex-1 bg-term pl-7 pr-3 font-mono text-xs placeholder:text-muted-foreground/70"
            />
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <Button
              type="button"
              variant={recording ? "destructive" : "outline"}
              size="icon-sm"
              disabled={turnRunning || transcribing}
              onClick={() => void toggleDictation()}
              aria-label={recording ? "Stop directive dictation" : "Dictate mission or directive"}
              className={cn("size-9 shrink-0", recording && "mic-listening-ring")}
            >
              {transcribing ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : recording ? (
                <Square className="size-3" />
              ) : (
                <Mic className="size-3.5" />
              )}
            </Button>

            {recording ? <MicLevelIndicator active level={micLevel} compact /> : null}

            {mode === "mission" ? (
              <label className="hidden md:flex cursor-pointer items-center gap-1.5 font-mono text-[11px] text-muted-foreground whitespace-nowrap">
                <input
                  type="checkbox"
                  checked={enableLoopOnLaunch}
                  onChange={(e) => setEnableLoopOnLaunch(e.target.checked)}
                />
                <span>Auto-Loop</span>
              </label>
            ) : null}

            <Button
              type="submit"
              size="sm"
              disabled={turnRunning || !text.trim()}
              className="h-9 whitespace-nowrap shrink-0 px-3.5"
            >
              {turnRunning ? (
                <>
                  <Loader2 className="size-3.5 animate-spin" />
                  <span>Executing Cycle</span>
                </>
              ) : mode === "mission" ? (
                <>
                  <Rocket className="size-3.5" />
                  <span>Launch Mission</span>
                </>
              ) : (
                <>
                  <CornerDownLeft className="size-3.5" />
                  <span>Dispatch</span>
                </>
              )}
            </Button>
          </div>
        </form>

        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {evolutionSummary.isIdle ? (
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1 rounded border border-ok/35 bg-ok/10 px-1.5 py-0.5 font-mono text-[10px] font-medium text-ok whitespace-nowrap shrink-0">
                <Cpu className="size-2.5" />
                <span>Idle · Self-Evolution Ready</span>
              </span>
              <p className="min-w-0 truncate text-xs text-foreground/90">
                Next: <span className="font-medium">{evolutionSummary.nextTrajectoryTitle}</span>{" "}
                <span className="font-mono text-[11px] text-muted-foreground">
                  via {evolutionSummary.nextActorName} · maturity {evolutionSummary.overallMaturity}/100
                </span>
              </p>
              <button
                type="button"
                disabled={turnRunning || !nvidiaConfigured}
                onClick={() => {
                  void runEvolutionStep(evolutionSummary.nextTrajectorySlug, 1).then((res) => {
                    if (res.ok) {
                      toast.success(`${res.actorName ?? "Specialist"} completed Self-Evolution cycle.`);
                    } else if (res.error) {
                      toast.error(res.error);
                    }
                  });
                }}
                className="rounded border border-ok/40 bg-ok/10 px-2 py-0.5 font-mono text-[10px] text-ok hover:bg-ok/20 disabled:opacity-50 whitespace-nowrap shrink-0"
              >
                Evolve
              </button>
              {activeMission?.status === "halted" ? (
                <button
                  type="button"
                  disabled={turnRunning || loading}
                  onClick={() => void controlMission(activeMission.id, "resume", 6)}
                  className="rounded border border-warn/40 bg-warn/10 px-1.5 py-0.5 font-mono text-[10px] text-warn hover:bg-warn/20 whitespace-nowrap shrink-0"
                >
                  Resume {activeMission.id} (+6)
                </button>
              ) : null}
            </div>
          ) : activeMission ? (
            <div className="flex min-w-0 items-center gap-2">
              <p className="min-w-0 truncate">
                <span className="font-mono uppercase tracking-wider text-[11px] text-muted-foreground/80">
                  Active Mission
                </span>{" "}
                <span className="text-foreground font-medium">{activeMission.title}</span>
                <span className="font-mono tabular-nums">
                  {" "}
                  · {activeMission.id} · {activeMission.status} · {missionDoneCount}/{missionTasks.length} tasks ({missionPct}%) ·{" "}
                  {activeMission.cycleCount}/{activeMission.maxCycles} cycles · {formatAgo(activeMission.updatedAt, now)}
                </span>
              </p>
              {activeMission.status === "active" || activeMission.status === "planning" ? (
                <button
                  type="button"
                  disabled={turnRunning || loading}
                  onClick={() => {
                    void controlMission(activeMission.id, "complete").then((res) => {
                      if (res.ok) {
                        toast.success(`Completed ${activeMission.id} — Cletus entered idle Self-Evolution.`);
                      } else if (res.error) {
                        toast.error(res.error);
                      }
                    });
                  }}
                  aria-label={`Complete mission ${activeMission.id}`}
                  className="inline-flex items-center gap-1 rounded border border-border bg-term px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground hover:border-ok/40 hover:text-ok whitespace-nowrap shrink-0"
                >
                  <CheckCircle2 className="size-2.5" />
                  <span>Complete</span>
                </button>
              ) : null}
              {activeMission.status === "halted" ? (
                <button
                  type="button"
                  disabled={turnRunning || loading}
                  onClick={() => void controlMission(activeMission.id, "resume", 6)}
                  className="rounded border border-warn/40 bg-warn/10 px-1.5 py-0.5 font-mono text-[10px] text-warn hover:bg-warn/20 whitespace-nowrap shrink-0"
                >
                  Resume (+6)
                </button>
              ) : null}
            </div>
          ) : (
            <p className="font-mono text-[11px] text-muted-foreground">
              Autonomous MAS planning channel ready.
            </p>
          )}
          <span className="font-mono text-[11px] break-words sm:whitespace-nowrap tabular-nums">
            Env: NVIDIA_API_KEY={envReadiness.nvidiaConfigured ? "ready" : "missing"} · DB=
            {envReadiness.databaseBackend} · GITHUB_TOKEN=
            {envReadiness.githubTokenConfigured ? "set" : "public"}
          </span>
        </div>

        {turnError ? (
          <div
            role="alert"
            className="flex items-start justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
          >
            <div className="flex items-start gap-2 min-w-0">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              <p className="min-w-0 break-words">{turnError}</p>
            </div>
            <button
              type="button"
              onClick={clearTurnError}
              aria-label="Dismiss error"
              className="shrink-0 rounded p-0.5 text-destructive/80 hover:bg-destructive/20 hover:text-destructive"
            >
              <X className="size-3.5" />
            </button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
