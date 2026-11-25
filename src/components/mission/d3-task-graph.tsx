import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as d3 from "d3";
import { Maximize2, RotateCcw, ZoomIn, ZoomOut } from "lucide-react";
import {
  buildD3TaskHierarchyGraph,
  getConnectedLineage,
  type D3GraphEdge,
  type D3GraphNode,
} from "@/lib/cletus/d3-graph";
import type { SelectedNode } from "@/lib/cletus/store";
import type { Child, Goal, Mission, Task } from "@/lib/cletus/types";

interface D3TaskGraphProps {
  missions: Mission[];
  goals: Goal[];
  tasks: Task[];
  children: Child[];
  activeMissionId?: string | null;
  missionOnly?: boolean;
  goalFilter?: string;
  selectedNode: SelectedNode | null;
  onSelectNode: (node: SelectedNode | null) => void;
}

function toneColor(tone: D3GraphNode["tone"]): string {
  if (tone === "ok") return "#7ea37a";
  if (tone === "warn") return "#c4a574";
  if (tone === "crit") return "#c46a55";
  return "#64748b";
}

function kindBadgeLabel(kind: D3GraphNode["kind"]): string {
  switch (kind) {
    case "mission":
      return "MISSION";
    case "goal":
      return "GOAL";
    case "task":
      return "TASK";
    case "worker":
      return "AGENT";
  }
}

