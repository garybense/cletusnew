import { create } from "zustand";
import {
  activateDomainPackServer,
  addTaskServer,
  configureAgentServer,
  controlMissionServer,
  controlWorkItemServer,
  enqueueWorkItemServer,
  getSnapshotServer,
  issueDecreeServer,
  launchMissionServer,
  pingWorkerServer,
  reorderTasksServer,
  runAgentTurnServer,
  runEvolutionStepServer,
  runHeartbeatSweepServer,
  sendAgentMessageServer,
  setSimulatedCreditsServer,
  spawnEvolutionMissionServer,
  synthesizeToolServer,
  testToolServer,
  toggleAutoLoopServer,
  toggleEvolutionTrajectoryServer,
  togglePausedServer,
  toggleSkillServer,
  toggleSleepServer,
  updateTaskServer,
} from "./server";
import { canTransitionTaskStatus } from "./mas-engine";
import { applyOptimisticTaskUpdate, applyTaskOrder } from "./task-order";
import type {
  AgentMessageType,
  Child,
  CletusSnapshot,
  CycleMode,
  DomainId,
  EvolutionTrajectorySlug,
  JsonObject,
  Peer,
  TaskPriority,
  TaskStatus,
  Vitals,
} from "./types";

const SEED_NOW = 1_757_596_800_000;
const CREATOR = "92n3wZ6uKjSJweFTZ9QEZwtxy5cnDbVxLgQMf2GivCPa";

const INITIAL_SNAPSHOT: CletusSnapshot = {
  vitals: {
    name: "Cletus",
    state: "running",
    model: "nvidia/llama-3.3-nemotron-super-49b-v1",
    tier: "normal",
    creditsCents: 18420,
    usdcCents: 1240,
    reserveCents: 1000,
    turns: 12,
    startedAt: SEED_NOW - 14 * 3_600_000,
    sleepUntil: null,
    creator: CREATOR,
    sigil: "CLETUS-CORE-01",
    autoLoop: false,
    activeMissionId: null,
    activeDomain: "mas_rnd",
    creditsSyntheticOverride: false,
  },
  activeDomain: "mas_rnd",
  paused: false,
  nvidiaConfigured: false,
  envReadiness: {
    nvidiaConfigured: false,
    databaseBackend: "pglite",
    githubTokenConfigured: false,
    telegramConfigured: false,
    solanaRpcConfigured: false,
  },
  missions: [],
  cycles: [],
  tools: [],
  agentMessages: [],
  goals: [],
  tasks: [],
  taskEvents: [],
  workQueue: [],
  children: [],
  thoughts: [],
  logs: [],
  inbox: [],
  alerts: [],
  spend24h: [],
  spendByModel: [],
  toolSpends: [],
  denials: [],
  skills: [],
  heartbeats: [],
  entelechy: {
    mission:
      "Execute autonomous multi-agent missions through verifiable planning, tool synthesis, and capital preservation.",
    riskPosture: "capital_preserving",
    confidence: 0.84,
    priorities: [],
    avoid: [],
    recommendation: "",
  },
  peers: [],
  openclaw: [],
  domainMemories: [],
  audioBriefings: [],
  evolutionTrajectories: [],
  evolutionEvents: [],
  evolutionSummary: {
    isIdle: false,
    idleReason: "Initializing telemetry…",
    activeTaskCount: 0,
    pendingWorkCount: 0,
    pendingHandoffCount: 0,
    nextTrajectorySlug: "capability_forging",
    nextTrajectoryTitle: "Autonomous Tool Synthesis & Benchmarking",
    nextActorName: "Execution-Engineer-01",
    recommendedAction: "Evaluate frontier capabilities and forge missing domain tools.",
    overallMaturity: 28,
    capabilitiesUnlockedCount: 2,
    selfEvolutionCyclesCount: 0,
    gaps: {
      untestedTools: [],
      unboundTools: [],
      missingDomainCapabilities: [],
      domainMemoryCount: 0,
      recentFaultCount: 0,
      recentDenialCount: 0,
      recommendedTrajectory: "capability_forging",
    },
  },
  pendingAck: null,
  serverNow: SEED_NOW,
};

export interface SelectedNode {
  kind: "mission" | "goal" | "task" | "worker";
  id: string;
}

