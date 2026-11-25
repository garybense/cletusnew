import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import type { FleetStatusPayload, FleetTransportMode } from "@/lib/cletus/fleet-census";
import { useCletusStore } from "@/lib/cletus/store";
import type { CletusSnapshot } from "@/lib/cletus/types";

export type FleetTransportPreference = "auto" | "polling";

const POLL_INTERVAL_MS = 4_000;
const WS_PING_INTERVAL_MS = 4_000;

interface PongPayload {
  type: "pong";
  clientSentAt?: number;
  serverNow: number;
}

interface SnapshotSyncPayload {
  type: "snapshot:sync";
  revision: string;
  snapshot: CletusSnapshot;
}

export interface FleetStreamState {
  transportMode: FleetTransportMode;
  transportPreference: FleetTransportPreference;
  setTransportPreference: Dispatch<SetStateAction<FleetTransportPreference>>;
  roundTripMs: number | null;
  lastPulseAt: number | null;
  triggerSync: () => Promise<void>;
}

const FleetStreamContext = createContext<FleetStreamState | null>(null);

export function useFleetStatusStream(): FleetStreamState {
  const applyFleetStatus = useCletusStore((s) => s.applyFleetStatus);
  const applySnapshot = useCletusStore((s) => s.applySnapshot);
  const refresh = useCletusStore((s) => s.refresh);

  const [transportPreference, setTransportPreference] =
    useState<FleetTransportPreference>("auto");
  const [transportMode, setTransportMode] = useState<FleetTransportMode>("connecting");
  const [roundTripMs, setRoundTripMs] = useState<number | null>(null);
  const [lastPulseAt, setLastPulseAt] = useState<number | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttemptRef = useRef(0);
  const lastRevisionRef = useRef<string | null>(null);

  const runHttpPoll = useCallback(async () => {
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
    const state = useCletusStore.getState();
    if (state.paused || state.turnRunning) return;
    const started = performance.now();
    await refresh({ silent: true });
    const elapsed = Math.max(1, Math.round(performance.now() - started));
    setRoundTripMs(elapsed);
    setLastPulseAt(Date.now());
  }, [refresh]);

  const triggerSync = useCallback(async () => {
    const ws = wsRef.current;
    if (transportPreference === "auto" && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "ping", clientSentAt: Date.now() }));
      return;
    }
    await runHttpPoll();
  }, [runHttpPoll, transportPreference]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    let disposed = false;
    let reconnectTimer: number | null = null;
    let pollTimer: number | null = null;
    let pingTimer: number | null = null;

    const clearPoll = () => {
      if (pollTimer !== null) {
        window.clearInterval(pollTimer);
        pollTimer = null;
      }
    };

    const startFallbackPolling = () => {
      if (pollTimer !== null) return;
      setTransportMode("polling");
      void runHttpPoll();
      pollTimer = window.setInterval(() => {
        void runHttpPoll();
      }, POLL_INTERVAL_MS);
    };

    if (transportPreference === "polling") {
      startFallbackPolling();
      return () => {
        disposed = true;
        clearPoll();
      };
    }

    const connectWs = () => {
      if (disposed) return;
      setTransportMode((prev) => (prev === "websocket" ? "websocket" : "connecting"));

      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${proto}//${window.location.host}/ws/fleet`);
      wsRef.current = ws;

      ws.onopen = () => {
        if (disposed) {
          ws.close();
          return;
        }
        reconnectAttemptRef.current = 0;
        clearPoll();
        setTransportMode("websocket");
        ws.send(JSON.stringify({ type: "ping", clientSentAt: Date.now() }));

        if (pingTimer !== null) window.clearInterval(pingTimer);
        pingTimer = window.setInterval(() => {
          if (ws.readyState === WebSocket.OPEN && document.visibilityState === "visible") {
            ws.send(JSON.stringify({ type: "ping", clientSentAt: Date.now() }));
          }
        }, WS_PING_INTERVAL_MS);
      };

      ws.onmessage = (event) => {
        if (disposed || typeof event.data !== "string") return;
        try {
          const parsed = JSON.parse(event.data) as
            | FleetStatusPayload
            | SnapshotSyncPayload
            | PongPayload
            | { type: string };
          if (parsed.type === "snapshot:sync") {
            const sync = parsed as SnapshotSyncPayload;
            const storeState = useCletusStore.getState();
            if (!storeState.turnRunning && !storeState.paused && sync.revision !== lastRevisionRef.current) {
              lastRevisionRef.current = sync.revision;
              applySnapshot(sync.snapshot);
              setLastPulseAt(Date.now());
            }
          } else if (parsed.type === "fleet:status") {
            const payload = parsed as FleetStatusPayload;
            applyFleetStatus({
              serverNow: payload.serverNow,
              paused: payload.paused,
              vitals: payload.vitals,
              children: payload.children,
              peers: payload.peers,
            });
            setLastPulseAt(Date.now());
          } else if (parsed.type === "pong") {
            const pong = parsed as PongPayload;
            if (typeof pong.clientSentAt === "number") {
              setRoundTripMs(Math.max(1, Date.now() - pong.clientSentAt));
            }
            setLastPulseAt(Date.now());
          }
        } catch {
          // Ignore malformed JSON frames
        }
      };

      ws.onerror = () => {
        if (!disposed) {
          startFallbackPolling();
        }
      };

      ws.onclose = () => {
        if (pingTimer !== null) {
          window.clearInterval(pingTimer);
          pingTimer = null;
        }
        if (wsRef.current === ws) {
          wsRef.current = null;
        }
        if (disposed) return;

        startFallbackPolling();
        const attempt = reconnectAttemptRef.current;
        reconnectAttemptRef.current += 1;
        const delayMs = Math.min(10_000, 1_500 * Math.pow(2, attempt));
        reconnectTimer = window.setTimeout(() => {
          connectWs();
        }, delayMs);
      };
    };

    connectWs();

    return () => {
      disposed = true;
      clearPoll();
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      if (pingTimer !== null) window.clearInterval(pingTimer);
      const ws = wsRef.current;
      wsRef.current = null;
      if (ws) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.close();
        } else if (ws.readyState === WebSocket.CONNECTING) {
          ws.addEventListener(
            "open",
            () => {
              ws.close();
            },
            { once: true },
          );
        }
      }
    };
  }, [applyFleetStatus, applySnapshot, runHttpPoll, transportPreference]);

  return {
    transportMode,
    transportPreference,
    setTransportPreference,
    roundTripMs,
    lastPulseAt,
    triggerSync,
  };
}

export function FleetStreamProvider({ children }: { children: ReactNode }) {
  const value = useFleetStatusStream();
  return createElement(FleetStreamContext.Provider, { value }, children);
}

export function useFleetStreamContext(): FleetStreamState {
  const ctx = useContext(FleetStreamContext);
  if (!ctx) {
    throw new Error("useFleetStreamContext must be used inside FleetStreamProvider");
  }
  return ctx;
}
