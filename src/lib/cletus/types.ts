export type AgentState = "running" | "sleeping" | "paused";

export type SurvivalTier = "dead" | "critical" | "low_compute" | "normal" | "high";

export type GoalStatus = "active" | "completed" | "blocked";
export type TaskStatus = "pending" | "assigned" | "running" | "completed" | "failed";
export type TaskPriority = "low" | "medium" | "high";
export type WorkItemStatus = "pending" | "claimed" | "completed" | "failed" | "expired";
export type ChildKind = "local" | "openclaw";
export type ChildStatus = "healthy" | "starting" | "unhealthy" | "stopped";
export type LogLevel = "info" | "warn" | "error" | "tool" | "thought";
export type InboxFrom = "creator" | "agent" | "peer" | "system" | "child";
export type InboxPriority = "supreme" | "work" | "status";
export type AlertSeverity = "info" | "warn" | "crit";
export type PeerStatus = "online" | "quiet" | "offline";

export type MissionStatus = "planning" | "active" | "completed" | "halted" | "failed";
export type CycleStatus = "completed" | "blocked" | "error";
export type CycleMode = "mission" | "directive" | "handoff" | "work_item" | "self_evolution";
export type ToolKind = "builtin" | "http_json" | "nvidia_analyzer" | "sql_readonly_metric";
export type AgentMessageType =
  | "handoff"
  | "plan_proposal"
  | "critique"
  | "tool_share"
  | "status";

export type EvolutionTrajectorySlug =
  | "research_frontier"
  | "capability_forging"
  | "mesh_calibration"
  | "memory_consolidation"
  | "resilience_audit";

export type EvolutionHorizon = "seed" | "explore" | "synthesize" | "benchmark" | "mastered";

export type EvolutionActionKind =
  | "research_discovery"
  | "tool_synthesized"
  | "tool_benchmarked"
  | "agent_upgraded"
  | "memory_distilled"
  | "resilience_hardened";

export type NvidiaChatModelId =
  | "nvidia/llama-3.3-nemotron-super-49b-v1"
  | "meta/llama-3.3-70b-instruct"
  | "deepseek-ai/deepseek-r1"
  | "nvidia/llama-3.1-nemotron-nano-8b-v1";

export type InferenceGroundingMode = "none" | "search" | "maps";

export type VideoAspectRatio = "16:9" | "9:16";
export type VideoDuration = "5s" | "8s" | "10s";

export interface WebGroundingSource {
  title: string;
  uri: string;
}

export interface GeoGroundingPlace {
  title: string;
  uri: string;
  placeId?: string;
  reviewSnippets: string[];
}

export interface NvidiaChatMessage {
  id: string;
  threadId: string;
  role: "user" | "model";
  model: NvidiaChatModelId | string;
  groundingMode: InferenceGroundingMode;
  systemRole: string;
  content: string;
  webSources: WebGroundingSource[];
  mapsPlaces: GeoGroundingPlace[];
  createdAt: number;
}

export interface NvidiaVideoJob {
  id: string;
  prompt: string;
  aspectRatio: VideoAspectRatio;
  duration: VideoDuration;
  status: "completed" | "failed";
  interactionId?: string;
  videoDataUrl?: string;
  mimeType: string;
  error?: string;
  createdAt: number;
}

export interface JsonObject {
  [key: string]: JsonValue;
}
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;

export interface Goal {
  id: string;
  missionId?: string;
  title: string;
  detail: string;
  status: GoalStatus;
  progress: number;
  expectedRevenueCents: number;
  actualRevenueCents: number;
}