function kindBadgeFill(kind: D3GraphNode["kind"]): string {
  switch (kind) {
    case "mission":
      return "#232938";
    case "goal":
      return "#25231b";
    case "task":
      return "#18222a";
    case "worker":
      return "#1a251d";
  }
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(1, maxChars - 1))}…`;
}

function mapNodeToSelection(node: D3GraphNode): SelectedNode {
  return { kind: node.kind, id: node.entityId };
}

function isNodeSelected(node: D3GraphNode, selectedNode: SelectedNode | null): boolean {
  if (!selectedNode) return false;
  if (selectedNode.kind !== node.kind) return false;
  if (node.kind === "worker") {
    return (
      selectedNode.id.toLowerCase() === node.entityId.toLowerCase() ||
      selectedNode.id.toLowerCase() === node.title.toLowerCase()
    );
  }
  return selectedNode.id === node.entityId;
}

export function D3TaskGraph({
  missions,
  goals,
  tasks,
  children,
  activeMissionId,
  missionOnly = false,
  goalFilter = "all",
  selectedNode,
  onSelectNode,
}: D3TaskGraphProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const zoomBehaviorRef = useRef<d3.ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const onSelectRef = useRef(onSelectNode);
  const graphRevisionRef = useRef(0);
  const userInteractedRef = useRef(false);

  const [zoomScale, setZoomScale] = useState(1);
  const [hoveredGraphNodeId, setHoveredGraphNodeId] = useState<string | null>(null);

  useEffect(() => {
    onSelectRef.current = onSelectNode;
  }, [onSelectNode]);

  const layout = useMemo(
    () =>
      buildD3TaskHierarchyGraph({
        missions,
        goals,
        tasks,
        children,
        activeMissionId,
        missionOnly,
        goalFilter,
      }),
    [missions, goals, tasks, children, activeMissionId, missionOnly, goalFilter],
  );

  // Determine active node for lineage highlighting (hover takes transient precedence over click selection)
  const activeGraphNodeId = useMemo(() => {
    if (hoveredGraphNodeId) return hoveredGraphNodeId;
    if (!selectedNode) return null;
    const match = layout.nodes.find((n) => isNodeSelected(n, selectedNode));
    return match?.id ?? null;
  }, [hoveredGraphNodeId, selectedNode, layout.nodes]);

  const hoveredNode = useMemo(
    () => (hoveredGraphNodeId ? layout.nodes.find((n) => n.id === hoveredGraphNodeId) ?? null : null),
    [hoveredGraphNodeId, layout.nodes],
  );

  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(null);

  const lineage = useMemo(
    () => getConnectedLineage(activeGraphNodeId, layout.edges),
    [activeGraphNodeId, layout.edges],
  );

  // Compute responsive fit transform
  const applyFitTransform = useCallback(
    (animate: boolean) => {
      const svgEl = svgRef.current;
      const containerEl = containerRef.current;
      const zoomBehavior = zoomBehaviorRef.current;
      if (!svgEl || !containerEl || !zoomBehavior) return;

      const rect = containerEl.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;

      const pad = 14;
      const scaleX = (rect.width - pad * 2) / Math.max(1, layout.width);
      const scaleY = (rect.height - pad * 2) / Math.max(1, layout.height);
      const targetScale = Math.max(0.24, Math.min(1.05, Math.min(scaleX, scaleY)));
      const tx = Math.max(8, (rect.width - layout.width * targetScale) / 2);
      const ty = Math.max(8, (rect.height - layout.height * targetScale) / 2);
      const transform = d3.zoomIdentity.translate(tx, ty).scale(targetScale);

      const sel = d3.select(svgEl);
      if (animate) {
        sel.transition().duration(240).call(zoomBehavior.transform, transform);
      } else {
        sel.call(zoomBehavior.transform, transform);
      }
    },
    [layout.width, layout.height],
  );

  // Initialize d3.zoom once on mount
  useEffect(() => {
    const svgEl = svgRef.current;
    if (!svgEl) return;

    const svg = d3.select(svgEl);
    const zoom = d3
      .zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.2, 2.2])
      .on("zoom", (event: d3.D3ZoomEvent<SVGSVGElement, unknown>) => {
        if (event.sourceEvent) {
          userInteractedRef.current = true;
        }
        svg.select<SVGGElement>("g.d3-zoom-root").attr("transform", event.transform.toString());
        setZoomScale(Number(event.transform.k.toFixed(2)));
      });

    zoomBehaviorRef.current = zoom;
    svg.call(zoom).on("dblclick.zoom", null);

    // Click empty background to clear selection
    svg.on("click", (event: MouseEvent) => {
      if (event.target === svgEl) {
        onSelectRef.current(null);
      }
    });

    return () => {
      svg.on(".zoom", null);
      svg.on("click", null);
    };
  }, []);

  // Auto-fit cleanly on mount and container resize until user manually pans/zooms
  useEffect(() => {
    const containerEl = containerRef.current;
    if (!containerEl) return;

    const fitIfAuto = () => {
      if (!userInteractedRef.current) {
        applyFitTransform(false);
      }
    };

    fitIfAuto();
    const rafId = window.requestAnimationFrame(fitIfAuto);
    const observer =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => {
            fitIfAuto();
          })
        : null;
    observer?.observe(containerEl);

    return () => {
      window.cancelAnimationFrame(rafId);
      observer?.disconnect();
    };
  }, [applyFitTransform]);

  // Render D3 data-joins for headers, edges, and nodes whenever layout/selection/hover updates
  useEffect(() => {
    const svgEl = svgRef.current;
    if (!svgEl) return;

    graphRevisionRef.current += 1;
    const svg = d3.select(svgEl);
    svg.attr("data-graph-revision", String(graphRevisionRef.current));

    const root = svg.select<SVGGElement>("g.d3-zoom-root");

    // 1. Stage column headers
    const headersGroup = root.select<SVGGElement>("g.d3-headers");
    headersGroup
      .selectAll<SVGTextElement, { label: string; x: number; width: number }>("text.d3-col-header")
      .data(layout.headers, (d) => d.label)
      .join("text")
      .attr("class", "d3-col-header")
      .attr("x", (d) => d.x + 2)
      .attr("y", 22)
      .attr("fill", "#8b909a")
      .attr("font-size", 10.5)
      .attr("font-family", "IBM Plex Mono, monospace")
      .attr("letter-spacing", "0.06em")
      .text((d) => d.label.toUpperCase());

    // 2. Smooth Bézier edges via d3.linkHorizontal
    const linkGenerator = d3
      .linkHorizontal<D3GraphEdge, [number, number]>()
      .source((d) => [d.sourceX, d.sourceY])
      .target((d) => [d.targetX, d.targetY]);

    const edgeRole = (edgeId: string): "upstream" | "downstream" | "dim" | "neutral" => {
      if (!activeGraphNodeId) return "neutral";
      if (lineage.upstreamEdgeIds.has(edgeId)) return "upstream";
      if (lineage.downstreamEdgeIds.has(edgeId)) return "downstream";
      return "dim";
    };

    const edgesGroup = root.select<SVGGElement>("g.d3-edges");
    const edgeSelection = edgesGroup
      .selectAll<SVGPathElement, D3GraphEdge>("path.d3-edge")
      .data(layout.edges, (d) => d.id)
      .join(
        (enter) =>
          enter
            .append("path")
            .attr("class", "d3-edge")
            .attr("fill", "none")
            .attr("opacity", 0.92),
        (update) => update,
        (exit) => exit.remove(),
      )
      .attr("data-lineage", (d) => edgeRole(d.id))
      .attr("d", (d) => linkGenerator(d) ?? "")
      .attr("stroke-dasharray", (d) => (d.kind === "task_dep" ? "5 3" : null))
      .attr("marker-end", (d) => {
        const role = edgeRole(d.id);
        if (role === "upstream") return "url(#d3-arrow-upstream)";
        if (role === "downstream") return "url(#d3-arrow-downstream)";
        return d.satisfied ? "url(#d3-arrow-ok)" : "url(#d3-arrow-muted)";
      })
      .attr("stroke", (d) => {
        const role = edgeRole(d.id);
        if (role === "upstream") return "#c4a574";
        if (role === "downstream") return "#6ea8c7";
        if (d.satisfied) return "#4a6348";
        return d.kind === "task_dep" ? "#4b5263" : "#2c323f";
      })
      .attr("stroke-width", (d) => {
        const role = edgeRole(d.id);
        return role === "upstream" || role === "downstream" ? 2.1 : 1.3;
      })
      .attr("opacity", (d) => {
        if (!activeGraphNodeId) return 0.92;
        return lineage.edgeIds.has(d.id) ? 1 : 0.16;
      });
    void edgeSelection;

    // 3. Interactive Hierarchy Nodes (Mission, Goal, Task, Worker)
    const nodeRole = (d: D3GraphNode): "selected" | "upstream" | "downstream" | "dim" | "neutral" => {
      if (!activeGraphNodeId) return "neutral";
      if (d.id === activeGraphNodeId) return "selected";
      if (lineage.upstreamNodeIds.has(d.id)) return "upstream";
      if (lineage.downstreamNodeIds.has(d.id)) return "downstream";
      return "dim";
    };

    const nodesGroup = root.select<SVGGElement>("g.d3-nodes");
    const nodeSelection = nodesGroup
      .selectAll<SVGGElement, D3GraphNode>("g.d3-node")
      .data(layout.nodes, (d) => d.id)
      .join(
        (enter) => {
          const g = enter
            .append("g")
            .attr("class", "d3-node")
            .attr("transform", (d) => `translate(${d.x}, ${d.y})`)
            .attr("cursor", "pointer")
            .attr("role", "button")
            .attr("tabindex", 0)
            .attr("opacity", 1);

          g.append("rect").attr("class", "node-bg").attr("rx", 6);
          g.append("rect").attr("class", "node-stripe").attr("x", 0).attr("y", 0).attr("width", 4).attr("rx", 2);
          g.append("rect").attr("class", "node-badge-bg").attr("x", 11).attr("y", 8).attr("height", 15).attr("rx", 3);
          g.append("text")
            .attr("class", "node-badge-text")
            .attr("x", 16)
            .attr("y", 18.5)
            .attr("font-size", 8.5)
            .attr("font-weight", 700)
            .attr("font-family", "IBM Plex Mono, monospace");

          g.append("text")
            .attr("class", "node-lineage-tag")
            .attr("x", 204)
            .attr("y", 18.5)
            .attr("text-anchor", "end")
            .attr("font-size", 8.5)
            .attr("font-weight", 600)
            .attr("font-family", "IBM Plex Mono, monospace");

          g.append("text")
            .attr("class", "node-title")
            .attr("x", 11)
            .attr("y", 36)
            .attr("fill", "#e8eaee")
            .attr("font-size", 11.5)
            .attr("font-weight", 600);

          g.append("text")
            .attr("class", "node-subtitle")
            .attr("x", 11)
            .attr("y", 51)
            .attr("font-size", 10)
            .attr("font-family", "IBM Plex Mono, monospace");

          g.append("rect")
            .attr("class", "progress-track")
            .attr("x", 11)
            .attr("height", 4)
            .attr("rx", 2)
            .attr("fill", "#1b1f29");

          g.append("rect")
            .attr("class", "progress-fill")
            .attr("x", 11)
            .attr("height", 4)
            .attr("rx", 2);

          return g;
        },
        (update) => update,
        (exit) => exit.remove(),
      );

    nodeSelection
      .attr("data-node-kind", (d) => d.kind)
      .attr("data-entity-id", (d) => d.entityId)
      .attr("data-node-status", (d) => d.status)
      .attr("data-lineage", (d) => nodeRole(d))
      .attr("aria-label", (d) => `${kindBadgeLabel(d.kind)} ${d.title} (${d.status}, ${d.progress}%)`)
      .attr("opacity", (d) => {
        if (!activeGraphNodeId) return 1;
        return lineage.nodeIds.has(d.id) ? 1 : 0.28;
      })
      .on("click", (event: MouseEvent, d: D3GraphNode) => {
        event.stopPropagation();
        onSelectRef.current(mapNodeToSelection(d));
      })
      .on("keydown", (event: KeyboardEvent, d: D3GraphNode) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelectRef.current(mapNodeToSelection(d));
        }
      })
      .on("mouseenter", (event: MouseEvent, d: D3GraphNode) => {
        setHoveredGraphNodeId(d.id);
        const containerEl = containerRef.current;
        if (containerEl) {
          const rect = containerEl.getBoundingClientRect();
          setTooltipPos({
            x: Math.max(12, Math.min(rect.width - 230, event.clientX - rect.left + 14)),
            y: Math.max(12, Math.min(rect.height - 96, event.clientY - rect.top + 14)),
          });
        }
      })
      .on("mousemove", (event: MouseEvent) => {
        const containerEl = containerRef.current;
        if (containerEl) {
          const rect = containerEl.getBoundingClientRect();
          setTooltipPos({
            x: Math.max(12, Math.min(rect.width - 230, event.clientX - rect.left + 14)),
            y: Math.max(12, Math.min(rect.height - 96, event.clientY - rect.top + 14)),
          });
        }
      })
      .on("mouseleave", () => {
        setHoveredGraphNodeId(null);
        setTooltipPos(null);
      });

    nodeSelection
      .transition()
      .duration(180)
      .attr("transform", (d) => `translate(${d.x}, ${d.y})`);

    nodeSelection
      .select<SVGRectElement>("rect.node-bg")
      .attr("width", (d) => d.width)
      .attr("height", (d) => d.height)
      .attr("fill", (d) => {
        const role = nodeRole(d);
        if (isNodeSelected(d, selectedNode) || role === "selected") return "#1d222c";
        if (role === "upstream") return "#191713";
        if (role === "downstream") return "#111a21";
        return "#12151c";
      })
      .attr("stroke", (d) => {
        const role = nodeRole(d);
        if (isNodeSelected(d, selectedNode) || role === "selected") return "#e8eaee";
        if (role === "upstream") return "#c4a574";
        if (role === "downstream") return "#6ea8c7";
        if (hoveredGraphNodeId === d.id) return toneColor(d.tone);
        return "#2a303d";
      })
      .attr("stroke-width", (d) => {
        const role = nodeRole(d);
        if (isNodeSelected(d, selectedNode) || role === "selected") return 2;
        if (role === "upstream" || role === "downstream") return 1.5;
        return 1;
      });

    nodeSelection
      .select<SVGRectElement>("rect.node-stripe")
      .attr("height", (d) => d.height)
      .attr("fill", (d) => {
        const role = nodeRole(d);
        if (role === "upstream") return "#c4a574";
        if (role === "downstream") return "#6ea8c7";
        return toneColor(d.tone);
      });

    nodeSelection
      .select<SVGRectElement>("rect.node-badge-bg")
      .attr("width", (d) => (d.kind === "mission" ? 48 : d.kind === "worker" ? 42 : 36))
      .attr("fill", (d) => kindBadgeFill(d.kind))
      .attr("stroke", (d) => toneColor(d.tone))
      .attr("stroke-opacity", 0.45)
      .attr("stroke-width", 0.75);

    nodeSelection
      .select<SVGTextElement>("text.node-badge-text")
      .attr("fill", (d) => toneColor(d.tone))
      .text((d) => kindBadgeLabel(d.kind));

    nodeSelection
      .select<SVGTextElement>("text.node-lineage-tag")
      .attr("x", (d) => d.width - 10)
      .attr("fill", (d) => {
        const role = nodeRole(d);
        if (role === "upstream") return "#c4a574";
        if (role === "downstream") return "#6ea8c7";
        return "#e8eaee";
      })
      .text((d) => {
        const role = nodeRole(d);
        if (role === "upstream") return "UPSTREAM";
        if (role === "downstream") return "DOWNSTREAM";
        return "";
      });

    nodeSelection
      .select<SVGTextElement>("text.node-title")
      .text((d) => truncateText(d.title, Math.floor((d.width - 22) / 6.6)));

    nodeSelection
      .select<SVGTextElement>("text.node-subtitle")
      .attr("fill", (d) => (d.blockedBy && d.blockedBy.length > 0 && d.status !== "completed" ? "#c46a55" : "#9aa0ac"))
      .text((d) => truncateText(d.subtitle, Math.floor((d.width - 22) / 6.0)));

    nodeSelection
      .select<SVGRectElement>("rect.progress-track")
      .attr("y", (d) => d.height - 11)
      .attr("width", (d) => d.width - 22);

    nodeSelection
      .select<SVGRectElement>("rect.progress-fill")
      .attr("y", (d) => d.height - 11)
      .attr("fill", (d) => toneColor(d.tone))
      .transition()
      .duration(300)
      .attr("width", (d) => {
        const maxW = d.width - 22;
        if (d.progress <= 0) return 0;
        return Math.max(6, Math.round((maxW * Math.min(100, d.progress)) / 100));
      });
  }, [layout, selectedNode, hoveredGraphNodeId, activeGraphNodeId, lineage]);

  const handleZoomBy = (factor: number) => {
    const svgEl = svgRef.current;
    const zoom = zoomBehaviorRef.current;
    if (!svgEl || !zoom) return;
    userInteractedRef.current = true;
    d3.select(svgEl).transition().duration(180).call(zoom.scaleBy, factor);
  };

  const handleResetZoom = () => {
    const svgEl = svgRef.current;
    const zoom = zoomBehaviorRef.current;
    if (!svgEl || !zoom) return;
    userInteractedRef.current = true;
    d3.select(svgEl)
      .transition()
      .duration(220)
      .call(zoom.transform, d3.zoomIdentity.translate(12, 12).scale(1));
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-term">
      {/* D3 Controls & Live Lineage Legend */}
      <div className="flex flex-none flex-wrap items-center justify-between gap-2 border-b border-border/60 bg-card/40 px-3 py-1.5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] text-muted-foreground tabular-nums">
          <span className="font-semibold text-foreground">Dependency DAG</span>
          <span>
            {layout.summary.missionsCount}M · {layout.summary.goalsCount}G ·{" "}
            <strong className="text-ok">
              {layout.summary.tasksCompleted}/{layout.summary.tasksCount}
            </strong>{" "}
            tasks ({layout.summary.overallProgressPct}%)
          </span>
          {activeGraphNodeId ? (
            <span className="inline-flex items-center gap-2 text-foreground">
              <span className="inline-flex items-center gap-1 text-[#c4a574]">
                <span className="inline-block size-2 rounded-xs bg-[#c4a574]" />
                {lineage.upstreamNodeIds.size} upstream
              </span>
              <span className="inline-flex items-center gap-1 text-[#6ea8c7]">
                <span className="inline-block size-2 rounded-xs bg-[#6ea8c7]" />
                {lineage.downstreamNodeIds.size} downstream
              </span>
            </span>
          ) : (
            <span className="hidden sm:inline-flex items-center gap-2">
              <span className="inline-flex items-center gap-1">
                <span className="inline-block size-2 rounded-xs bg-[#7ea37a]" />
                Done
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="inline-block size-2 rounded-xs bg-[#c4a574]" />
                Active
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="inline-block size-2 rounded-xs bg-[#6ea8c7]" />
                Child
              </span>
            </span>
          )}
        </div>

        <div className="flex items-center gap-1">
          <div className="flex items-center rounded border border-border bg-card">
            <button
              type="button"
              onClick={() => handleZoomBy(0.84)}
              aria-label="Zoom out D3 graph"
              className="flex h-6 w-6 items-center justify-center text-muted-foreground hover:text-foreground"
            >
              <ZoomOut className="size-3" />
            </button>
            <button
              type="button"
              onClick={handleResetZoom}
              aria-label="Reset D3 zoom to 100%"
              className="flex h-6 items-center gap-1 px-1.5 font-mono text-[10px] text-muted-foreground tabular-nums hover:text-foreground"
            >
              <RotateCcw className="size-2.5" />
              <span>{Math.round(zoomScale * 100)}%</span>
            </button>
            <button
              type="button"
              onClick={() => handleZoomBy(1.2)}
              aria-label="Zoom in D3 graph"
              className="flex h-6 w-6 items-center justify-center text-muted-foreground hover:text-foreground"
            >
              <ZoomIn className="size-3" />
            </button>
          </div>
          <button
            type="button"
            onClick={() => {
              userInteractedRef.current = false;
              applyFitTransform(true);
            }}
            aria-label="Fit D3 graph to viewport"
            className="inline-flex h-6 items-center gap-1 rounded border border-border bg-card px-2 font-mono text-[10px] text-muted-foreground whitespace-nowrap shrink-0 hover:text-foreground"
          >
            <Maximize2 className="size-2.5" />
            <span>Fit</span>
          </button>
        </div>
      </div>

      {/* Interactive Pan/Zoom SVG Viewport */}
      <div ref={containerRef} className="relative min-h-0 flex-1 overflow-hidden">
        <svg
          ref={svgRef}
          data-testid="d3-task-graph-svg"
          data-tasks-completed={layout.summary.tasksCompleted}
          data-tasks-total={layout.summary.tasksCount}
          data-overall-progress={layout.summary.overallProgressPct}
          className="h-full w-full block select-none touch-none"
          role="img"
          aria-label="Interactive D3 Mission, Goal, and Task Dependency Graph"
        >
          <defs>
            <marker
              id="d3-arrow-muted"
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="5"
              markerHeight="5"
              orient="auto-start-reverse"
            >
              <path d="M 0 1 L 8 5 L 0 9 z" fill="#4b5263" />
            </marker>
            <marker
              id="d3-arrow-ok"
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="5"
              markerHeight="5"
              orient="auto-start-reverse"
            >
              <path d="M 0 1 L 8 5 L 0 9 z" fill="#5e875a" />
            </marker>
            <marker
              id="d3-arrow-upstream"
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="5"
              markerHeight="5"
              orient="auto-start-reverse"
            >
              <path d="M 0 1 L 8 5 L 0 9 z" fill="#c4a574" />
            </marker>
            <marker
              id="d3-arrow-downstream"
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="5"
              markerHeight="5"
              orient="auto-start-reverse"
            >
              <path d="M 0 1 L 8 5 L 0 9 z" fill="#6ea8c7" />
            </marker>
          </defs>
          <g className="d3-zoom-root">
            <g className="d3-headers" />
            <g className="d3-edges" />
            <g className="d3-nodes" />
          </g>
        </svg>

        {hoveredNode && tooltipPos ? (
          <div
            data-testid="d3-node-tooltip"
            style={{ left: tooltipPos.x, top: tooltipPos.y }}
            className="pointer-events-none absolute z-20 w-[216px] rounded border border-border bg-card/95 px-2.5 py-2 font-mono text-[10px] shadow-lg backdrop-blur-xs"
          >
            <div className="flex items-center justify-between gap-2 text-muted-foreground">
              <span className="font-semibold text-foreground">{kindBadgeLabel(hoveredNode.kind)}</span>
              <span>{hoveredNode.status.toUpperCase()}</span>
            </div>
            <p className="mt-0.5 truncate font-sans text-[11px] font-medium text-foreground">
              {hoveredNode.title}
            </p>
            <p className="mt-0.5 truncate text-muted-foreground">{hoveredNode.meta}</p>
            <p className="mt-1 text-[9.5px] text-muted-foreground tabular-nums">
              {lineage.upstreamNodeIds.size} upstream · {lineage.downstreamNodeIds.size} downstream ·{" "}
              {hoveredNode.progress}%
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
