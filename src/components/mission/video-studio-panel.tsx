import { useEffect, useState, type FormEvent } from "react";
import { AlertTriangle, Download, Film, Loader2, Play } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { formatAgo } from "@/lib/cletus/format";
import { generateVideoServer, getVideoHistoryServer } from "@/lib/cletus/server";
import { useCletusStore } from "@/lib/cletus/store";
import type { NvidiaVideoJob, VideoAspectRatio, VideoDuration } from "@/lib/cletus/types";
import { cn } from "@/lib/utils";
import { useMissionClock } from "./snapshot-context";

const VIDEO_PROMPTS = [
  "Tracking cinematic shot through a dark autonomous robotics operations bay with volumetric amber data telemetry screens.",
  "Vertical macro shot of rain droplets gliding down neon-lit glass in a rain-soaked Tokyo alley at night.",
];

export function VideoStudioPanel() {
  const applySnapshot = useCletusStore((s) => s.applySnapshot);
  const now = useMissionClock();

  const [prompt, setPrompt] = useState("");
  const [aspectRatio, setAspectRatio] = useState<VideoAspectRatio>("16:9");
  const [duration, setDuration] = useState<VideoDuration>("8s");
  const [generating, setGenerating] = useState(false);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [jobs, setJobs] = useState<NvidiaVideoJob[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const res = await getVideoHistoryServer();
        if (active) {
          setJobs(res.jobs);
          const firstReady = res.jobs.find((j) => j.status === "completed") ?? res.jobs[0];
          if (firstReady) setSelectedJobId(firstReady.id);
        }
      } catch {
        // Non-fatal history read failure
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!generating) {
      setElapsedSec(0);
      return;
    }
    const id = window.setInterval(() => setElapsedSec((s) => s + 1), 1000);
    return () => window.clearInterval(id);
  }, [generating]);

  const activeJob = jobs.find((j) => j.id === selectedJobId) ?? jobs[0] ?? null;

  async function handleGenerate(e: FormEvent) {
    e.preventDefault();
    const trimmed = prompt.trim();
    if (trimmed.length < 3 || generating) return;
    setGenerating(true);
    setErrorMsg(null);

    try {
      const res = await generateVideoServer({
        data: {
          prompt: trimmed,
          aspectRatio,
          duration,
        },
      });
      setJobs(res.jobs);
      setSelectedJobId(res.job.id);
      applySnapshot(res.snapshot);
      if (res.ok) {
        toast.success(`Generated ${aspectRatio} (${duration}) video via stabilityai/stable-video-diffusion.`);
      } else if (res.error) {
        setErrorMsg(res.error);
        toast.error(res.error);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorMsg(msg);
      toast.error(msg);
    } finally {
      setGenerating(false);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-term/60">
      {/* Generation Controls */}
      <form
        onSubmit={handleGenerate}
        className="flex-none space-y-2 border-b border-border bg-secondary/25 p-3 text-xs"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1 rounded border border-border bg-term p-0.5">
              {(["16:9", "9:16"] as VideoAspectRatio[]).map((ratio) => (
                <button
                  key={ratio}
                  type="button"
                  onClick={() => setAspectRatio(ratio)}
                  className={cn(
                    "h-7 rounded px-2.5 font-mono text-[11px] whitespace-nowrap shrink-0 transition-colors",
                    aspectRatio === ratio
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {ratio === "16:9" ? "16:9 Landscape" : "9:16 Portrait"}
                </button>
              ))}
            </div>

            <select
              aria-label="Select video duration"
              value={duration}
              onChange={(e) => setDuration(e.target.value as VideoDuration)}
              className="h-7 rounded border border-border bg-term px-2 font-mono text-[11px] text-foreground"
            >
              <option value="5s">Duration: 5s</option>
              <option value="8s">Duration: 8s</option>
              <option value="10s">Duration: 10s</option>
            </select>
          </div>

          <span className="font-mono text-[10px] text-muted-foreground">
            Model: stabilityai/stable-video-diffusion · NVIDIA Video NIM
          </span>
        </div>

        <div className="flex items-start gap-2">
          <textarea
            aria-label="Text-to-video prompt"
            rows={2}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Describe scene, motion, lighting, and camera framing for NVIDIA Video NIM…"
            disabled={generating}
            className="min-h-[54px] flex-1 resize-none rounded border border-border bg-term px-2.5 py-1.5 font-mono text-xs text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-ring"
          />
          <Button
            type="submit"
            size="sm"
            disabled={generating || prompt.trim().length < 3}
            className="h-9 whitespace-nowrap shrink-0 px-3"
          >
            {generating ? (
              <>
                <Loader2 className="size-3.5 animate-spin" />
                <span className="tabular-nums">Rendering ({elapsedSec}s)</span>
              </>
            ) : (
              <>
                <Play className="size-3.5" />
                <span>Generate Video</span>
              </>
            )}
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-1.5 font-mono text-[10px] text-muted-foreground">
          <span>Presets:</span>
          {VIDEO_PROMPTS.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setPrompt(p)}
              className="rounded border border-border bg-term px-2 py-0.5 text-left text-muted-foreground hover:border-primary/40 hover:text-foreground"
            >
              {p.length > 52 ? `${p.slice(0, 51)}…` : p}
            </button>
          ))}
        </div>
      </form>

      {/* Player & History */}
      <div className="min-h-0 flex-1 overflow-auto p-3 space-y-3">
        {errorMsg ? (
          <div
            role="alert"
            className="flex items-start gap-2 rounded border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive"
          >
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <p className="min-w-0 break-words">{errorMsg}</p>
          </div>
        ) : null}

        {activeJob && activeJob.status === "completed" && activeJob.videoDataUrl ? (
          <div className="rounded border border-border bg-card p-3 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2 font-mono text-[11px]">
              <span className="text-ok font-medium">
                {activeJob.aspectRatio} · {activeJob.duration} · {activeJob.mimeType}
              </span>
              <div className="flex items-center gap-2">
                {activeJob.interactionId ? (
                  <span className="text-muted-foreground">id: {activeJob.interactionId}</span>
                ) : null}
                <a
                  href={activeJob.videoDataUrl}
                  download={`cletus-${activeJob.id}.mp4`}
                  className="inline-flex items-center gap-1 rounded border border-border bg-term px-2 py-0.5 text-foreground hover:border-primary/50"
                >
                  <Download className="size-3" />
                  <span>Download</span>
                </a>
              </div>
            </div>

            <div className="flex justify-center rounded border border-border/60 bg-black/80 p-2">
              <video
                key={activeJob.id}
                src={activeJob.videoDataUrl}
                controls
                playsInline
                className={cn(
                  "rounded bg-black",
                  activeJob.aspectRatio === "9:16"
                    ? "aspect-[9/16] max-h-[300px] w-auto"
                    : "aspect-video max-h-[300px] w-full max-w-[540px]",
                )}
              />
            </div>

            <p className="text-xs text-muted-foreground">{activeJob.prompt}</p>
          </div>
        ) : (
          <div className="flex min-h-[140px] flex-col items-center justify-center gap-1.5 rounded border border-dashed border-border/80 bg-card/40 p-4 text-center">
            <Film className="size-5 text-muted-foreground" />
            <p className="text-xs font-medium text-foreground">
              Video Studio · stabilityai/stable-video-diffusion
            </p>
            <p className="max-w-md text-[11px] text-muted-foreground">
              Generate landscape (<span className="font-mono text-foreground">16:9</span>) or
              portrait (<span className="font-mono text-foreground">9:16</span>) video clips via the
              NVIDIA Video NIM API.
            </p>
          </div>
        )}

        {jobs.length > 0 ? (
          <div className="space-y-1.5">
            <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              Recent Generations ({jobs.length})
            </p>
            <div className="divide-y divide-border/60 rounded border border-border bg-card">
              {jobs.map((job) => (
                <button
                  key={job.id}
                  type="button"
                  onClick={() => setSelectedJobId(job.id)}
                  className={cn(
                    "flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-xs transition-colors hover:bg-secondary/30",
                    activeJob?.id === job.id && "bg-secondary/40",
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium text-foreground">{job.prompt}</p>
                    <p className="truncate font-mono text-[10px] text-muted-foreground">
                      {job.aspectRatio} · {job.duration} ·{" "}
                      <span className={job.status === "completed" ? "text-ok" : "text-destructive"}>
                        {job.status}
                      </span>
                      {job.error ? ` — ${job.error}` : ""}
                    </p>
                  </div>
                  <span className="font-mono text-[10px] text-muted-foreground tabular-nums shrink-0">
                    {formatAgo(job.createdAt, now)}
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