export interface CletusStore extends CletusSnapshot {
  now: number;
  hydrated: boolean;
  loading: boolean;
  turnRunning: boolean;
  turnError: string | null;
  selectedNode: SelectedNode | null;
  lastToolOutput: { toolName: string; ok: boolean; durationMs: number; output: JsonObject } | null;
  setSelectedNode: (node: SelectedNode | null) => void;
  clearTurnError: () => void;
  tickClock: () => void;
  applySnapshot: (snap: CletusSnapshot) => void;
  applyFleetStatus: (payload: {
    serverNow: number;
    paused: boolean;
    vitals: Vitals;
    children: Child[];
    peers: Peer[];
  }) => void;
  hydrate: (initial?: CletusSnapshot) => Promise<void>;
  refresh: (options?: { silent?: boolean }) => Promise<void>;
  issueDecree: (text: string, targetAgentName?: string) => Promise<{ ok: boolean; error?: string }>;
  launchMission: (input: {
    title?: string;
    objective: string;
    maxCycles?: number;
    autoLoop?: boolean;
  }) => Promise<{ ok: boolean; error?: string; replyText?: string }>;
  runTurn: (opts?: {
    workItemId?: string;
    targetAgentName?: string;
    steps?: number;
  }) => Promise<{
    ok: boolean;
    error?: string;
    actorName?: string;
    handoffTo?: string;
    cyclesExecuted?: number;
    mode?: CycleMode;
  }>;
  runEvolutionStep: (
    trajectorySlug?: EvolutionTrajectorySlug,
    steps?: number,
  ) => Promise<{
    ok: boolean;
    error?: string;
    actorName?: string;
    cyclesExecuted?: number;
  }>;
  spawnEvolutionMission: (
    trajectorySlug: EvolutionTrajectorySlug,
  ) => Promise<{ ok: boolean; missionId?: string; error?: string }>;
  toggleEvolutionTrajectory: (slug: EvolutionTrajectorySlug) => Promise<void>;
  toggleAutoLoop: () => Promise<void>;
  setSimulatedCredits: (creditsCents: number) => Promise<void>;
  configureAgent: (input: {
    agentName: string;
    role: string;
    systemPrompt: string;
    capabilities: string[];
    taskNote?: string;
    verifyHealthy?: boolean;
  }) => Promise<void>;
  synthesizeTool: (input: {
    name: string;
    category: string;
    kind: "http_json" | "nvidia_analyzer";
    description: string;
    urlTemplate?: string;
    promptTemplate?: string;
  }) => Promise<void>;
  testTool: (toolName: string, argsJson: string) => Promise<{ ok: boolean; error?: string }>;
  sendAgentMessage: (input: {
    fromAgent: string;
    toAgent: string;
    messageType: AgentMessageType;
    subject: string;
    payloadStr: string;
    executeHandoffTurn?: boolean;
  }) => Promise<{ ok: boolean; error?: string }>;
  enqueueWork: (input: {
    source: string;
    payloadStr: string;
    acceptancePredicate: string;
    priority: number;
    spendBearing: boolean;
  }) => Promise<void>;
  controlWork: (
    id: string,
    action: "retry" | "fail" | "delete" | "reprioritize" | "execute",
    newPriority?: number,
  ) => Promise<{ ok: boolean; error?: string }>;
  addTask: (input: {
    goalId: string;
    title: string;
    detail?: string;
    priority?: TaskPriority;
    assignee: string;
    role: string;
    dependsOn?: string[];
  }) => Promise<{ ok: boolean; error?: string }>;
  updateTask: (input: {
    id: string;
    status?: TaskStatus;
    priority?: TaskPriority;
    assignee?: string;
    result?: string;
  }) => Promise<{ ok: boolean; error?: string }>;
  reorderTasks: (orderedIds: string[]) => Promise<{ ok: boolean; error?: string }>;
  runHeartbeatSweep: (forceAll?: boolean) => Promise<{
    ok: boolean;
    executed?: string[];
    repairedTotal?: number;
    error?: string;
  }>;
  controlMission: (
    missionId: string,
    action: "complete" | "halt" | "resume",
    extraCycles?: number,
  ) => Promise<{ ok: boolean; error?: string }>;
  toggleSleep: () => Promise<void>;
  togglePaused: () => Promise<void>;
  toggleSkill: (name: string) => Promise<void>;
  pingWorker: (workerId: string) => Promise<void>;
  activateDomainPack: (domainId: DomainId, customFocus?: string) => Promise<{ ok: boolean; error?: string }>;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const useCletusStore = create<CletusStore>((set, get) => ({
  ...INITIAL_SNAPSHOT,
  now: SEED_NOW,
  hydrated: false,
  loading: false,
  turnRunning: false,
  turnError: null,
  selectedNode: null,
  lastToolOutput: null,

  setSelectedNode: (node) => set({ selectedNode: node }),
  clearTurnError: () => set({ turnError: null }),

  tickClock: () => {
    set({ now: Date.now() });
  },

  applySnapshot: (snap) => {
    set({
      ...snap,
      now: Date.now(),
      hydrated: true,
    });
  },

  applyFleetStatus: (payload) => {
    set({
      vitals: payload.vitals,
      paused: payload.paused,
      children: payload.children,
      peers: payload.peers,
      serverNow: payload.serverNow,
      now: Date.now(),
      hydrated: true,
    });
  },

  hydrate: async (initial) => {
    if (initial) {
      set({
        ...initial,
        now: Date.now(),
        hydrated: true,
      });
      return;
    }
    if (get().hydrated) return;
    await get().refresh({ silent: true });
  },

  refresh: async (options) => {
    set({ loading: true });
    try {
      const snap = await getSnapshotServer();
      get().applySnapshot(snap);
    } catch (err) {
      if (!options?.silent) {
        set({ turnError: `Failed to refresh snapshot: ${errorMessage(err)}` });
      }
    } finally {
      set({ loading: false });
    }
  },

  issueDecree: async (text, targetAgentName) => {
    const trimmed = text.trim();
    if (!trimmed) return { ok: false, error: "Directive cannot be empty." };
    set({ turnRunning: true, turnError: null });
    try {
      const res = await issueDecreeServer({ data: { text: trimmed, targetAgentName } });
      get().applySnapshot(res.snapshot);
      if (res.turnError) {
        set({ turnError: res.turnError });
        return { ok: false, error: res.turnError };
      }
      return { ok: true };
    } catch (err) {
      const msg = errorMessage(err);
      set({ turnError: msg });
      return { ok: false, error: msg };
    } finally {
      set({ turnRunning: false });
    }
  },

  launchMission: async (input) => {
    const trimmed = input.objective.trim();
    if (!trimmed) return { ok: false, error: "Mission objective cannot be empty." };
    set({ turnRunning: true, turnError: null });
    try {
      const res = await launchMissionServer({ data: { ...input, objective: trimmed } });
      get().applySnapshot(res.snapshot);
      if (res.turnError) {
        set({ turnError: res.turnError });
        return { ok: false, error: res.turnError };
      }
      return { ok: true, replyText: res.replyText };
    } catch (err) {
      const msg = errorMessage(err);
      set({ turnError: msg });
      return { ok: false, error: msg };
    } finally {
      set({ turnRunning: false });
    }
  },

  runTurn: async (opts) => {
    set({ turnRunning: true, turnError: null });
    try {
      const res = await runAgentTurnServer({ data: opts ?? {} });
      get().applySnapshot(res.snapshot);
      if (res.turnError) {
        set({ turnError: res.turnError });
        return { ok: false, error: res.turnError };
      }
      return {
        ok: true,
        actorName: res.actorName,
        handoffTo: res.handoffTo,
        cyclesExecuted: res.cyclesExecuted,
        mode: res.mode,
      };
    } catch (err) {
      const msg = errorMessage(err);
      set({ turnError: msg });
      return { ok: false, error: msg };
    } finally {
      set({ turnRunning: false });
    }
  },

  runEvolutionStep: async (trajectorySlug, steps = 1) => {
    set({ turnRunning: true, turnError: null });
    try {
      const res = await runEvolutionStepServer({ data: { trajectorySlug, steps } });
      get().applySnapshot(res.snapshot);
      if (res.turnError) {
        set({ turnError: res.turnError });
        return { ok: false, error: res.turnError };
      }
      return {
        ok: true,
        actorName: res.actorName,
        cyclesExecuted: res.cyclesExecuted,
      };
    } catch (err) {
      const msg = errorMessage(err);
      set({ turnError: msg });
      return { ok: false, error: msg };
    } finally {
      set({ turnRunning: false });
    }
  },

  spawnEvolutionMission: async (trajectorySlug) => {
    set({ loading: true, turnError: null });
    try {
      const res = await spawnEvolutionMissionServer({ data: { trajectorySlug } });
      get().applySnapshot(res.snapshot);
      return { ok: true, missionId: res.missionId };
    } catch (err) {
      const msg = errorMessage(err);
      set({ turnError: `Failed to spawn growth mission: ${msg}` });
      return { ok: false, error: msg };
    } finally {
      set({ loading: false });
    }
  },

  toggleEvolutionTrajectory: async (slug) => {
    set({ loading: true, turnError: null });
    try {
      const snap = await toggleEvolutionTrajectoryServer({ data: { slug } });
      get().applySnapshot(snap);
    } catch (err) {
      set({ turnError: `Failed to toggle trajectory: ${errorMessage(err)}` });
    } finally {
      set({ loading: false });
    }
  },

  toggleAutoLoop: async () => {
    set({ loading: true, turnError: null });
    try {
      const snap = await toggleAutoLoopServer();
      get().applySnapshot(snap);
    } catch (err) {
      set({ turnError: `Failed to toggle auto-loop: ${errorMessage(err)}` });
    } finally {
      set({ loading: false });
    }
  },

  setSimulatedCredits: async (creditsCents) => {
    set({ loading: true, turnError: null });
    try {
      const snap = await setSimulatedCreditsServer({ data: { creditsCents } });
      get().applySnapshot(snap);
    } catch (err) {
      set({ turnError: `Failed to adjust credit governor: ${errorMessage(err)}` });
    } finally {
      set({ loading: false });
    }
  },

  configureAgent: async (input) => {
    set({ loading: true, turnError: null });
    try {
      const snap = await configureAgentServer({ data: input });
      get().applySnapshot(snap);
    } catch (err) {
      set({ turnError: `Failed to configure agent: ${errorMessage(err)}` });
    } finally {
      set({ loading: false });
    }
  },

  synthesizeTool: async (input) => {
    set({ loading: true, turnError: null });
    try {
      const snap = await synthesizeToolServer({ data: input });
      get().applySnapshot(snap);
    } catch (err) {
      set({ turnError: `Failed to synthesize tool: ${errorMessage(err)}` });
    } finally {
      set({ loading: false });
    }
  },

  testTool: async (toolName, argsJson) => {
    const started = Date.now();
    set({ loading: true, turnError: null });
    try {
      const res = await testToolServer({ data: { toolName, argsJson } });
      get().applySnapshot(res.snapshot);
      set({
        lastToolOutput: {
          toolName,
          ok: res.ok,
          durationMs: res.durationMs,
          output: res.output,
        },
      });
      return { ok: res.ok };
    } catch (err) {
      const msg = errorMessage(err);
      set({
        turnError: msg,
        lastToolOutput: {
          toolName,
          ok: false,
          durationMs: Math.max(1, Date.now() - started),
          output: { ok: false, error: msg },
        },
      });
      return { ok: false, error: msg };
    } finally {
      set({ loading: false });
    }
  },

  sendAgentMessage: async (input) => {
    const isExec = Boolean(input.executeHandoffTurn);
    set(isExec ? { turnRunning: true, turnError: null } : { loading: true, turnError: null });
    try {
      const res = await sendAgentMessageServer({ data: input });
      get().applySnapshot(res.snapshot);
      if (res.turnError) {
        set({ turnError: res.turnError });
        return { ok: false, error: res.turnError };
      }
      return { ok: true };
    } catch (err) {
      const msg = errorMessage(err);
      set({ turnError: msg });
      return { ok: false, error: msg };
    } finally {
      set(isExec ? { turnRunning: false } : { loading: false });
    }
  },

  enqueueWork: async (input) => {
    set({ loading: true, turnError: null });
    try {
      const snap = await enqueueWorkItemServer({ data: input });
      get().applySnapshot(snap);
    } catch (err) {
      set({ turnError: `Failed to enqueue work item: ${errorMessage(err)}` });
    } finally {
      set({ loading: false });
    }
  },

  controlWork: async (id, action, newPriority) => {
    const isExec = action === "execute";
    set(isExec ? { turnRunning: true, turnError: null } : { loading: true, turnError: null });
    try {
      const res = await controlWorkItemServer({
        data: { id, action, newPriority },
      });
      get().applySnapshot(res.snapshot);
      if (res.turnError) {
        set({ turnError: res.turnError });
        return { ok: false, error: res.turnError };
      }
      return { ok: true };
    } catch (err) {
      const msg = errorMessage(err);
      set({ turnError: msg });
      return { ok: false, error: msg };
    } finally {
      set(isExec ? { turnRunning: false } : { loading: false });
    }
  },

  addTask: async (input) => {
    set({ loading: true, turnError: null });
    try {
      const res = await addTaskServer({
        data: {
          goalId: input.goalId,
          title: input.title,
          detail: input.detail,
          priority: input.priority ?? "medium",
          assignee: input.assignee,
          role: input.role,
          dependsOn: input.dependsOn ?? [],
        },
      });
      get().applySnapshot(res.snapshot);
      if (!res.ok) {
        if (res.error) set({ turnError: res.error });
        return { ok: false, error: res.error ?? "Failed to add task." };
      }
      return { ok: true };
    } catch (err) {
      const msg = `Failed to add task: ${errorMessage(err)}`;
      set({ turnError: msg });
      return { ok: false, error: msg };
    } finally {
      set({ loading: false });
    }
  },

  updateTask: async (input) => {
    const previousTasks = get().tasks;
    if (input.status) {
      const check = canTransitionTaskStatus(previousTasks, input.id, input.status);
      if (!check.ok) {
        set({ turnError: check.error });
        return { ok: false, error: check.error };
      }
    }
    set({
      tasks: applyOptimisticTaskUpdate(previousTasks, input),
      turnError: null,
    });
    try {
      const res = await updateTaskServer({ data: input });
      get().applySnapshot(res.snapshot);
      if (!res.ok) {
        set({ tasks: previousTasks, turnError: res.error ?? "Failed to update task." });
        return { ok: false, error: res.error ?? "Failed to update task." };
      }
      return { ok: true };
    } catch (err) {
      const msg = `Failed to update task: ${errorMessage(err)}`;
      set({ tasks: previousTasks, turnError: msg });
      return { ok: false, error: msg };
    }
  },

  reorderTasks: async (orderedIds) => {
    const previousTasks = get().tasks;
    set({
      tasks: applyTaskOrder(previousTasks, orderedIds),
      turnError: null,
    });
    try {
      const res = await reorderTasksServer({ data: { orderedIds } });
      get().applySnapshot(res.snapshot);
      if (!res.ok) {
        set({ tasks: previousTasks, turnError: res.error ?? "Failed to reorder tasks." });
        return { ok: false, error: res.error ?? "Failed to reorder tasks." };
      }
      return { ok: true };
    } catch (err) {
      const msg = `Failed to reorder tasks: ${errorMessage(err)}`;
      set({ tasks: previousTasks, turnError: msg });
      return { ok: false, error: msg };
    }
  },

  runHeartbeatSweep: async (forceAll = true) => {
    set({ loading: true, turnError: null });
    try {
      const res = await runHeartbeatSweepServer({ data: { forceAll } });
      get().applySnapshot(res.snapshot);
      return {
        ok: res.ok,
        executed: res.executed,
        repairedTotal: res.repairedTotal,
      };
    } catch (err) {
      const msg = `Heartbeat sweep failed: ${errorMessage(err)}`;
      set({ turnError: msg });
      return { ok: false, error: msg };
    } finally {
      set({ loading: false });
    }
  },

  controlMission: async (missionId, action, extraCycles) => {
    set({ loading: true, turnError: null });
    try {
      const res = await controlMissionServer({ data: { missionId, action, extraCycles } });
      get().applySnapshot(res.snapshot);
      if (!res.ok) {
        if (res.error) set({ turnError: res.error });
        return { ok: false, error: res.error ?? "Mission update failed." };
      }
      return { ok: true };
    } catch (err) {
      const msg = `Mission control failed: ${errorMessage(err)}`;
      set({ turnError: msg });
      return { ok: false, error: msg };
    } finally {
      set({ loading: false });
    }
  },

  toggleSleep: async () => {
    set({ loading: true, turnError: null });
    try {
      const snap = await toggleSleepServer();
      get().applySnapshot(snap);
    } catch (err) {
      set({ turnError: `Failed to toggle sleep state: ${errorMessage(err)}` });
    } finally {
      set({ loading: false });
    }
  },

  togglePaused: async () => {
    set({ loading: true, turnError: null });
    try {
      const snap = await togglePausedServer();
      get().applySnapshot(snap);
    } catch (err) {
      set({ turnError: `Failed to toggle paused state: ${errorMessage(err)}` });
    } finally {
      set({ loading: false });
    }
  },

  toggleSkill: async (name) => {
    set({ loading: true, turnError: null });
    try {
      const snap = await toggleSkillServer({ data: { name } });
      get().applySnapshot(snap);
    } catch (err) {
      set({ turnError: `Failed to toggle skill: ${errorMessage(err)}` });
    } finally {
      set({ loading: false });
    }
  },

  pingWorker: async (workerId) => {
    set({ loading: true, turnError: null });
    try {
      const snap = await pingWorkerServer({ data: { workerId } });
      get().applySnapshot(snap);
    } catch (err) {
      set({ turnError: `Failed to verify agent heartbeat: ${errorMessage(err)}` });
    } finally {
      set({ loading: false });
    }
  },

  activateDomainPack: async (domainId, customFocus) => {
    set({ loading: true, turnError: null });
    try {
      const res = await activateDomainPackServer({ data: { domainId, customFocus } });
      get().applySnapshot(res.snapshot);
      return { ok: true };
    } catch (err) {
      const msg = errorMessage(err);
      set({ turnError: `Failed to activate domain pack: ${msg}` });
      return { ok: false, error: msg };
    } finally {
      set({ loading: false });
    }
  },
}));