export interface Task {
  id: string;
  goalId: string;
  missionId?: string;
  title: string;
  detail?: string;
  status: TaskStatus;
  priority?: TaskPriority;
  sortOrder?: number;
  assignee: string;
  role: string;
  dependsOn: string[];
  result?: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface TaskStatusEvent {
  id: string;
  taskId: string;
  missionId?: string;
  goalId?: string;
  previousStatus?: TaskStatus;
  status: TaskStatus;
  actor: string;
  note?: string;
  createdAt: number;
}

export interface WorkItem {
  id: string;
  missionId?: string;
  source: string;
  payload: JsonObject;
  acceptancePredicate: string;
  priority: number;
  spendBearing: boolean;
  status: WorkItemStatus;
  attempts: number;
  result?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface Child {
  id: string;
  name: string;
  kind: ChildKind;
  status: ChildStatus;
  role: string;
  lastBeatAgoMs: number;
  task?: string;
  latencyMs?: number;
  fundedCents?: number;
  errorNote?: string;
  systemPrompt?: string;
  model: string;
  capabilities: string[];
  autonomyLevel: string;
  cycleCount: number;
}

export interface Mission {
  id: string;
  title: string;
  objective: string;
  status: MissionStatus;
  orchestrator: string;
  planSummary?: string;
  successCriteria: string;
  cycleCount: number;
  maxCycles: number;
  createdAt: number;
  updatedAt: number;
}

export interface ExecutionCycle {
  id: string;
  missionId?: string;
  mode?: CycleMode;
  turnNumber: number;
  agentName: string;
  agentRole: string;
  phasePerceive: string;
  phaseReason: string;
  phaseAct: string;
  phaseObserve: string;
  toolsUsed: string[];
  handoffTo?: string;
  durationMs: number;
  costCents: number;
  tier: SurvivalTier;
  status: CycleStatus;
  createdAt: number;
}

export interface DynamicTool {
  id: string;
  name: string;
  category: string;
  kind: ToolKind;
  description: string;
  inputSchema: JsonObject;
  configJson: JsonObject;
  enabled: boolean;
  createdBy: string;
  usageCount: number;
  lastUsedAt?: number;
  createdAt: number;
}

export interface AgentMessage {
  id: string;
  missionId?: string;
  taskId?: string;
  fromAgent: string;
  toAgent: string;
  messageType: AgentMessageType;
  subject: string;
  payload: JsonObject;
  status: "pending" | "delivered" | "processed";
  createdAt: number;
}

export interface Thought {
  id: string;
  at: number;
  thinking: string;
  speech?: string;
  tools: string[];
}

export interface LogLine {
  id: string;
  at: number;
  level: LogLevel;
  source: string;
  message: string;
}

export interface InboxMessage {
  id: string;
  from: InboxFrom;
  content: string;
  at: number;
  status: "received" | "claimed" | "done";
  priority: InboxPriority;
  toolsUsed?: string[];
}

export interface AlertItem {
  id: string;
  severity: AlertSeverity;
  title: string;
  detail: string;
  at: number;
}

export interface SpendPoint {
  hour: string;
  cents: number;
}

export interface ModelSpend {
  model: string;
  calls: number;
  cents: number;
}

export interface ToolSpend {
  tool: string;
  category: string;
  cents: number;
}

export interface PolicyDenial {
  id: string;
  tool: string;
  rule: string;
  at: number;
}

export interface Skill {
  name: string;
  summary: string;
  enabled: boolean;
  autoActivate: boolean;
}

export interface Heartbeat {
  name: string;
  cadence: string;
  lastAgoMs: number;
  ok: boolean;
  summary?: string;
  durationMs?: number;
  consecutiveFailures?: number;
  repairedCount?: number;
  due?: boolean;
}

export interface EntelechyCapsule {
  mission: string;
  riskPosture: string;
  confidence: number;
  priorities: string[];
  avoid: string[];
  recommendation: string;
}

export interface Peer {
  id: string;
  name: string;
  handle: string;
  status: PeerStatus;
  lastAgoMs: number;
  note: string;
  claimed: boolean;
  posts: number;
  followers: number | null;
  following: number | null;
  karma: number | null;
}

export interface OpenClawAgent {
  id: string;
  name: string;
  live: boolean;
  task: string;
  lastAgoMs: number;
  errors: Array<{ at: number; tool: string; error: string }>;
}

export type DomainId =
  | "mas_rnd"
  | "biomed_clinical"
  | "climate_geospatial"
  | "finance_secops"
  | "policy_supply";

export type DomainMemorySourceType = "url_context" | "connector" | "briefing" | "cycle";

export interface DomainMemoryItem {
  id: string;
  domainId: DomainId;
  sourceType: DomainMemorySourceType;
  title: string;
  sourceUrl?: string;
  summary: string;
  rawExcerpt?: string;
  hasEmbedding: boolean;
  embeddingDimensions?: number;
  tags: string[];
  createdAt: number;
}

export interface AudioBriefing {
  id: string;
  domainId: DomainId;
  title: string;
  voiceName: string;
  script: string;
  audioDataUrl: string;
  mimeType: string;
  createdAt: number;
}

export interface EnvironmentReadiness {
  nvidiaConfigured: boolean;
  databaseBackend: "neon" | "pglite";
  githubTokenConfigured: boolean;
  telegramConfigured: boolean;
  solanaRpcConfigured: boolean;
}

export interface Vitals {
  name: string;
  state: AgentState;
  model: string;
  tier: SurvivalTier;
  creditsCents: number;
  usdcCents: number;
  reserveCents: number;
  turns: number;
  startedAt: number;
  sleepUntil: number | null;
  creator: string;
  sigil: string;
  autoLoop: boolean;
  activeMissionId: string | null;
  activeDomain: DomainId;
  creditsSyntheticOverride: boolean;
}

export interface EvolutionTrajectory {
  id: string;
  slug: EvolutionTrajectorySlug;
  title: string;
  horizon: EvolutionHorizon;
  maturityScore: number;
  targetCapability: string;
  priorityWeight: number;
  cyclesCompleted: number;
  status: "active" | "paused";
  lastEvolvedAt?: number;
  lastOutcome?: string;
  updatedAt: number;
}

export interface EvolutionEvent {
  id: string;
  trajectoryId: string;
  trajectorySlug: EvolutionTrajectorySlug;
  domainId: DomainId;
  cycleId?: string;
  agentName: string;
  actionKind: EvolutionActionKind;
  summary: string;
  capabilityGained?: string;
  artifactRef?: string;
  maturityDelta: number;
  verified: boolean;
  createdAt: number;
}

export interface EvolutionGapReport {
  untestedTools: string[];
  unboundTools: string[];
  missingDomainCapabilities: string[];
  domainMemoryCount: number;
  recentFaultCount: number;
  recentDenialCount: number;
  recommendedTrajectory: EvolutionTrajectorySlug;
}

export interface EvolutionSummary {
  isIdle: boolean;
  idleReason: string;
  activeTaskCount: number;
  pendingWorkCount: number;
  pendingHandoffCount: number;
  nextTrajectorySlug: EvolutionTrajectorySlug;
  nextTrajectoryTitle: string;
  nextActorName: string;
  recommendedAction: string;
  overallMaturity: number;
  capabilitiesUnlockedCount: number;
  selfEvolutionCyclesCount: number;
  gaps: EvolutionGapReport;
}

export interface CletusSnapshot {
  vitals: Vitals;
  activeDomain: DomainId;
  paused: boolean;
  nvidiaConfigured: boolean;
  envReadiness: EnvironmentReadiness;
  missions: Mission[];
  cycles: ExecutionCycle[];
  tools: DynamicTool[];
  agentMessages: AgentMessage[];
  goals: Goal[];
  tasks: Task[];
  taskEvents: TaskStatusEvent[];
  workQueue: WorkItem[];
  children: Child[];
  thoughts: Thought[];
  logs: LogLine[];
  inbox: InboxMessage[];
  alerts: AlertItem[];
  spend24h: SpendPoint[];
  spendByModel: ModelSpend[];
  toolSpends: ToolSpend[];
  denials: PolicyDenial[];
  skills: Skill[];
  heartbeats: Heartbeat[];
  entelechy: EntelechyCapsule;
  peers: Peer[];
  openclaw: OpenClawAgent[];
  domainMemories: DomainMemoryItem[];
  audioBriefings: AudioBriefing[];
  evolutionTrajectories: EvolutionTrajectory[];
  evolutionEvents: EvolutionEvent[];
  evolutionSummary: EvolutionSummary;
  pendingAck: string | null;
  serverNow: number;
}
