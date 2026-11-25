import { useEffect, useState } from "react";
import { computeNormalizedRmsLevel } from "@/lib/cletus/browser-audio";
import { cn } from "@/lib/utils";

/**
 * Samples live microphone input levels and exposes the active Web Audio AnalyserNode
 * so frequency-based D3 waveforms can react to real-time mic spectra.
 */
export function useMicAudioTelemetry(
  stream: MediaStream | null,
  active: boolean,
  muted = false,
): { level: number; analyser: AnalyserNode | null } {
  const [level, setLevel] = useState(0);
  const [analyserNode, setAnalyserNode] = useState<AnalyserNode | null>(null);

  useEffect(() => {
    if (!active || muted || !stream || typeof window === "undefined") {
      setLevel(0);
      setAnalyserNode(null);
      return;
    }

    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) {
      setLevel(0.18);
      setAnalyserNode(null);
      return;
    }

    let disposed = false;
    let rafId = 0;
    const ctx = new AudioCtx();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.68;

    let source: MediaStreamAudioSourceNode | null = null;
    try {
      source = ctx.createMediaStreamSource(stream);
      source.connect(analyser);
      setAnalyserNode(analyser);
    } catch {
      void ctx.close().catch(() => undefined);
      setLevel(0);
      setAnalyserNode(null);
      return;
    }

    if (ctx.state === "suspended") {
      void ctx.resume().catch(() => undefined);
    }

    const samples = new Uint8Array(analyser.fftSize);
    let lastEmit = 0;

    const tick = (ts: number) => {
      if (disposed) return;
      if (ts - lastEmit >= 45) {
        analyser.getByteTimeDomainData(samples);
        const rms = computeNormalizedRmsLevel(samples, true);
        setLevel((prev) => Number((prev * 0.35 + rms * 0.65).toFixed(3)));
        lastEmit = ts;
      }
      rafId = window.requestAnimationFrame(tick);
    };

    rafId = window.requestAnimationFrame(tick);

    return () => {
      disposed = true;
      window.cancelAnimationFrame(rafId);
      setAnalyserNode(null);
      try {
        source?.disconnect();
        analyser.disconnect();
      } catch {
        // Ignore cleanup disconnection errors
      }
      void ctx.close().catch(() => undefined);
      setLevel(0);
    };
  }, [stream, active, muted]);

  return { level, analyser: analyserNode };
}

/**
 * Samples live microphone input levels from an active MediaStream via Web Audio AnalyserNode.
 */
export function useMicAudioLevel(
  stream: MediaStream | null,
  active: boolean,
  muted = false,
): number {
  return useMicAudioTelemetry(stream, active, muted).level;
}

const BAR_FACTORS = [0.46, 0.78, 1.0, 0.72, 0.42];

export function MicLevelIndicator({
  active,
  level,
  muted = false,
  compact = false,
  label,
  className,
}: {
  active: boolean;
  level: number;
  muted?: boolean;
  compact?: boolean;
  label?: string;
  className?: string;
}) {
  const listening = active && !muted;
  const clamped = Math.max(0, Math.min(1, level));

  return (
    <div
      data-testid="mic-level-indicator"
      data-listening={listening ? "true" : "false"}
      data-audio-level={clamped.toFixed(2)}
      role="status"
      aria-live="off"
      aria-label={
        listening
          ? `Microphone listening, input level ${Math.round(clamped * 100)} percent`
          : muted
            ? "Microphone muted"
            : "Microphone standby"
      }
      className={cn(
        "inline-flex items-center gap-1.5 rounded border px-2 py-0.5 font-mono text-[10px] select-none transition-colors",
        listening
          ? "border-destructive/50 bg-destructive/10 text-foreground"
          : muted
            ? "border-warn/40 bg-warn/10 text-warn"
            : "border-border bg-term text-muted-foreground",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "size-2 shrink-0 rounded-full transition-colors",
          listening
            ? "bg-destructive mic-listening-ring"
            : muted
              ? "bg-warn"
              : "bg-muted-foreground/50",
        )}
      />

      <span
        aria-hidden="true"
        className={cn("inline-flex items-end gap-[2px]", compact ? "h-3" : "h-3.5")}
      >
        {BAR_FACTORS.map((factor, idx) => {
          const minHeight = compact ? 3 : 4;
          const maxExtra = compact ? 9 : 11;
          const barPx = listening
            ? Math.round(minHeight + Math.max(0.14, clamped) * factor * maxExtra)
            : minHeight;
          return (
            <span
              key={idx}
              style={{ height: `${barPx}px` }}
              className={cn(
                "w-[2.5px] rounded-xs transition-[height] duration-75",
                listening
                  ? clamped > 0.65
                    ? "bg-warn"
                    : "bg-ok"
                  : "bg-muted-foreground/35",
              )}
            />
          );
        })}
      </span>

      {!compact ? (
        <span className="whitespace-nowrap tabular-nums">
          {label ?? (listening ? "Listening" : muted ? "Muted" : "Standby")}
        </span>
      ) : null}
    </div>
  );
}
