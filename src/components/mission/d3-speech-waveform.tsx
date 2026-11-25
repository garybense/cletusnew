import { useEffect, useRef, useState, type MutableRefObject } from "react";
import * as d3 from "d3";
import {
  computeWaveformMetrics,
  downsampleFrequencyBins,
  smoothBandFrame,
  synthesizeSpeechCadenceBands,
} from "@/lib/cletus/speech-waveform";
import { cn } from "@/lib/utils";

export interface SpeechBoundarySignal {
  atMs: number;
  charIndex: number;
}

interface D3SpeechWaveformProps {
  variant?: "badge" | "stage";
  speaking?: boolean;
  active?: boolean;
  tone?: "ok" | "warn" | "crit" | "mute";
  analyser?: AnalyserNode | null;
  analyserRef?: MutableRefObject<AnalyserNode | null>;
  boundarySignalRef?: MutableRefObject<SpeechBoundarySignal>;
  label?: string;
  sublabel?: string;
  className?: string;
  "data-testid"?: string;
}

const TONE_COLORS = {
  ok: {
    primary: "#7ea37a",
    secondary: "#6ea8c7",
    peak: "#c4a574",
    idle: "#4a5363",
  },
  warn: {
    primary: "#c4a574",
    secondary: "#7ea37a",
    peak: "#d7dbe3",
    idle: "#5b5548",
  },
  crit: {
    primary: "#c46a55",
    secondary: "#c4a574",
    peak: "#f7f1ea",
    idle: "#5a3c36",
  },
  mute: {
    primary: "#6ea8c7",
    secondary: "#7ea37a",
    peak: "#c4a574",
    idle: "#3e4554",
  },
} as const;

const audioAnalyserCache = new WeakMap<
  HTMLAudioElement,
  { ctx: AudioContext; analyser: AnalyserNode }
>();

/**
 * Attach (or reuse) a Web Audio AnalyserNode for an HTML <audio> element so D3 waveforms
 * react to real WAV briefing playback without re-attaching MediaElementAudioSourceNode.
 */
export function ensureMediaElementAnalyser(audioEl: HTMLAudioElement | null): AnalyserNode | null {
  if (!audioEl || typeof window === "undefined") return null;
  const cached = audioAnalyserCache.get(audioEl);
  if (cached) {
    if (cached.ctx.state === "suspended") {
      void cached.ctx.resume().catch(() => undefined);
    }
    return cached.analyser;
  }
  const AudioCtx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtx) return null;

  try {
    const ctx = new AudioCtx();
    const source = ctx.createMediaElementSource(audioEl);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.72;
    source.connect(analyser);
    analyser.connect(ctx.destination);
    audioAnalyserCache.set(audioEl, { ctx, analyser });
    return analyser;
  } catch {
    return null;
  }
}

