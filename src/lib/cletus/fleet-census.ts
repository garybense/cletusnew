import {
  agentTone,
  childStatusLabel,
  childTone,
  formatAgo,
  stateLabel,
  toneTextClass,
  type Tone,
} from "./format";
import type { Child, Peer, PeerStatus, Vitals } from "./types";

export type FleetNodeCategory = "coordinator" | "agent" | "device";
export type FleetCategoryFilter = "all" | "agent" | "device";
export type FleetStatusFilter = "all" | "online" | "offline";
export type FleetSortKey = "name" | "status" | "uptime" | "lastActive";
export type SortDirection = "asc" | "desc";
export type ConnectivityState = "online" | "offline";
export type FleetTransportMode = "websocket" | "polling" | "connecting" | "offline";

export interface FleetStatusPayload {
  type: "fleet:status";
  transport: "websocket";
  serverNow: number;
  paused: boolean;
  vitals: Vitals;
  children: Child[];
  peers: Peer[];
}

export interface FleetCensusRow {
  id: string;
  targetWorkerId?: string;
  targetAgentName?: string;
  name: string;
  subtitle: string;
  category: FleetNodeCategory;
  kindLabel: string;
  connectivity: ConnectivityState;
  connectivityLabel: "Online" | "Offline";
  connectivityReason: string;
  statusLabel: string;
  tone: Tone;
  statusRank: number;
  uptimeMs: number | null;
  uptimeLabel: string;
  lastActiveAt: number;
  lastActiveAgoLabel: string;
  lastActiveTimestampLabel: string;
  latencyMs: number | null;
  detail: string;
  activityMeta: string;
}

export interface FleetCensusSummary {
  total: number;
  online: number;
  offline: number;
  agents: number;
  devices: number;
}

export interface BuildFleetCensusInput {
  vitals: Vitals;
  children: Child[];
  peers: Peer[];
  paused?: boolean;
  serverNow: number;
  now: number;
}

export interface FleetCensusFilterOptions {
  query: string;
  category: FleetCategoryFilter;
  statusFilter: FleetStatusFilter;
  sortKey: FleetSortKey;
  sortDir: SortDirection;
}

export function formatUtcTimestamp(at: number): string {
  const safe = Number.isFinite(at) ? Math.max(0, at) : 0;
  const d = new Date(safe);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  return `${year}-${month}-${day} ${hh}:${mm}:${ss}`;
}

export function formatDurationMs(ms: number): string {
  const safeMs = Math.max(0, ms);
  const totalMinutes = Math.floor(safeMs / 60_000);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h >= 24) {
    const d = Math.floor(h / 24);
    return `${d}d ${h % 24}h`;
  }
  if (h === 0 && m === 0) {
    return `${Math.floor(safeMs / 1000)}s`;
  }
  return `${h}h ${m}m`;
}

export function peerStatusLabel(status: PeerStatus): string {
  switch (status) {
    case "online":
      return "Online";
    case "quiet":
      return "Quiet";
    case "offline":
      return "Offline";
  }
}

function peerStatusTone(status: PeerStatus): Tone {
  if (status === "online") return "ok";
  if (status === "quiet") return "warn";
  return "mute";
}

function rankConnectivityAndTone(connectivity: ConnectivityState, tone: Tone): number {
  const base = connectivity === "online" ? 10 : 0;
  switch (tone) {
    case "crit":
      return base + 0;
    case "warn":
      return base + 1;
    case "mute":
      return base + 2;
    case "ok":
      return base + 3;
  }
}

export function evaluateCoordinatorConnectivity(
  vitals: Vitals,
  paused: boolean,
): { connectivity: ConnectivityState; reason: string } {
  if (paused || vitals.state === "paused") {
    return { connectivity: "offline", reason: "Paused" };
  }
  if (vitals.state === "sleeping") {
    return { connectivity: "offline", reason: "Sleeping" };
  }
  return { connectivity: "online", reason: "Running" };
}

