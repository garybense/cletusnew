import { getSql } from "@/lib/db";
import { runHeartbeatSweep } from "./heartbeat.server";
import type { CletusSnapshot } from "./types";

export interface FleetStreamSink {
  sendJson: (payload: Record<string, unknown>) => void;
  close?: () => void;
}

type ClientFleetMessage =
  | {
      type: "ping";
      clientSentAt?: number;
    }
  | {
      type: "sync";
    };

const STREAM_INTERVAL_MS = 2_500;

function computeSnapshotRevision(snap: CletusSnapshot): string {
  const maxTaskUpdated = snap.tasks.reduce(
    (max, t) => Math.max(max, t.updatedAt ?? t.createdAt ?? 0),
    0,
  );
  const taskDigest = snap.tasks.map((t) => `${t.id}:${t.status}:${t.priority ?? "medium"}:${t.sortOrder ?? 0}`).join(",");
  const latestLogId = snap.logs[0]?.id ?? "";
  const latestEvtId = snap.taskEvents[snap.taskEvents.length - 1]?.id ?? "";
  const latestMsgId = snap.inbox[0]?.id ?? "";
  const latestCycleId = snap.cycles[0]?.id ?? "";
  return [
    snap.vitals.turns,
    snap.vitals.state,
    snap.paused ? 1 : 0,
    snap.activeDomain,
    snap.vitals.activeMissionId ?? "",
    snap.tasks.length,
    maxTaskUpdated,
    taskDigest,
    snap.taskEvents.length,
    latestEvtId,
    snap.logs.length,
    latestLogId,
    snap.inbox.length,
    latestMsgId,
    snap.cycles.length,
    latestCycleId,
  ].join("|");
}

export function createFleetStreamSession(sink: FleetStreamSink) {
  let closed = false;
  let inFlight = false;
  let lastRevision = "";

  async function pushStatus(extra?: { pongFor?: number; forceSnapshot?: boolean }): Promise<void> {
    if (closed || inFlight) return;
    inFlight = true;
    try {
      const sql = await getSql();
      const sweep = await runHeartbeatSweep(sql, { forceAll: false, minCooldownMs: 25_000 });
      const snap = sweep.snapshot;
      if (closed) return;

      sink.sendJson({
        type: "fleet:status",
        transport: "websocket",
        serverNow: snap.serverNow,
        paused: snap.paused,
        vitals: snap.vitals,
        children: snap.children,
        peers: snap.peers,
      });

      const rev = computeSnapshotRevision(snap);
      if (extra?.forceSnapshot || rev !== lastRevision) {
        lastRevision = rev;
        sink.sendJson({
          type: "snapshot:sync",
          revision: rev,
          snapshot: snap,
        });
      }

      if (typeof extra?.pongFor === "number") {
        sink.sendJson({
          type: "pong",
          clientSentAt: extra.pongFor,
          serverNow: snap.serverNow,
        });
      }
    } catch (err) {
      if (!closed) {
        sink.sendJson({
          type: "error",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } finally {
      inFlight = false;
    }
  }

  // Push initial authoritative fleet & snapshot state immediately on WebSocket open
  void pushStatus({ forceSnapshot: true });

  const timer = setInterval(() => {
    void pushStatus();
  }, STREAM_INTERVAL_MS);

  async function onClientMessage(rawText: string): Promise<void> {
    if (closed) return;
    let parsed: ClientFleetMessage;
    try {
      parsed = JSON.parse(rawText) as ClientFleetMessage;
    } catch {
      return;
    }

    if (parsed.type === "ping") {
      await pushStatus({
        pongFor: typeof parsed.clientSentAt === "number" ? parsed.clientSentAt : undefined,
      });
    } else if (parsed.type === "sync") {
      await pushStatus({ forceSnapshot: true });
    }
  }

  async function close(): Promise<void> {
    closed = true;
    clearInterval(timer);
  }

  return {
    onClientMessage,
    close,
  };
}
