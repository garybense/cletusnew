import { useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Bot,
  Cpu,
  Play,
  Plug,
  Radio,
  RefreshCw,
  Search,
  Wifi,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  buildFleetCensusRows,
  filterAndSortFleetCensus,
  formatFleetTransportStatus,
  summarizeFleetCensus,
  type FleetCategoryFilter,
  type FleetCensusRow,
  type FleetSortKey,
  type FleetStatusFilter,
  type SortDirection,
} from "@/lib/cletus/fleet-census";
import { useCletusStore } from "@/lib/cletus/store";
import { cn } from "@/lib/utils";
import { useMissionClock, useMissionField } from "./snapshot-context";
import { StatusDot } from "./status";
import { useFleetStreamContext } from "./use-fleet-status-stream";

function CategoryIcon({ category }: { category: FleetCensusRow["category"] }) {
  if (category === "coordinator") {
    return <Cpu className="size-3.5 shrink-0 text-warn" aria-hidden="true" />;
  }
  if (category === "device") {
    return <Plug className="size-3.5 shrink-0 text-ok" aria-hidden="true" />;
  }
  return <Bot className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />;
}

function SortIcon({
  column,
  sortKey,
  sortDir,
}: {
  column: FleetSortKey;
  sortKey: FleetSortKey;
  sortDir: SortDirection;
}) {
  if (sortKey !== column) {
    return <ArrowUpDown className="size-3 text-muted-foreground/60" aria-hidden="true" />;
  }
  return sortDir === "asc" ? (
    <ArrowUp className="size-3 text-foreground" aria-hidden="true" />
  ) : (
    <ArrowDown className="size-3 text-foreground" aria-hidden="true" />
  );
}

function ConnectivityDot({ online }: { online: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block size-2 shrink-0 rounded-full",
        online ? "bg-ok" : "bg-destructive/80",
      )}
    />
  );
}