export function evaluateChildConnectivity(
  child: Child,
): { connectivity: ConnectivityState; reason: string } {
  if (child.status === "healthy") {
    return {
      connectivity: "online",
      reason: typeof child.latencyMs === "number" ? `Healthy · ${child.latencyMs}ms` : "Healthy",
    };
  }
  if (child.status === "starting") {
    return { connectivity: "offline", reason: "Starting · awaiting probe" };
  }
  if (child.status === "unhealthy") {
    return { connectivity: "offline", reason: child.errorNote ?? "Unhealthy heartbeat" };
  }
  return { connectivity: "offline", reason: "Stopped" };
}

export function evaluatePeerConnectivity(
  peer: Peer,
): { connectivity: ConnectivityState; reason: string } {
  if (peer.status === "online") {
    return { connectivity: "online", reason: peer.claimed ? "Verified · active" : "Connected" };
  }
  if (peer.status === "quiet") {
    return { connectivity: "offline", reason: "Quiet · idle" };
  }
  return { connectivity: "offline", reason: "Offline" };
}

export function formatFleetTransportStatus(
  mode: FleetTransportMode,
  roundTripMs: number | null,
): string {
  switch (mode) {
    case "websocket":
      return roundTripMs !== null ? `WS Live · ${roundTripMs}ms` : "WS Live";
    case "polling":
      return "Polling · 4s";
    case "connecting":
      return "Connecting…";
    case "offline":
      return "Stream Paused";
  }
}

export function buildFleetCensusRows({
  vitals,
  children,
  peers,
  paused = false,
  serverNow,
  now,
}: BuildFleetCensusInput): FleetCensusRow[] {
  const safeNow = Number.isFinite(now) ? now : serverNow;
  const safeServerNow = Number.isFinite(serverNow) ? serverNow : safeNow;
  const rows: FleetCensusRow[] = [];

  const rootConn = evaluateCoordinatorConnectivity(vitals, paused);
  const rootTone: Tone = rootConn.connectivity === "online" ? agentTone(vitals.state) : paused ? "mute" : "warn";
  const rootUptimeMs = rootConn.connectivity === "online" ? Math.max(0, safeNow - vitals.startedAt) : null;
  const rootLastActiveAt = Math.max(0, safeServerNow);

  rows.push({
    id: `core:${vitals.sigil}`,
    name: `${vitals.name} (${vitals.sigil})`,
    subtitle: `root coordinator · ${vitals.model}`,
    category: "coordinator",
    kindLabel: "Coordinator",
    connectivity: rootConn.connectivity,
    connectivityLabel: rootConn.connectivity === "online" ? "Online" : "Offline",
    connectivityReason: rootConn.reason,
    statusLabel: paused ? "Paused" : stateLabel(vitals.state),
    tone: rootTone,
    statusRank: rankConnectivityAndTone(rootConn.connectivity, rootTone),
    uptimeMs: rootUptimeMs,
    uptimeLabel: rootUptimeMs !== null ? formatDurationMs(rootUptimeMs) : "—",
    lastActiveAt: rootLastActiveAt,
    lastActiveAgoLabel: formatAgo(rootLastActiveAt, safeNow),
    lastActiveTimestampLabel: formatUtcTimestamp(rootLastActiveAt),
    latencyMs: null,
    detail: vitals.autoLoop ? "Auto-loop scheduler active" : "Manual / decree-driven execution",
    activityMeta: `${vitals.turns} turns`,
  });

  for (const child of children) {
    const tone = childTone(child.status);
    const conn = evaluateChildConnectivity(child);
    const active = child.status === "healthy" || child.status === "unhealthy";
    const lastActiveAt = Math.max(0, safeServerNow - Math.max(0, child.lastBeatAgoMs));
    const uptimeMs = active ? Math.max(0, safeNow - vitals.startedAt) : null;

    rows.push({
      id: `worker:${child.id}`,
      targetWorkerId: child.id,
      targetAgentName: child.name,
      name: child.name,
      subtitle: `${child.role} · ${child.model}`,
      category: "agent",
      kindLabel: child.kind === "openclaw" ? "OpenClaw Agent" : "Local Agent",
      connectivity: conn.connectivity,
      connectivityLabel: conn.connectivity === "online" ? "Online" : "Offline",
      connectivityReason: conn.reason,
      statusLabel: childStatusLabel(child.status),
      tone,
      statusRank: rankConnectivityAndTone(conn.connectivity, tone),
      uptimeMs,
      uptimeLabel: uptimeMs !== null ? formatDurationMs(uptimeMs) : "—",
      lastActiveAt,
      lastActiveAgoLabel: formatAgo(lastActiveAt, safeNow),
      lastActiveTimestampLabel: formatUtcTimestamp(lastActiveAt),
      latencyMs: typeof child.latencyMs === "number" ? child.latencyMs : null,
      detail: child.errorNote ?? child.task ?? "Standby — ready for assignment",
      activityMeta: `${child.cycleCount} cycles`,
    });
  }

  for (const peer of peers) {
    const tone = peerStatusTone(peer.status);
    const conn = evaluatePeerConnectivity(peer);
    const active = peer.status === "online" || peer.status === "quiet";
    const lastActiveAt = Math.max(0, safeServerNow - Math.max(0, peer.lastAgoMs));
    const uptimeMs = active ? Math.max(0, safeNow - vitals.startedAt) : null;

    rows.push({
      id: `peer:${peer.id}`,
      name: peer.name,
      subtitle: peer.handle,
      category: "device",
      kindLabel: peer.claimed ? "Verified Connector" : "External Device",
      connectivity: conn.connectivity,
      connectivityLabel: conn.connectivity === "online" ? "Online" : "Offline",
      connectivityReason: conn.reason,
      statusLabel: peerStatusLabel(peer.status),
      tone,
      statusRank: rankConnectivityAndTone(conn.connectivity, tone),
      uptimeMs,
      uptimeLabel: uptimeMs !== null ? formatDurationMs(uptimeMs) : "—",
      lastActiveAt,
      lastActiveAgoLabel: formatAgo(lastActiveAt, safeNow),
      lastActiveTimestampLabel: formatUtcTimestamp(lastActiveAt),
      latencyMs: null,
      detail: peer.note || "Connected endpoint telemetry",
      activityMeta: `${peer.posts} events`,
    });
  }

  return rows;
}