export function D3SpeechWaveform({
  variant = "stage",
  speaking = false,
  active = false,
  tone = "ok",
  analyser = null,
  analyserRef,
  boundarySignalRef,
  label,
  sublabel,
  className,
  "data-testid": dataTestId,
}: D3SpeechWaveformProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const badgeContainerRef = useRef<HTMLSpanElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const peakReadoutRef = useRef<HTMLSpanElement | null>(null);
  const statusTextRef = useRef<HTMLSpanElement | null>(null);

  const isStage = variant === "stage";
  const bandCount = isStage ? 28 : 7;
  const svgHeight = isStage ? 44 : 18;
  const defaultWidth = isStage ? 420 : 38;

  const [svgWidth, setSvgWidth] = useState(defaultWidth);
  const bandsRef = useRef<number[]>(new Array<number>(bandCount).fill(0));
  const speechStartedAtRef = useRef<number>(0);
  const frameCounterRef = useRef<number>(0);

  const effectiveActive = speaking || active;

  useEffect(() => {
    if (!isStage) return;
    const el = containerRef.current;
    if (!el) return;

    const updateWidth = () => {
      const rectW = Math.floor(el.getBoundingClientRect().width);
      if (rectW >= 140) {
        setSvgWidth(rectW - 2);
      }
    };

    updateWidth();
    const observer =
      typeof ResizeObserver !== "undefined" ? new ResizeObserver(updateWidth) : null;
    observer?.observe(el);
    return () => observer?.disconnect();
  }, [isStage]);

  useEffect(() => {
    if (speaking && speechStartedAtRef.current === 0) {
      speechStartedAtRef.current = performance.now();
    } else if (!speaking) {
      speechStartedAtRef.current = 0;
    }
  }, [speaking]);

  useEffect(() => {
    const svgEl = svgRef.current;
    if (!svgEl) return;

    const palette = TONE_COLORS[tone];
    const width = Math.max(isStage ? 140 : 32, svgWidth);
    const height = svgHeight;
    const midY = height / 2;
    const padX = isStage ? 10 : 2;
    const innerW = Math.max(20, width - padX * 2);
    const maxAmp = isStage ? height * 0.44 : height * 0.43;
    const minBarHalf = isStage ? 1.0 : 1.0;

    const xBandScale = d3
      .scaleLinear()
      .domain([0, bandCount - 1])
      .range([padX, padX + innerW]);

    const barPitch = innerW / bandCount;
    const barWidth = isStage
      ? Math.max(2.2, Math.min(7, barPitch * 0.52))
      : Math.max(2, Math.min(3.5, barPitch * 0.6));

    const svg = d3.select(svgEl);
    svg.selectAll("*").remove();

    // Subtle baseline & quarter markers for stage view
    if (isStage) {
      svg
        .append("line")
        .attr("x1", padX)
        .attr("x2", padX + innerW)
        .attr("y1", midY)
        .attr("y2", midY)
        .attr("stroke", "#202531")
        .attr("stroke-width", 1);

      const quarterMarks = [0.25, 0.5, 0.75];
      svg
        .selectAll("line.band-guide")
        .data(quarterMarks)
        .join("line")
        .attr("class", "band-guide")
        .attr("x1", (q) => padX + innerW * q)
        .attr("x2", (q) => padX + innerW * q)
        .attr("y1", 4)
        .attr("y2", height - 4)
        .attr("stroke", "#181c25")
        .attr("stroke-width", 1)
        .attr("stroke-dasharray", "2 3");
    } else {
      svg
        .append("line")
        .attr("x1", 1)
        .attr("x2", width - 1)
        .attr("y1", midY)
        .attr("y2", midY)
        .attr("stroke", "#252b38")
        .attr("stroke-width", 1);
    }

    const barGroup = svg.append("g").attr("class", "spectral-bars");
    const barsSelection = barGroup
      .selectAll<SVGRectElement, number>("rect")
      .data(d3.range(bandCount))
      .join("rect")
      .attr("x", (i) => {
        if (isStage) {
          return xBandScale(i) - barWidth / 2;
        }
        const span = (width - padX * 2) / bandCount;
        return padX + i * span + (span - barWidth) / 2;
      })
      .attr("width", barWidth)
      .attr("rx", isStage ? 1.2 : 0.8)
      .attr("y", midY - minBarHalf)
      .attr("height", minBarHalf * 2)
      .attr("fill", palette.idle)
      .attr("fill-opacity", effectiveActive ? 0.85 : 0.45);

    const envelopeArea = d3
      .area<number>()
      .x((_, i) => xBandScale(i))
      .y0((v) => midY - Math.max(0.8, v * maxAmp))
      .y1((v) => midY + Math.max(0.8, v * maxAmp))
      .curve(d3.curveCatmullRom.alpha(0.5));

    const crestTopLine = d3
      .line<number>()
      .x((_, i) => xBandScale(i))
      .y((v) => midY - Math.max(0.8, v * maxAmp))
      .curve(d3.curveCatmullRom.alpha(0.5));

    const crestBottomLine = d3
      .line<number>()
      .x((_, i) => xBandScale(i))
      .y((v) => midY + Math.max(0.8, v * maxAmp))
      .curve(d3.curveCatmullRom.alpha(0.5));

    const ribbonPath = isStage
      ? svg
          .append("path")
          .attr("class", "waveform-ribbon")
          .attr("fill", palette.primary)
          .attr("fill-opacity", 0.14)
      : null;

    const topPath = isStage
      ? svg
          .append("path")
          .attr("class", "waveform-crest-top")
          .attr("fill", "none")
          .attr("stroke", palette.primary)
          .attr("stroke-width", 1.35)
          .attr("stroke-linecap", "round")
          .attr("stroke-opacity", 0.9)
      : null;

    const bottomPath = isStage
      ? svg
          .append("path")
          .attr("class", "waveform-crest-bottom")
          .attr("fill", "none")
          .attr("stroke", palette.secondary)
          .attr("stroke-width", 1.1)
          .attr("stroke-linecap", "round")
          .attr("stroke-opacity", 0.65)
      : null;

    const reducedMotion =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

    let freqBins: Uint8Array<ArrayBuffer> | null = null;
    let rafId = 0;
    let disposed = false;
    let lastDrawTs = 0;

    const idleFloorHalf = (i: number) => {
      if (isStage) {
        const norm = (i / Math.max(1, bandCount - 1)) * Math.PI;
        return 1.2 + Math.sin(norm) * 1.4;
      }
      const center = (bandCount - 1) / 2;
      const dist = Math.abs(i - center) / Math.max(1, center);
      return 1.4 + (1 - dist) * 2.4;
    };

    const paintFrame = (bands: number[], sourceLabel: string) => {
      const metrics = computeWaveformMetrics(bands);

      barsSelection
        .data(bands)
        .attr("y", (v, i) => {
          const half = Math.max(idleFloorHalf(i), v * maxAmp);
          return Number((midY - half).toFixed(2));
        })
        .attr("height", (v, i) => {
          const half = Math.max(idleFloorHalf(i), v * maxAmp);
          return Number((half * 2).toFixed(2));
        })
        .attr("fill", (v, i) => {
          if (v <= 0.04 && !effectiveActive) return palette.idle;
          if (v > 0.72) return palette.peak;
          if (i > bandCount * 0.62) return palette.secondary;
          return palette.primary;
        })
        .attr("fill-opacity", (v) => (v > 0.04 ? 0.56 + v * 0.42 : effectiveActive ? 0.52 : 0.48));

      if (ribbonPath && topPath && bottomPath) {
        ribbonPath
          .attr("d", envelopeArea(bands) ?? "")
          .attr("fill-opacity", metrics.peak > 0.05 ? 0.1 + metrics.rms * 0.18 : 0.04);

        topPath
          .attr("d", crestTopLine(bands) ?? "")
          .attr("stroke", metrics.peak > 0.74 ? palette.peak : palette.primary)
          .attr("stroke-opacity", metrics.peak > 0.04 ? 0.92 : 0.35);

        bottomPath
          .attr("d", crestBottomLine(bands) ?? "")
          .attr("stroke-opacity", metrics.peak > 0.04 ? 0.68 : 0.22);
      }

      const hostEl = isStage ? containerRef.current : badgeContainerRef.current;
      if (hostEl) {
        frameCounterRef.current += 1;
        hostEl.dataset.peak = metrics.peak.toFixed(3);
        hostEl.dataset.rms = metrics.rms.toFixed(3);
        hostEl.dataset.source = sourceLabel;
        hostEl.dataset.frame = String(frameCounterRef.current);
      }

      if (peakReadoutRef.current) {
        peakReadoutRef.current.textContent = `PK ${String(Math.round(metrics.peak * 100)).padStart(2, "0")}%`;
      }
      if (statusTextRef.current && isStage) {
        statusTextRef.current.textContent =
          sourceLabel === "analyser"
            ? speaking
              ? "LIVE AUDIO"
              : "SIGNAL"
            : sourceLabel === "cadence"
              ? "SPEECH OUT"
              : active
                ? "LISTENING"
                : "STANDBY";
      }
    };

    const tick = (nowMs: number) => {
      if (disposed) return;

      const minInterval = reducedMotion ? 160 : 28;
      if (nowMs - lastDrawTs < minInterval) {
        rafId = window.requestAnimationFrame(tick);
        return;
      }
      lastDrawTs = nowMs;

      const activeAnalyser = analyserRef?.current ?? analyser;
      let targetBands: number[] | null = null;
      let sourceLabel = "idle";

      if (activeAnalyser) {
        const binCount = activeAnalyser.frequencyBinCount;
        if (!freqBins || freqBins.length !== binCount) {
          freqBins = new Uint8Array(new ArrayBuffer(binCount));
        }
        activeAnalyser.getByteFrequencyData(freqBins);
        const sampled = downsampleFrequencyBins(
          freqBins,
          bandCount,
          activeAnalyser.context?.sampleRate ?? 24000,
        );
        const sampledMetrics = computeWaveformMetrics(sampled);
        if (sampledMetrics.peak > 0.025) {
          targetBands = sampled;
          sourceLabel = "analyser";
        }
      }

      if (!targetBands && speaking) {
        const boundary = boundarySignalRef?.current;
        const startedAt = speechStartedAtRef.current || nowMs;
        targetBands = synthesizeSpeechCadenceBands({
          bandCount,
          elapsedMs: Math.max(0, nowMs - startedAt),
          lastBoundaryAtMs: boundary?.atMs ?? 0,
          nowMs,
          syllableSeed: (boundary?.charIndex ?? 1) + 1,
          speaking: true,
        });
        sourceLabel = "cadence";
      }

      if (!targetBands) {
        targetBands = new Array<number>(bandCount).fill(0);
      }

      const smoothed = smoothBandFrame(bandsRef.current, targetBands, 0.64, 0.25);
      bandsRef.current = smoothed;
      paintFrame(smoothed, sourceLabel);

      const hasResidualEnergy = computeWaveformMetrics(smoothed).peak > 0.006;
      if (effectiveActive || hasResidualEnergy) {
        rafId = window.requestAnimationFrame(tick);
      }
    };

    // Initial paint + start RAF when active or settling down from prior speech
    const initialMetrics = computeWaveformMetrics(bandsRef.current);
    paintFrame(bandsRef.current, effectiveActive ? "init" : "idle");

    if (effectiveActive || initialMetrics.peak > 0.006) {
      rafId = window.requestAnimationFrame(tick);
    }

    return () => {
      disposed = true;
      window.cancelAnimationFrame(rafId);
    };
  }, [
    active,
    analyser,
    analyserRef,
    bandCount,
    boundarySignalRef,
    effectiveActive,
    isStage,
    speaking,
    svgHeight,
    svgWidth,
    tone,
  ]);

  if (!isStage) {
    return (
      <span
        ref={badgeContainerRef}
        data-testid={dataTestId ?? "d3-speech-waveform-badge"}
        data-speaking={speaking ? "true" : "false"}
        data-active={effectiveActive ? "true" : "false"}
        data-peak="0.000"
        data-rms="0.000"
        data-source="idle"
        aria-hidden="true"
        className={cn(
          "inline-flex shrink-0 items-center justify-center rounded border px-1 py-0.5 transition-colors",
          effectiveActive
            ? tone === "warn"
              ? "border-warn/45 bg-warn/10"
              : tone === "crit"
                ? "border-destructive/45 bg-destructive/10"
                : "border-ok/45 bg-ok/10"
            : "border-border/70 bg-term",
          className,
        )}
      >
        <svg
          ref={svgRef}
          width={svgWidth}
          height={svgHeight}
          viewBox={`0 0 ${svgWidth} ${svgHeight}`}
          className="block overflow-visible"
        />
      </span>
    );
  }

  return (
    <div
      ref={containerRef}
      data-testid={dataTestId ?? "d3-speech-waveform-stage"}
      data-speaking={speaking ? "true" : "false"}
      data-active={effectiveActive ? "true" : "false"}
      data-peak="0.000"
      data-rms="0.000"
      data-source="idle"
      className={cn(
        "rounded border bg-term transition-colors",
        speaking
          ? "border-ok/45"
          : effectiveActive
            ? "border-warn/40"
            : "border-border",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2 border-b border-border/60 px-2.5 py-1 font-mono text-[10px]">
        <div className="flex min-w-0 items-center gap-2">
          <span
            ref={statusTextRef}
            className={cn(
              "font-semibold tracking-wider whitespace-nowrap",
              speaking
                ? "text-ok"
                : effectiveActive
                  ? "text-warn"
                  : "text-muted-foreground",
            )}
          >
            {speaking ? "SPEECH OUT" : effectiveActive ? "LISTENING" : "STANDBY"}
          </span>
          {label ? (
            <span className="truncate text-muted-foreground">{label}</span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2.5 text-muted-foreground tabular-nums">
          {sublabel ? <span className="hidden sm:inline">{sublabel}</span> : null}
          <span ref={peakReadoutRef} className="text-foreground/85">
            PK 00%
          </span>
        </div>
      </div>

      <svg
        ref={svgRef}
        width={svgWidth}
        height={svgHeight}
        viewBox={`0 0 ${svgWidth} ${svgHeight}`}
        role="img"
        aria-label={label ?? "Real-time Cletus speech frequency waveform"}
        className="block w-full select-none"
      />
    </div>
  );
}