export function FleetCensus() {
  const vitals = useMissionField((s) => s.vitals);
  const paused = useMissionField((s) => s.paused);
  const children = useMissionField((s) => s.children);
  const peers = useMissionField((s) => s.peers);
  const serverNow = useMissionField((s) => s.serverNow);
  const now = useMissionClock();

  const selectedNode = useCletusStore((s) => s.selectedNode);
  const setSelectedNode = useCletusStore((s) => s.setSelectedNode);
  const pingWorker = useCletusStore((s) => s.pingWorker);
  const runTurn = useCletusStore((s) => s.runTurn);
  const loading = useCletusStore((s) => s.loading);
  const turnRunning = useCletusStore((s) => s.turnRunning);

  const {
    transportMode,
    transportPreference,
    setTransportPreference,
    roundTripMs,
    triggerSync,
  } = useFleetStreamContext();

  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<FleetCategoryFilter>("all");
  const [statusFilter, setStatusFilter] = useState<FleetStatusFilter>("all");
  const [sortKey, setSortKey] = useState<FleetSortKey>("lastActive");
  const [sortDir, setSortDir] = useState<SortDirection>("desc");

  const allRows = useMemo(
    () =>
      buildFleetCensusRows({
        vitals,
        children,
        peers,
        paused,
        serverNow,
        now,
      }),
    [vitals, children, peers, paused, serverNow, now],
  );

  const summary = useMemo(() => summarizeFleetCensus(allRows), [allRows]);

  const visibleRows = useMemo(
    () =>
      filterAndSortFleetCensus(allRows, {
        query,
        category,
        statusFilter,
        sortKey,
        sortDir,
      }),
    [allRows, query, category, statusFilter, sortKey, sortDir],
  );

  function toggleSort(nextKey: FleetSortKey) {
    if (sortKey === nextKey) {
      setSortDir((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(nextKey);
      setSortDir(nextKey === "name" ? "asc" : "desc");
    }
  }

  function resetFilters() {
    setQuery("");
    setCategory("all");
    setStatusFilter("all");
  }

  async function handleProbe(row: FleetCensusRow) {
    if (!row.targetWorkerId) return;
    await pingWorker(row.targetWorkerId);
    toast.success(`Heartbeat verified for ${row.name}.`);
  }

  async function handleRunTurn(row: FleetCensusRow) {
    if (!row.targetAgentName) return;
    const res = await runTurn({ targetAgentName: row.targetAgentName });
    if (res.ok) {
      toast.success(`Executed turn for ${row.name}.`);
    } else if (res.error) {
      toast.error(res.error);
    }
  }

  const hasActiveFilters = query.trim().length > 0 || category !== "all" || statusFilter !== "all";
  const transportLabel = formatFleetTransportStatus(transportMode, roundTripMs);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-term/60">
      {/* Census Summary, Real-Time Fleet Status Stream & Filter Toolbar */}
      <div className="flex-none space-y-2 border-b border-border bg-secondary/25 px-3 py-2.5 text-xs">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-3 font-mono text-[11px]">
            <span className="font-semibold text-foreground">
              Fleet Census ({summary.total})
            </span>
            <span className="inline-flex items-center gap-1.5 text-ok tabular-nums">
              <StatusDot tone="ok" />
              <span>{summary.online} online</span>
            </span>
            <span
              className={cn(
                "inline-flex items-center gap-1.5 tabular-nums",
                summary.offline > 0 ? "text-destructive" : "text-muted-foreground",
              )}
            >
              <StatusDot tone={summary.offline > 0 ? "crit" : "mute"} />
              <span>{summary.offline} offline</span>
            </span>
            <span className="text-muted-foreground tabular-nums">
              {summary.agents} agents · {summary.devices} devices
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <span
              data-testid="fleet-transport-indicator"
              aria-live="polite"
              className={cn(
                "inline-flex h-7 items-center gap-1.5 rounded border border-border bg-card px-2 font-mono text-[11px] whitespace-nowrap tabular-nums",
                transportMode === "websocket"
                  ? "text-ok"
                  : transportMode === "polling"
                    ? "text-warn"
                    : "text-muted-foreground",
              )}
            >
              {transportMode === "websocket" ? (
                <ConnectivityDot online />
              ) : transportMode === "polling" ? (
                <Radio className="size-3 shrink-0" aria-hidden="true" />
              ) : (
                <Wifi className="size-3 shrink-0 animate-pulse" aria-hidden="true" />
              )}
              <span>{transportLabel}</span>
            </span>

            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                setTransportPreference((prev) => (prev === "auto" ? "polling" : "auto"))
              }
              aria-label={
                transportPreference === "auto"
                  ? "Switch Fleet Status to HTTP polling mode"
                  : "Switch Fleet Status to live WebSocket mode"
              }
              className="h-7 px-2 font-mono text-[11px] whitespace-nowrap shrink-0"
            >
              {transportPreference === "auto" ? "WS Auto" : "Poll Mode"}
            </Button>

            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={loading}
              onClick={() => void triggerSync()}
              aria-label="Sync fleet status"
              className="h-7 px-2 text-[11px] whitespace-nowrap shrink-0"
            >
              <RefreshCw className={cn("size-3", loading && "animate-spin")} />
              <span>Sync</span>
            </Button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-0 flex-1 basis-44">
            <Search
              className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Filter fleet census by name, role, or status"
              placeholder="Search agents, devices, or status…"
              className="h-7 bg-term pl-8 text-xs"
            />
          </div>

          <select
            aria-label="Filter by node category"
            value={category}
            onChange={(e) => setCategory(e.target.value as FleetCategoryFilter)}
            className="h-7 min-w-0 rounded border border-border bg-term px-2 font-mono text-[11px] text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          >
            <option value="all">All Nodes ({summary.total})</option>
            <option value="agent">Agents ({summary.agents})</option>
            <option value="device">Devices / APIs ({summary.devices})</option>
          </select>

          <select
            aria-label="Filter by fleet connectivity"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as FleetStatusFilter)}
            className="h-7 min-w-0 rounded border border-border bg-term px-2 font-mono text-[11px] text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          >
            <option value="all">All Connectivity</option>
            <option value="online">Online ({summary.online})</option>
            <option value="offline">Offline ({summary.offline})</option>
          </select>

          {hasActiveFilters ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={resetFilters}
              className="h-7 px-2 text-[11px] whitespace-nowrap shrink-0"
            >
              <X className="size-3" />
              <span>Clear</span>
            </Button>
          ) : null}
        </div>
      </div>

      {/* Fleet Census Table */}
      <div className="min-h-0 flex-1 overflow-auto">
        {visibleRows.length === 0 ? (
          <div className="flex h-full min-h-[180px] flex-col items-center justify-center gap-2 px-4 py-8 text-center">
            <p className="font-mono text-xs text-muted-foreground">
              No connected agents or devices match the current census filters.
            </p>
            {hasActiveFilters ? (
              <Button type="button" variant="outline" size="sm" onClick={resetFilters} className="h-7 text-xs">
                Reset Filters
              </Button>
            ) : null}
          </div>
        ) : (
          <table className="w-full min-w-[560px] border-collapse text-left text-xs">
            <thead className="sticky top-0 z-10 border-b border-border bg-card/95 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              <tr>
                <th
                  scope="col"
                  aria-sort={
                    sortKey === "name" ? (sortDir === "asc" ? "ascending" : "descending") : "none"
                  }
                  className="px-2 py-2 font-medium"
                >
                  <button
                    type="button"
                    onClick={() => toggleSort("name")}
                    className="inline-flex items-center gap-1 whitespace-nowrap hover:text-foreground"
                  >
                    <span>Agent / Device</span>
                    <SortIcon column="name" sortKey={sortKey} sortDir={sortDir} />
                  </button>
                </th>
                <th scope="col" className="px-1.5 py-2 font-medium whitespace-nowrap">
                  Type
                </th>
                <th
                  scope="col"
                  aria-sort={
                    sortKey === "status" ? (sortDir === "asc" ? "ascending" : "descending") : "none"
                  }
                  className="px-1.5 py-2 font-medium"
                >
                  <button
                    type="button"
                    onClick={() => toggleSort("status")}
                    aria-label="Sort by fleet status"
                    className="inline-flex items-center gap-1 whitespace-nowrap hover:text-foreground"
                  >
                    <span>Fleet Status</span>
                    <SortIcon column="status" sortKey={sortKey} sortDir={sortDir} />
                  </button>
                </th>
                <th
                  scope="col"
                  aria-sort={
                    sortKey === "uptime" ? (sortDir === "asc" ? "ascending" : "descending") : "none"
                  }
                  className="px-1.5 py-2 font-medium"
                >
                  <button
                    type="button"
                    onClick={() => toggleSort("uptime")}
                    aria-label="Sort by uptime"
                    className="inline-flex items-center gap-1 whitespace-nowrap hover:text-foreground"
                  >
                    <span>Uptime</span>
                    <SortIcon column="uptime" sortKey={sortKey} sortDir={sortDir} />
                  </button>
                </th>
                <th
                  scope="col"
                  aria-sort={
                    sortKey === "lastActive"
                      ? sortDir === "asc"
                        ? "ascending"
                        : "descending"
                      : "none"
                  }
                  className="px-1.5 py-2 font-medium"
                >
                  <button
                    type="button"
                    onClick={() => toggleSort("lastActive")}
                    aria-label="Sort by last active timestamp"
                    className="inline-flex items-center gap-1 whitespace-nowrap hover:text-foreground"
                  >
                    <span>Last Active (UTC)</span>
                    <SortIcon column="lastActive" sortKey={sortKey} sortDir={sortDir} />
                  </button>
                </th>
                <th scope="col" className="px-2 py-2 text-right font-medium whitespace-nowrap">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {visibleRows.map((row) => {
                const isSelected =
                  row.targetWorkerId !== undefined &&
                  selectedNode?.kind === "worker" &&
                  selectedNode.id === row.targetWorkerId;
                const isOnline = row.connectivity === "online";

                return (
                  <tr
                    key={row.id}
                    data-connectivity={row.connectivity}
                    className={cn(
                      "transition-colors hover:bg-secondary/35",
                      isSelected && "bg-secondary/50",
                    )}
                  >
                    <td className="px-2 py-2 align-top">
                      <div className="flex items-start gap-1.5">
                        <div className="mt-0.5">
                          <CategoryIcon category={row.category} />
                        </div>
                        <div className="min-w-0">
                          {row.targetWorkerId ? (
                            <button
                              type="button"
                              onClick={() =>
                                setSelectedNode({ kind: "worker", id: row.targetWorkerId! })
                              }
                              aria-label={`Inspect ${row.name}`}
                              className="text-left font-medium text-foreground hover:text-primary hover:underline"
                            >
                              {row.name}
                            </button>
                          ) : (
                            <span className="font-medium text-foreground">{row.name}</span>
                          )}
                          <p className="max-w-[160px] truncate font-mono text-[10px] text-muted-foreground">
                            {row.subtitle}
                          </p>
                          <p className="mt-0.5 max-w-[160px] truncate text-[11px] text-muted-foreground">
                            {row.detail}
                          </p>
                        </div>
                      </div>
                    </td>

                    <td className="px-1.5 py-2 align-top font-mono text-[11px] text-muted-foreground whitespace-nowrap tabular-nums">
                      <span className="block text-foreground/90">{row.kindLabel}</span>
                      <span className="block text-[10px]">{row.activityMeta}</span>
                    </td>

                    <td className="px-1.5 py-2 align-top">
                      <div className="flex flex-col items-start gap-0.5">
                        <span
                          aria-label={`${row.name} connectivity: ${row.connectivityLabel}`}
                          className={cn(
                            "inline-flex items-center gap-1.5 rounded border px-1.5 py-0.5 font-mono text-[10.5px] font-medium uppercase whitespace-nowrap",
                            isOnline
                              ? "border-ok/35 bg-ok/10 text-ok"
                              : "border-destructive/35 bg-destructive/10 text-destructive",
                          )}
                        >
                          <ConnectivityDot online={isOnline} />
                          <span>{row.connectivityLabel}</span>
                        </span>
                        <span className="max-w-[115px] truncate font-mono text-[10px] text-muted-foreground">
                          {row.connectivityReason}
                        </span>
                      </div>
                    </td>

                    <td className="px-1.5 py-2 align-top font-mono whitespace-nowrap tabular-nums">
                      <span
                        className={cn(
                          "block text-xs",
                          row.uptimeMs !== null ? "text-foreground" : "text-muted-foreground",
                        )}
                      >
                        {row.uptimeLabel}
                      </span>
                      {row.uptimeMs === null ? (
                        <span className="block text-[10px] text-muted-foreground/80">
                          {row.statusLabel === "Starting" ? "Awaiting probe" : "Inactive"}
                        </span>
                      ) : null}
                    </td>

                    <td className="px-1.5 py-2 align-top font-mono whitespace-nowrap tabular-nums">
                      <span className="block text-xs text-foreground">{row.lastActiveAgoLabel}</span>
                      <time
                        dateTime={new Date(row.lastActiveAt).toISOString()}
                        className="block text-[10px] text-muted-foreground whitespace-nowrap"
                      >
                        {row.lastActiveTimestampLabel}
                      </time>
                    </td>

                    <td className="px-2 py-2 align-top text-right whitespace-nowrap">
                      {row.targetWorkerId ? (
                        <div className="inline-flex items-center justify-end gap-1">
                          {row.statusLabel === "Healthy" && row.targetAgentName ? (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              disabled={turnRunning}
                              onClick={() => void handleRunTurn(row)}
                              aria-label={`Run turn for ${row.name}`}
                              className="h-6 px-1.5 text-[11px] whitespace-nowrap shrink-0"
                            >
                              <Play className="size-3" />
                              <span>Turn</span>
                            </Button>
                          ) : null}
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={loading}
                            onClick={() => void handleProbe(row)}
                            aria-label={`Probe ${row.name}`}
                            className="h-6 px-1.5 text-[11px] whitespace-nowrap shrink-0"
                          >
                            <RefreshCw className="size-3" />
                            <span>Probe</span>
                          </Button>
                        </div>
                      ) : row.category === "coordinator" ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={loading}
                          onClick={() => void triggerSync()}
                          aria-label="Refresh coordinator connectivity"
                          className="h-6 px-1.5 text-[11px] whitespace-nowrap shrink-0"
                        >
                          <RefreshCw className="size-3" />
                          <span>Ping</span>
                        </Button>
                      ) : (
                        <span className="font-mono text-[10px] text-muted-foreground">Connector</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
