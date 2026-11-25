import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFleetCensusRows,
  evaluateChildConnectivity,
  evaluateCoordinatorConnectivity,
  filterAndSortFleetCensus,
  formatDurationMs,
  formatFleetTransportStatus,
  formatUtcTimestamp,
  summarizeFleetCensus,
} from "./fleet-census";
import type { Child, Peer, Vitals } from "./types";

const BASE_NOW = 1_757_596_800_000; // 2025-09-11T13:20:00.000Z

const SAMPLE_VITALS: Vitals = {
  name: "Cletus",
  state: "running",
  model: "nvidia/llama-3.3-nemotron-super-49b-v1",
  tier: "normal",
  creditsCents: 18420,
  usdcCents: 1240,
  reserveCents: 1000,
  turns: 12,
  startedAt: BASE_NOW - (14 * 3_600_000 + 22 * 60_000),
  sleepUntil: null,
  creator: "creator",
  sigil: "CLETUS-CORE-01",
  autoLoop: false,
  activeMissionId: "msn_core_01",
  activeDomain: "mas_rnd",
  creditsSyntheticOverride: false,
};

const SAMPLE_CHILDREN: Child[] = [
  {
    id: "agt_orchestrator",
    name: "Orchestrator-Prime",
    kind: "local",
    status: "healthy",
    role: "orchestrator",
    lastBeatAgoMs: 4_000,
    task: "Coordinating mission DAG",
    latencyMs: 38,
    model: "nvidia/llama-3.3-nemotron-super-49b-v1",
    capabilities: ["decompose_mission"],
    autonomyLevel: "autonomous",
    cycleCount: 6,
  },
  {
    id: "agt_systems",
    name: "Systems-Worker-02",
    kind: "openclaw",
    status: "starting",
    role: "systems",
    lastBeatAgoMs: 125_000,
    task: "Awaiting health probe",
    latencyMs: undefined,
    model: "meta/llama-3.3-70b-instruct",
    capabilities: ["execute_shell"],
    autonomyLevel: "gated",
    cycleCount: 0,
  },
  {
    id: "agt_stopped",
    name: "Archive-Worker-03",
    kind: "local",
    status: "stopped",
    role: "archive",
    lastBeatAgoMs: 900_000,
    task: "Halted manually",
    model: "nvidia/llama-3.1-nemotron-nano-8b-v1",
    capabilities: [],
    autonomyLevel: "supervised",
    cycleCount: 2,
  },
];

const SAMPLE_PEERS: Peer[] = [
  {
    id: "pr_arxiv",
    name: "arXiv MAS Feed",
    handle: "export.arxiv.org",
    status: "online",
    lastAgoMs: 46_000,
    note: "Live Atom XML connector active.",
    claimed: true,
    posts: 18,
    followers: 42,
    following: 11,
    karma: 126,
  },
  {
    id: "pr_relay",
    name: "Edge Telemetry Relay",
    handle: "relay.local.mesh",
    status: "offline",
    lastAgoMs: 7_200_000,
    note: "Heartbeat timed out.",
    claimed: false,
    posts: 3,
    followers: null,
    following: null,
    karma: null,
  },
];

test("buildFleetCensusRows synthesizes coordinator, agents, and devices with anchored timestamps and connectivity", () => {
  const tickNow = BASE_NOW + 10_000;
  const rows = buildFleetCensusRows({
    vitals: SAMPLE_VITALS,
    children: SAMPLE_CHILDREN,
    peers: SAMPLE_PEERS,
    serverNow: BASE_NOW,
    now: tickNow,
  });

  assert.equal(rows.length, 6);

  const core = rows.find((r) => r.id === "core:CLETUS-CORE-01");
  assert.ok(core);
  assert.equal(core.connectivity, "online");
  assert.equal(core.connectivityLabel, "Online");
  assert.equal(core.statusLabel, "Running");
  assert.equal(core.uptimeLabel, "14h 22m");
  assert.equal(core.lastActiveAt, BASE_NOW);
  assert.equal(core.lastActiveAgoLabel, "10s ago");
  assert.equal(core.lastActiveTimestampLabel, formatUtcTimestamp(BASE_NOW));

  const orch = rows.find((r) => r.targetWorkerId === "agt_orchestrator");
  assert.ok(orch);
  assert.equal(orch.connectivity, "online");
  assert.equal(orch.connectivityLabel, "Online");
  assert.equal(orch.connectivityReason, "Healthy · 38ms");
  assert.equal(orch.uptimeLabel, "14h 22m");
  assert.equal(orch.lastActiveAt, BASE_NOW - 4_000);
  assert.equal(orch.lastActiveAgoLabel, "14s ago");

  const starting = rows.find((r) => r.targetWorkerId === "agt_systems");
  assert.ok(starting);
  assert.equal(starting.connectivity, "offline");
  assert.equal(starting.connectivityLabel, "Offline");
  assert.equal(starting.statusLabel, "Starting");
  assert.equal(starting.uptimeMs, null);
  assert.equal(starting.uptimeLabel, "—");

  const stopped = rows.find((r) => r.targetWorkerId === "agt_stopped");
  assert.ok(stopped);
  assert.equal(stopped.connectivity, "offline");
  assert.equal(stopped.uptimeMs, null);
  assert.equal(stopped.uptimeLabel, "—");

  const offlinePeer = rows.find((r) => r.id === "peer:pr_relay");
  assert.ok(offlinePeer);
  assert.equal(offlinePeer.category, "device");
  assert.equal(offlinePeer.connectivity, "offline");
  assert.equal(offlinePeer.statusLabel, "Offline");
  assert.equal(offlinePeer.uptimeMs, null);
  assert.equal(offlinePeer.uptimeLabel, "—");
});

