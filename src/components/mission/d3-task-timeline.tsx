import { useEffect, useMemo, useRef, useState } from "react";
import * as d3 from "d3";
import { History, RotateCcw } from "lucide-react";
import {
  buildTaskStatusTimeline,
  reconstructOperationalStateAt,
  type TaskTimelinePoint,
} from "@/lib/cletus/task-history";
import type { Task, TaskStatusEvent } from "@/lib/cletus/types";
import { cn } from "@/lib/utils";

interface D3TaskTimelineProps {
  taskEvents: TaskStatusEvent[];
  tasks: Task[];
  now: number;
  missionId?: string | null;
}

const SERIES = [
  { key: "completed" as const, label: "Completed", color: "#7ea37a" },
  { key: "running" as const, label: "Running", color: "#c4a574" },
  { key: "assigned" as const, label: "Assigned", color: "#6ea8c7" },
  { key: "pending" as const, label: "Pending", color: "#64748b" },
  { key: "failed" as const, label: "Failed", color: "#c46a55" },
];

const CHART_HEIGHT = 96;
const CHART_MARGIN = { top: 8, right: 14, bottom: 18, left: 28 };

function formatClockTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

export function D3TaskTimeline({
  taskEvents,
  tasks,
  now,
  missionId,
}: D3TaskTimelineProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [chartWidth, setChartWidth] = useState(560);
  const [scrubTimestamp, setScrubTimestamp] = useState<number | null>(null);

  const timeline = useMemo(
    () => buildTaskStatusTimeline(taskEvents, tasks, now, missionId),
    [taskEvents, tasks, now, missionId],
  );

  const minTs = timeline[0]?.timestamp ?? now - 60_000;
  const maxTs = Math.max(minTs + 1, timeline[timeline.length - 1]?.timestamp ?? now);
  const activeTimestamp =
    scrubTimestamp === null ? maxTs : Math.max(minTs, Math.min(maxTs, scrubTimestamp));
  const isLive = scrubTimestamp === null || scrubTimestamp >= maxTs;

  const operationalState = useMemo(
    () => reconstructOperationalStateAt(taskEvents, tasks, activeTimestamp, now, missionId),
    [taskEvents, tasks, activeTimestamp, now, missionId],
  );

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const updateSize = () => {
      const w = el.getBoundingClientRect().width;
      if (w > 120) setChartWidth(Math.floor(w));
    };

    updateSize();
    const observer =
      typeof ResizeObserver !== "undefined" ? new ResizeObserver(updateSize) : null;
    observer?.observe(el);

    return () => observer?.disconnect();
  }, []);

  useEffect(() => {
    const svgEl = svgRef.current;
    if (!svgEl || timeline.length === 0) return;

    const innerW = Math.max(120, chartWidth - CHART_MARGIN.left - CHART_MARGIN.right);
    const innerH = Math.max(48, CHART_HEIGHT - CHART_MARGIN.top - CHART_MARGIN.bottom);

    const xScale = d3
      .scaleTime()
      .domain([new Date(minTs), new Date(maxTs)])
      .range([0, innerW]);

    const maxY = Math.max(
      2,
      d3.max(timeline, (d) => Math.max(d.completed, d.running, d.assigned, d.pending, d.failed)) ?? 2,
    );

    const yScale = d3.scaleLinear().domain([0, maxY]).nice().range([innerH, 0]);

    const svg = d3.select(svgEl);
    svg.selectAll("*").remove();

    const g = svg.append("g").attr("transform", `translate(${CHART_MARGIN.left},${CHART_MARGIN.top})`);

    // Subtle horizontal gridlines
    const yTicks = yScale.ticks(Math.min(3, maxY));
    g.append("g")
      .attr("class", "timeline-grid")
      .selectAll("line")
      .data(yTicks)
      .join("line")
      .attr("x1", 0)
      .attr("x2", innerW)
      .attr("y1", (d) => yScale(d))
      .attr("y2", (d) => yScale(d))
      .attr("stroke", "#1e232d")
      .attr("stroke-dasharray", "2 3");

    // Axes
    const xAxis = d3
      .axisBottom<Date>(xScale)
      .ticks(Math.max(3, Math.min(6, Math.floor(innerW / 95))))
      .tickFormat((d) => formatClockTime(d.getTime()));

    const yAxis = d3
      .axisLeft<number>(yScale)
      .ticks(Math.min(3, maxY))
      .tickFormat((d) => `${Math.round(d)}`);

    const gx = g
      .append("g")
      .attr("transform", `translate(0,${innerH})`)
      .call(xAxis);
    gx.selectAll("path, line").attr("stroke", "#2a2e38");
    gx.selectAll("text")
      .attr("fill", "#8b909a")
      .attr("font-size", 9)
      .attr("font-family", "IBM Plex Mono, monospace");

    const gy = g.append("g").call(yAxis);
    gy.selectAll("path, line").attr("stroke", "#2a2e38");
    gy.selectAll("text")
      .attr("fill", "#8b909a")
      .attr("font-size", 9)
      .attr("font-family", "IBM Plex Mono, monospace");

    // Render series step lines and event dots
    for (const series of SERIES) {
      const hasAny = timeline.some((pt) => pt[series.key] > 0);
      if (!hasAny && series.key !== "completed" && series.key !== "running") continue;

      const lineGen = d3
        .line<TaskTimelinePoint>()
        .x((d) => xScale(new Date(d.timestamp)))
        .y((d) => yScale(d[series.key]))
        .curve(d3.curveStepAfter);

      g.append("path")
        .datum(timeline)
        .attr("class", `timeline-series timeline-series-${series.key}`)
        .attr("fill", "none")
        .attr("stroke", series.color)
        .attr("stroke-width", 1.75)
        .attr("d", lineGen);

      g.selectAll(`circle.dot-${series.key}`)
        .data(timeline.filter((pt) => pt.events.length > 0))
        .join("circle")
        .attr("class", `dot-${series.key}`)
        .attr("cx", (d) => xScale(new Date(d.timestamp)))
        .attr("cy", (d) => yScale(d[series.key]))
        .attr("r", 2.2)
        .attr("fill", series.color)
        .attr("stroke", "#0a0b0d")
        .attr("stroke-width", 0.75);
    }

    // Scrubber vertical indicator line & marker
    const scrubX = xScale(new Date(activeTimestamp));
    g.append("line")
      .attr("class", "timeline-scrubber-line")
      .attr("x1", scrubX)
      .attr("x2", scrubX)
      .attr("y1", 0)
      .attr("y2", innerH)
      .attr("stroke", isLive ? "#7ea37a" : "#e8eaee")
      .attr("stroke-width", 1.4)
      .attr("stroke-dasharray", isLive ? "none" : "3 2");

    g.append("circle")
      .attr("cx", scrubX)
      .attr("cy", 4)
      .attr("r", 3.2)
      .attr("fill", isLive ? "#7ea37a" : "#e8eaee");

    // Interactive click/drag overlay directly on SVG canvas
    const updateFromPointer = (clientX: number) => {
      const rect = svgEl.getBoundingClientRect();
      const localX = Math.max(0, Math.min(innerW, clientX - rect.left - CHART_MARGIN.left));
      const ts = Math.round(xScale.invert(localX).getTime());
      setScrubTimestamp(ts >= maxTs - 500 ? null : ts);
    };

    let dragging = false;
    g.append("rect")
      .attr("x", 0)
      .attr("y", 0)
      .attr("width", innerW)
      .attr("height", innerH)
      .attr("fill", "transparent")
      .attr("cursor", "ew-resize")
      .on("pointerdown", (event: PointerEvent) => {
        dragging = true;
        updateFromPointer(event.clientX);
      })
      .on("pointermove", (event: PointerEvent) => {
        if (dragging) updateFromPointer(event.clientX);
      })
      .on("pointerup", () => {
        dragging = false;
      })
      .on("pointerleave", () => {
        dragging = false;
      });
  }, [timeline, chartWidth, minTs, maxTs, activeTimestamp, isLive]);

  const recentEventsAtPoint = operationalState.eventsAtOrBefore.slice(-2).reverse();

  return (
    <div
      data-testid="d3-task-timeline-panel"
      className="flex flex-none flex-col border-b border-border bg-card/60"
    >
      <div className="flex flex-wrap items-center justify-between gap-1.5 border-b border-border/60 px-3 py-1">
        <div className="flex flex-wrap items-center gap-2 font-mono text-[10px] text-muted-foreground tabular-nums">
          <span className="inline-flex items-center gap-1 font-semibold text-foreground">
            <History className="size-3 text-warn" />
            <span>History</span>
          </span>
          <span>
            {isLive ? "LIVE" : `SCRUBBED @ ${formatClockTime(activeTimestamp)}`}
          </span>
          <span className="text-ok">{operationalState.counts.completed} done</span>
          <span className="text-warn">{operationalState.counts.running} running</span>
          <span className="text-[#6ea8c7]">{operationalState.counts.assigned} assigned</span>
          <span>{operationalState.counts.pending} pending</span>
          {operationalState.counts.failed > 0 ? (
            <span className="text-destructive">{operationalState.counts.failed} failed</span>
          ) : null}
        </div>

        <div className="flex items-center gap-2">
          <div className="hidden sm:flex items-center gap-2 font-mono text-[9.5px] text-muted-foreground">
            {SERIES.slice(0, 4).map((s) => (
              <span key={s.key} className="inline-flex items-center gap-1">
                <span className="inline-block size-2 rounded-xs" style={{ backgroundColor: s.color }} />
                {s.label}
              </span>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setScrubTimestamp(null)}
            disabled={isLive}
            className={cn(
              "inline-flex h-5 items-center gap-1 rounded border px-1.5 font-mono text-[9.5px] transition-colors",
              isLive
                ? "border-ok/40 bg-ok/10 text-ok"
                : "border-border bg-term text-foreground hover:bg-secondary",
            )}
          >
            <RotateCcw className="size-2.5" />
            <span>{isLive ? "Live" : "Reset Live"}</span>
          </button>
        </div>
      </div>

      <div ref={containerRef} className="w-full px-1 pt-0.5">
        <svg
          ref={svgRef}
          data-testid="d3-task-timeline-svg"
          width={chartWidth}
          height={CHART_HEIGHT}
          className="block w-full overflow-visible select-none"
          role="img"
          aria-label="Historical task status time-series line chart"
        />
      </div>

      <div className="flex flex-col gap-1 border-t border-border/50 bg-term/60 px-3 py-1">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[9.5px] text-muted-foreground tabular-nums whitespace-nowrap">
            {formatClockTime(minTs)}
          </span>
          <input
            type="range"
            aria-label="Scrub historical operational state"
            data-testid="timeline-scrubber-input"
            min={minTs}
            max={maxTs}
            step={Math.max(1, Math.floor((maxTs - minTs) / 120))}
            value={activeTimestamp}
            onChange={(e) => {
              const val = Number(e.target.value);
              setScrubTimestamp(val >= maxTs ? null : val);
            }}
            className="h-1.5 flex-1 accent-[#c4a574] cursor-pointer"
          />
          <span className="font-mono text-[9.5px] text-muted-foreground tabular-nums whitespace-nowrap">
            {formatClockTime(maxTs)}
          </span>
        </div>

        {recentEventsAtPoint.length > 0 ? (
          <div className="flex items-center gap-3 overflow-hidden font-mono text-[9.5px] text-muted-foreground">
            {recentEventsAtPoint.map((ev) => (
              <span key={ev.id} className="truncate">
                <span className="text-foreground">{ev.taskId}</span>{" "}
                <span className="text-warn">
                  {ev.previousStatus ? `${ev.previousStatus}→${ev.status}` : ev.status}
                </span>{" "}
                <span>({ev.actor})</span>
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
