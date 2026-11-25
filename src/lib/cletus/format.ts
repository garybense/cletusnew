import type {
  AgentState,
  AlertSeverity,
  ChildStatus,
  LogLevel,
  PeerStatus,
  SurvivalTier,
  TaskPriority,
  TaskStatus,
  WorkItemStatus,
} from "./types";

export type Tone = "ok" | "warn" | "crit" | "mute";

export function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`;
}

export function formatCredits(cents: number): string {
  return `${(cents / 100).toFixed(2)} cr`;
}

export function formatUptime(startedAt: number, now: number): string {
  const ms = Math.max(0, now - startedAt);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  if (h >= 24) {
    const d = Math.floor(h / 24);
    return `${d}d ${h % 24}h`;
  }
  return `${h}h ${m}m`;
}

export function formatAgo(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function formatClock(at: number): string {
  const d = new Date(at);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

export function cadenceMs(cadence: string): number {
  const match = cadence.match(/(\d+)\s*(m|h)/i);
  if (!match) return 300_000;
  const n = Number(match[1]);
  return match[2]!.toLowerCase() === "h" ? n * 3_600_000 : n * 60_000;
}

export function heartbeatPct(lastAgoMs: number, cadence: string): number {
  const window = cadenceMs(cadence);
  return Math.max(4, Math.round((1 - Math.min(1, lastAgoMs / window)) * 100));
}

export function tierLabel(tier: SurvivalTier): string {
  switch (tier) {
    case "dead":
      return "Dead";
    case "critical":
      return "Critical";
    case "low_compute":
      return "Low compute";
    case "normal":
      return "Normal";
    case "high":
      return "High";
  }
}

export function stateLabel(state: AgentState): string {
  switch (state) {
    case "running":
      return "Running";
    case "sleeping":
      return "Sleeping";
    case "paused":
      return "Paused";
  }
}

export function childStatusLabel(status: ChildStatus): string {
  switch (status) {
    case "healthy":
      return "Healthy";
    case "starting":
      return "Starting";
    case "unhealthy":
      return "Unhealthy";
    case "stopped":
      return "Stopped";
  }
}

export function taskStatusLabel(status: TaskStatus): string {
  switch (status) {
    case "pending":
      return "Pending";
    case "assigned":
      return "Assigned";
    case "running":
      return "Running";
    case "completed":
      return "Done";
    case "failed":
      return "Failed";
  }
}

export function normalizeTaskPriority(raw?: string | null): TaskPriority {
  const val = (raw ?? "").trim().toLowerCase();
  if (val === "high" || val === "low" || val === "medium") return val;
  return "medium";
}

export function taskPriorityLabel(priority?: TaskPriority): "Low" | "Medium" | "High" {
  switch (normalizeTaskPriority(priority)) {
    case "high":
      return "High";
    case "low":
      return "Low";
    case "medium":
    default:
      return "Medium";
  }
}

export function taskPriorityBadgeClass(priority?: TaskPriority): string {
  switch (normalizeTaskPriority(priority)) {
    case "high":
      return "border-[#c46a55]/55 bg-[#c46a55]/15 text-[#e88a76]";
    case "low":
      return "border-sky-500/45 bg-sky-500/12 text-sky-300";
    case "medium":
    default:
      return "border-warn/50 bg-warn/15 text-warn";
  }
}

export function logLevelLabel(level: LogLevel): string {
  switch (level) {
    case "info":
      return "info";
    case "warn":
      return "warn";
    case "error":
      return "error";
    case "tool":
      return "tool";
    case "thought":
      return "mind";
  }
}

export function agentTone(state: AgentState): Tone {
  if (state === "running") return "ok";
  if (state === "sleeping") return "warn";
  return "mute";
}

export function tierTone(tier: SurvivalTier): Tone {
  if (tier === "high" || tier === "normal") return "ok";
  if (tier === "low_compute") return "warn";
  if (tier === "critical" || tier === "dead") return "crit";
  return "mute";
}

export function childTone(status: ChildStatus): Tone {
  if (status === "healthy") return "ok";
  if (status === "starting") return "warn";
  if (status === "unhealthy") return "crit";
  return "mute";
}

export function taskTone(status: TaskStatus): Tone {
  if (status === "completed") return "ok";
  if (status === "running" || status === "assigned") return "warn";
  if (status === "failed") return "crit";
  return "mute";
}

export function workItemTone(status: WorkItemStatus): Tone {
  if (status === "completed") return "ok";
  if (status === "claimed" || status === "pending") return "warn";
  if (status === "failed" || status === "expired") return "crit";
  return "mute";
}

export function alertTone(severity: AlertSeverity): Tone {
  if (severity === "info") return "ok";
  if (severity === "warn") return "warn";
  return "crit";
}

export function logTone(level: LogLevel): Tone {
  if (level === "error") return "crit";
  if (level === "warn") return "warn";
  if (level === "thought") return "ok";
  return "mute";
}

export function peerTone(status: PeerStatus): Tone {
  if (status === "online") return "ok";
  if (status === "quiet") return "warn";
  return "mute";
}

export function toneTextClass(tone: Tone): string {
  switch (tone) {
    case "ok":
      return "text-ok";
    case "warn":
      return "text-warn";
    case "crit":
      return "text-destructive";
    case "mute":
      return "text-muted-foreground";
  }
}

export function nid(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-3)}`;
}