test("evaluateCoordinatorConnectivity and evaluateChildConnectivity classify online vs offline states", () => {
  assert.deepEqual(evaluateCoordinatorConnectivity(SAMPLE_VITALS, false), {
    connectivity: "online",
    reason: "Running",
  });
  assert.deepEqual(evaluateCoordinatorConnectivity(SAMPLE_VITALS, true), {
    connectivity: "offline",
    reason: "Paused",
  });
  assert.deepEqual(
    evaluateCoordinatorConnectivity({ ...SAMPLE_VITALS, state: "sleeping" }, false),
    { connectivity: "offline", reason: "Sleeping" },
  );

  assert.deepEqual(evaluateChildConnectivity(SAMPLE_CHILDREN[0]!), {
    connectivity: "online",
    reason: "Healthy · 38ms",
  });
  assert.deepEqual(
    evaluateChildConnectivity({ ...SAMPLE_CHILDREN[0]!, status: "unhealthy", errorNote: "Socket timeout" }),
    { connectivity: "offline", reason: "Socket timeout" },
  );
});

test("filterAndSortFleetCensus filters by category, online/offline connectivity, query, and sorts accurately", () => {
  const rows = buildFleetCensusRows({
    vitals: SAMPLE_VITALS,
    children: SAMPLE_CHILDREN,
    peers: SAMPLE_PEERS,
    serverNow: BASE_NOW,
    now: BASE_NOW,
  });

  const devicesOnly = filterAndSortFleetCensus(rows, {
    query: "",
    category: "device",
    statusFilter: "all",
    sortKey: "name",
    sortDir: "asc",
  });
  assert.deepEqual(
    devicesOnly.map((r) => r.name),
    ["arXiv MAS Feed", "Edge Telemetry Relay"],
  );

  const offlineOnly = filterAndSortFleetCensus(rows, {
    query: "",
    category: "all",
    statusFilter: "offline",
    sortKey: "name",
    sortDir: "asc",
  });
  assert.deepEqual(
    offlineOnly.map((r) => r.name),
    ["Archive-Worker-03", "Edge Telemetry Relay", "Systems-Worker-02"],
  );

  const onlineOnly = filterAndSortFleetCensus(rows, {
    query: "",
    category: "all",
    statusFilter: "online",
    sortKey: "name",
    sortDir: "asc",
  });
  assert.deepEqual(
    onlineOnly.map((r) => r.name),
    ["arXiv MAS Feed", "Cletus (CLETUS-CORE-01)", "Orchestrator-Prime"],
  );

  const queryMatch = filterAndSortFleetCensus(rows, {
    query: "offline",
    category: "all",
    statusFilter: "all",
    sortKey: "name",
    sortDir: "asc",
  });
  assert.equal(queryMatch.length, 3);

  const byLastActiveDesc = filterAndSortFleetCensus(rows, {
    query: "",
    category: "all",
    statusFilter: "all",
    sortKey: "lastActive",
    sortDir: "desc",
  });
  assert.equal(byLastActiveDesc[0]?.id, "core:CLETUS-CORE-01");
  assert.equal(byLastActiveDesc[byLastActiveDesc.length - 1]?.id, "peer:pr_relay");
});

test("summarizeFleetCensus and formatFleetTransportStatus report accurate connectivity totals", () => {
  const rows = buildFleetCensusRows({
    vitals: SAMPLE_VITALS,
    children: SAMPLE_CHILDREN,
    peers: SAMPLE_PEERS,
    serverNow: BASE_NOW,
    now: BASE_NOW,
  });

  assert.deepEqual(summarizeFleetCensus(rows), {
    total: 6,
    online: 3,
    offline: 3,
    agents: 4,
    devices: 2,
  });

  assert.equal(formatFleetTransportStatus("websocket", 12), "WS Live · 12ms");
  assert.equal(formatFleetTransportStatus("polling", null), "Polling · 4s");
  assert.equal(formatFleetTransportStatus("connecting", null), "Connecting…");
  assert.equal(formatFleetTransportStatus("offline", null), "Stream Paused");
});

test("formatDurationMs handles seconds, hours, and multi-day durations", () => {
  assert.equal(formatDurationMs(42_000), "42s");
  assert.equal(formatDurationMs(3_600_000 + 5 * 60_000), "1h 5m");
  assert.equal(formatDurationMs(26 * 3_600_000), "1d 2h");
});