export function filterAndSortFleetCensus(
  rows: FleetCensusRow[],
  options: FleetCensusFilterOptions,
): FleetCensusRow[] {
  const q = options.query.trim().toLowerCase();

  const filtered = rows.filter((row) => {
    if (options.category === "agent" && row.category === "device") return false;
    if (options.category === "device" && row.category !== "device") return false;
    if (options.statusFilter === "online" && row.connectivity !== "online") return false;
    if (options.statusFilter === "offline" && row.connectivity !== "offline") return false;

    if (!q) return true;
    const haystack = [
      row.name,
      row.subtitle,
      row.kindLabel,
      row.connectivityLabel,
      row.connectivityReason,
      row.statusLabel,
      row.detail,
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(q);
  });

  const dir = options.sortDir === "asc" ? 1 : -1;

  return [...filtered].sort((a, b) => {
    let cmp = 0;
    switch (options.sortKey) {
      case "name":
        cmp = a.name.localeCompare(b.name);
        break;
      case "status":
        cmp = a.statusRank - b.statusRank;
        break;
      case "uptime":
        cmp = (a.uptimeMs ?? -1) - (b.uptimeMs ?? -1);
        break;
      case "lastActive":
        cmp = a.lastActiveAt - b.lastActiveAt;
        break;
    }
    if (cmp !== 0) return cmp * dir;
    return a.name.localeCompare(b.name);
  });
}

export function summarizeFleetCensus(rows: FleetCensusRow[]): FleetCensusSummary {
  let online = 0;
  let offline = 0;
  let agents = 0;
  let devices = 0;

  for (const row of rows) {
    if (row.connectivity === "online") online += 1;
    else offline += 1;

    if (row.category === "device") devices += 1;
    else agents += 1;
  }

  return {
    total: rows.length,
    online,
    offline,
    agents,
    devices,
  };
}

export { toneTextClass };
