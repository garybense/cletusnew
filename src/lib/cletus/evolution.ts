import { getDomainPack } from "./domains";
import { getReadyTasks, validateAndNormalizePlan, type NormalizedGoalInput, type NormalizedTaskInput } from "./mas-engine";
import type {
  AgentMessage,
  Child,
  DomainId,
  DomainMemoryItem,
  DynamicTool,
  EvolutionActionKind,
  EvolutionEvent,
  EvolutionGapReport,
  EvolutionHorizon,
  EvolutionSummary,
  EvolutionTrajectory,
  EvolutionTrajectorySlug,
  ExecutionCycle,
  Mission,
  PolicyDenial,
  Task,
  WorkItem,
} from "./types";

export interface DomainCapabilityBlueprint {
  name: string;
  category: string;
  kind: "http_json" | "nvidia_analyzer";
  description: string;
  urlTemplate?: string;
  promptTemplate?: string;
  sampleArgs: Record<string, unknown>;
}

export const DOMAIN_CAPABILITY_ROADMAP: Record<DomainId, DomainCapabilityBlueprint[]> = {
  mas_rnd: [
    {
      name: "semantic_scholar_papers",
      category: "research",
      kind: "http_json",
      description:
        "Query live Semantic Scholar Graph API for peer-reviewed multi-agent systems papers, citations, and open PDFs.",
      urlTemplate:
        "https://api.semanticscholar.org/graph/v1/paper/search?query={{query}}&limit=3&fields=title,year,citationCount,url",
      sampleArgs: { query: "multi agent autonomous planning" },
    },
    {
      name: "crossref_doi_metadata",
      category: "research",
      kind: "http_json",
      description:
        "Query live Crossref REST API for DOI metadata, publishers, and bibliographic citations.",
      urlTemplate: "https://api.crossref.org/works?query={{query}}&rows=3",
      sampleArgs: { query: "agentic tool synthesis" },
    },
    {
      name: "arxiv_architecture_synthesizer",
      category: "evolution",
      kind: "nvidia_analyzer",
      description:
        "Synthesize actionable multi-agent architecture benchmarks and tool interfaces from research abstracts.",
      promptTemplate:
        "Extract concrete multi-agent coordination protocols, failure guards, and reusable tool contracts from the supplied research JSON.",
      sampleArgs: { topic: "hierarchical supervisor mesh self-evolution" },
    },
  ],
  biomed_clinical: [
    {
      name: "openfda_drug_labels",
      category: "biomed",
      kind: "http_json",
      description:
        "Query live OpenFDA drug labeling API for indications, boxed warnings, and dosage pharmacology.",
      urlTemplate:
        "https://api.fda.gov/drug/label.json?search=openfda.generic_name:{{query}}&limit=2",
      sampleArgs: { query: "semaglutide" },
    },
    {
      name: "clinical_trial_comparator",
      category: "biomed",
      kind: "nvidia_analyzer",
      description:
        "Compare clinical trial phase designs, endpoints, and safety signals into a structured pharmacovigilance brief.",
      promptTemplate:
        "Compare the supplied clinical study parameters and highlight endpoint strength, enrollment scale, and safety caveats.",
      sampleArgs: { compound: "GLP-1 agonist", focus: "cardiovascular outcomes" },
    },
  ],
  climate_geospatial: [
    {
      name: "usgs_significant_quakes",
      category: "geospatial",
      kind: "http_json",
      description:
        "Query live USGS GeoJSON feed for M4.0+ global seismic activity and fault coordinates.",
      urlTemplate:
        "https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&limit=4&minmagnitude=4.0",
      sampleArgs: {},
    },
    {
      name: "usgs_hazard_aggregator",
      category: "geospatial",
      kind: "nvidia_analyzer",
      description:
        "Synthesize seismic and meteorological telemetry into regional infrastructure readiness advisories.",
      promptTemplate:
        "Assess geospatial hazard telemetry and output concise risk tiers, affected corridors, and sensor follow-ups.",
      sampleArgs: { region: "Pacific Rim", windowHours: 24 },
    },
  ],
  finance_secops: [
    {
      name: "treasury_fx_rates",
      category: "secops",
      kind: "http_json",
      description:
        "Query live U.S. Treasury Fiscal Data reporting rates of exchange for sovereign settlement benchmarking.",
      urlTemplate:
        "https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v1/accounting/od/rates_of_exchange?sort=-record_date&page[size]=5",
      sampleArgs: {},
    },
    {
      name: "secops_dependency_critic",
      category: "secops",
      kind: "nvidia_analyzer",
      description:
        "Evaluate CVE severity vectors and treasury liquidity posture to recommend immediate remediation controls.",
      promptTemplate:
        "Audit the supplied vulnerability or treasury metadata and produce prioritized mitigation controls with CVSS/reserve rationale.",
      sampleArgs: { stack: "Node.js TypeScript PGLite", priority: "critical" },
    },
  ],
  policy_supply: [
    {
      name: "openalex_policy_works",
      category: "policy",
      kind: "http_json",
      description:
        "Query live OpenAlex scholarly index for semiconductor, trade compliance, and supply-chain resilience literature.",
      urlTemplate: "https://api.openalex.org/works?search={{query}}&per-page=3&sort=cited_by_count:desc",
      sampleArgs: { query: "semiconductor supply chain export controls" },
    },
    {
      name: "policy_compliance_matrix",
      category: "policy",
      kind: "nvidia_analyzer",
      description:
        "Transform regulatory notices and supply-chain citations into structured compliance checklists and lead-time risks.",
      promptTemplate:
        "Map the supplied regulatory topic into concrete supplier compliance obligations, deadlines, and bottleneck risks.",
      sampleArgs: { sector: "critical minerals and semiconductors" },
    },
  ],
};

export function computeHorizonForMaturity(maturityScore: number): EvolutionHorizon {
  if (maturityScore < 20) return "seed";
  if (maturityScore < 45) return "explore";
  if (maturityScore < 70) return "synthesize";
  if (maturityScore < 90) return "benchmark";
  return "mastered";
}

export function createDefaultEvolutionTrajectories(now: number): EvolutionTrajectory[] {
  return [
    {
      id: "trj_research_frontier",
      slug: "research_frontier",
      title: "Frontier Research & Literature Recon",
      horizon: "explore",
      maturityScore: 34,
      targetCapability: "semantic_scholar_papers",
      priorityWeight: 86,
      cyclesCompleted: 1,
      status: "active",
      lastEvolvedAt: now - 420_000,
      lastOutcome: "Indexed foundational AOP & DRAMA multi-agent coordination references.",
      updatedAt: now - 420_000,
    },
    {
      id: "trj_capability_forging",
      slug: "capability_forging",
      title: "Autonomous Tool Synthesis & Benchmarking",
      horizon: "explore",
      maturityScore: 28,
      targetCapability: "semantic_scholar_papers",
      priorityWeight: 92,
      cyclesCompleted: 1,
      status: "active",
      lastEvolvedAt: now - 310_000,
      lastOutcome: "Armed live Hacker News connector; awaiting next domain capability synthesis.",
      updatedAt: now - 310_000,
    },
    {
      id: "trj_mesh_calibration",
      slug: "mesh_calibration",
      title: "Agent Mesh Prompt & Capability Alignment",
      horizon: "explore",
      maturityScore: 30,
      targetCapability: "specialist_tool_binding",
      priorityWeight: 74,
      cyclesCompleted: 0,
      status: "active",
      lastEvolvedAt: now - 600_000,
      lastOutcome: "Baseline specialist prompts verified across 5 healthy mesh workers.",
      updatedAt: now - 600_000,
    },
    {
      id: "trj_memory_consolidation",
      slug: "memory_consolidation",
      title: "Semantic Memory & Entelechy Distillation",
      horizon: "seed",
      maturityScore: 18,
      targetCapability: "domain_memory_embeddings",
      priorityWeight: 78,
      cyclesCompleted: 0,
      status: "active",
      lastEvolvedAt: now - 720_000,
      lastOutcome: "Ready to distill idle findings via nvidia/nv-embedqa-e5-v5 into domain memory.",
      updatedAt: now - 720_000,
    },
    {
      id: "trj_resilience_audit",
      slug: "resilience_audit",
      title: "Fault Recovery, Treasury & Guardrail Hardening",
      horizon: "explore",
      maturityScore: 32,
      targetCapability: "reserve_floor_and_ssrf_checks",
      priorityWeight: 68,
      cyclesCompleted: 1,
      status: "active",
      lastEvolvedAt: now - 540_000,
      lastOutcome: "PolicyEngine max_single_transfer & reserve floor checks verified.",
      updatedAt: now - 540_000,
    },
  ];
}

export interface OperationalIdleState {
  isIdle: boolean;
  idleReason: string;
  activeTaskCount: number;
  pendingWorkCount: number;
  pendingHandoffCount: number;
}

/**
 * Determine whether Cletus currently has zero active operational tasks/work/handoffs
 * and should therefore default to Self-Evolution.
 */
export function evaluateOperationalIdleState(input: {
  missions: Mission[];
  activeMissionId?: string | null;
  tasks: Task[];
  workQueue: WorkItem[];
  agentMessages: AgentMessage[];
}): OperationalIdleState {
  const { missions, activeMissionId, tasks, workQueue, agentMessages } = input;
  const missionStatusById = new Map(missions.map((m) => [m.id, m.status]));
  const activeMission =
    missions.find((m) => m.id === activeMissionId) ??
    missions.find((m) => m.status === "active" || m.status === "planning");

  const isClosedMission = (mId?: string): boolean => {
    if (!mId) return false;
    const st = missionStatusById.get(mId);
    return st === "completed" || st === "halted" || st === "failed";
  };

  // Pending inter-agent handoffs targeting active (non-closed) missions or general bus
  const openHandoffs = agentMessages.filter(
    (m) => m.status === "pending" && !isClosedMission(m.missionId),
  );

  // Tasks eligible to execute right now (excluding tasks belonging to already-closed/halted missions)
  const openTasksPool = tasks.filter(
    (t) => t.status !== "completed" && t.status !== "failed" && !isClosedMission(t.missionId),
  );
  const readyTasks = getReadyTasks(openTasksPool);
  const runningTasks = openTasksPool.filter((t) => t.status === "running");

  // Pending or claimed operational work items (excluding closed/halted missions unless urgent operator directive)
  const openWork = workQueue.filter((w) => {
    if (w.status !== "pending" && w.status !== "claimed") return false;
    if (w.priority >= 100 || w.source === "operator_directive" || w.source === "live_voice") {
      return true;
    }
    return !isClosedMission(w.missionId);
  });

  const activeTaskCount = readyTasks.length + runningTasks.length;
  const pendingWorkCount = openWork.length;
  const pendingHandoffCount = openHandoffs.length;

  const isIdle = activeTaskCount === 0 && pendingWorkCount === 0 && pendingHandoffCount === 0;

  let idleReason: string;
  if (!isIdle) {
    idleReason = `Operational backlog active (${activeTaskCount} ready/running tasks · ${pendingWorkCount} queued work · ${pendingHandoffCount} handoffs).`;
  } else if (activeMission?.status === "completed") {
    idleReason = `Mission ${activeMission.id} completed with 0 active tasks — defaulting to Self-Evolution.`;
  } else if (activeMission?.status === "halted") {
    idleReason = `Mission ${activeMission.id} halted with 0 queued work — defaulting idle runtime to Self-Evolution.`;
  } else if (openTasksPool.length > 0) {
    idleReason = `Remaining ${openTasksPool.length} task(s) awaiting upstream unlock — defaulting to Self-Evolution.`;
  } else {
    idleReason = "0 active tasks · 0 queued work · 0 pending handoffs — Self-Evolution default active.";
  }

  return {
    isIdle,
    idleReason,
    activeTaskCount,
    pendingWorkCount,
    pendingHandoffCount,
  };
}

export function evaluateEvolutionGaps(input: {
  activeDomain: DomainId;
  tools: DynamicTool[];
  children: Child[];
  domainMemories: DomainMemoryItem[];
  cycles: ExecutionCycle[];
  denials: PolicyDenial[];
}): EvolutionGapReport {
  const { activeDomain, tools, children, domainMemories, cycles, denials } = input;
  const enabledTools = tools.filter((t) => t.enabled);
  const healthyWorkers = children.filter((c) => c.status === "healthy");
  const allBoundCapabilities = new Set(
    healthyWorkers.flatMap((w) => w.capabilities.map((c) => c.toLowerCase())),
  );
  const existingToolNames = new Set(tools.map((t) => t.name.toLowerCase()));

  const untestedTools = enabledTools
    .filter((t) => t.usageCount === 0 && t.name !== "synthesize_tool")
    .map((t) => t.name);

  const coreInfraTools = new Set([
    "decompose_mission",
    "configure_agent_role",
    "synthesize_tool",
    "handoff_to_agent",
    "reply_to_operator",
    "record_evolution_milestone",
    "evolve_entelechy_capsule",
  ]);
  const unboundTools = enabledTools
    .filter((t) => !coreInfraTools.has(t.name) && !allBoundCapabilities.has(t.name.toLowerCase()))
    .map((t) => t.name);

  const blueprints = DOMAIN_CAPABILITY_ROADMAP[activeDomain] ?? DOMAIN_CAPABILITY_ROADMAP.mas_rnd;
  const missingDomainCapabilities = blueprints
    .filter((b) => !existingToolNames.has(b.name.toLowerCase()))
    .map((b) => b.name);

  const domainMemoryCount = domainMemories.filter((m) => m.domainId === activeDomain).length;
  const recentFaultCount = cycles.slice(0, 12).filter((c) => c.status !== "completed").length;
  const recentDenialCount = denials.length;

  let recommendedTrajectory: EvolutionTrajectorySlug = "research_frontier";
  if (recentFaultCount > 0 || recentDenialCount >= 3) {
    recommendedTrajectory = "resilience_audit";
  } else if (missingDomainCapabilities.length > 0 || untestedTools.length > 0) {
    recommendedTrajectory = "capability_forging";
  } else if (unboundTools.length > 0) {
    recommendedTrajectory = "mesh_calibration";
  } else if (domainMemoryCount < 2) {
    recommendedTrajectory = "memory_consolidation";
  }

  return {
    untestedTools,
    unboundTools,
    missingDomainCapabilities,
    domainMemoryCount,
    recentFaultCount,
    recentDenialCount,
    recommendedTrajectory,
  };
}

export interface EvolutionStepPlan {
  trajectory: EvolutionTrajectory;
  actorName: string;
  actorRole: string;
  actionSummary: string;
  targetTools: string[];
  suggestedBlueprint?: DomainCapabilityBlueprint;
  gaps: EvolutionGapReport;
}

function pickSpecialistForTrajectory(
  slug: EvolutionTrajectorySlug,
  healthyWorkers: Child[],
  fallbackName: string,
  fallbackRole: string,
): { name: string; role: string } {
  const findByRole = (substr: string) =>
    healthyWorkers.find((w) => w.role.toLowerCase().includes(substr));

  let candidate: Child | undefined;
  switch (slug) {
    case "research_frontier":
      candidate = findByRole("research") ?? findByRole("scout");
      break;
    case "capability_forging":
      candidate = findByRole("engineer") ?? findByRole("architect") ?? findByRole("orchestrator");
      break;
    case "mesh_calibration":
      candidate = findByRole("orchestrator");
      break;
    case "memory_consolidation":
      candidate = findByRole("research") ?? findByRole("verification") ?? findByRole("orchestrator");
      break;
    case "resilience_audit":
      candidate = findByRole("verification") ?? findByRole("treasury") ?? findByRole("orchestrator");
      break;
  }
  return candidate ? { name: candidate.name, role: candidate.role } : { name: fallbackName, role: fallbackRole };
}

export function selectNextEvolutionStep(input: {
  trajectories: EvolutionTrajectory[];
  preferredTrajectorySlug?: EvolutionTrajectorySlug;
  activeDomain: DomainId;
  tools: DynamicTool[];
  children: Child[];
  domainMemories: DomainMemoryItem[];
  cycles: ExecutionCycle[];
  denials: PolicyDenial[];
  now?: number;
}): EvolutionStepPlan {
  const now = input.now ?? Date.now();
  const pool =
    input.trajectories.length > 0 ? input.trajectories : createDefaultEvolutionTrajectories(now);
  const activePool = pool.filter((t) => t.status === "active");
  const candidates = activePool.length > 0 ? activePool : pool;

  const gaps = evaluateEvolutionGaps({
    activeDomain: input.activeDomain,
    tools: input.tools,
    children: input.children,
    domainMemories: input.domainMemories,
    cycles: input.cycles,
    denials: input.denials,
  });

  let selected: EvolutionTrajectory | undefined;
  if (input.preferredTrajectorySlug) {
    selected = pool.find((t) => t.slug === input.preferredTrajectorySlug);
  }

  if (!selected) {
    const scored = candidates
      .map((t) => {
        const gapBonus =
          t.slug === gaps.recommendedTrajectory
            ? 24
            : t.slug === "capability_forging" && gaps.missingDomainCapabilities.length > 0
              ? 16
              : t.slug === "mesh_calibration" && gaps.unboundTools.length > 0
                ? 14
                : t.slug === "memory_consolidation" && gaps.domainMemoryCount < 2
                  ? 12
                  : 0;
        const maturityRoom = Math.max(0, 100 - t.maturityScore) * 0.35;
        const recentPenalty =
          t.lastEvolvedAt && now - t.lastEvolvedAt < 180_000 ? 18 : 0;
        const score = t.priorityWeight + gapBonus + maturityRoom - recentPenalty;
        return { t, score };
      })
      .sort((a, b) => b.score - a.score);
    selected = scored[0]?.t ?? candidates[0]!;
  }

  const healthyWorkers = input.children.filter((c) => c.status === "healthy");
  const orchestrator =
    healthyWorkers.find((c) => c.role === "orchestrator") ?? healthyWorkers[0] ?? input.children[0];
  const actor = pickSpecialistForTrajectory(
    selected.slug,
    healthyWorkers,
    orchestrator?.name ?? "Orchestrator-Prime",
    orchestrator?.role ?? "orchestrator",
  );

  const pack = getDomainPack(input.activeDomain);
  const blueprints = DOMAIN_CAPABILITY_ROADMAP[input.activeDomain] ?? DOMAIN_CAPABILITY_ROADMAP.mas_rnd;
  const existingToolNames = new Set(input.tools.map((t) => t.name.toLowerCase()));
  const nextBlueprint =
    blueprints.find((b) => !existingToolNames.has(b.name.toLowerCase())) ?? blueprints[0];

  let actionSummary = "";
  let targetTools: string[] = [];

  switch (selected.slug) {
    case "research_frontier": {
      actionSummary = `Execute live frontier reconnaissance for ${pack.name} (${pack.tools[0]?.name ?? "search_arxiv"}, web_grounding_research) and distill reusable knowledge into domain memory.`;
      targetTools = [pack.tools[0]?.name ?? "search_arxiv", "search_github_repos", "web_grounding_research", "record_evolution_milestone"];
      break;
    }
    case "capability_forging": {
      if (nextBlueprint && !existingToolNames.has(nextBlueprint.name.toLowerCase())) {
        actionSummary = `Synthesize new capability '${nextBlueprint.name}' (${nextBlueprint.kind}) for ${pack.shortLabel} via synthesize_tool, benchmark it live with invoke_custom_tool, and record milestone.`;
        targetTools = ["synthesize_tool", "invoke_custom_tool", "record_evolution_milestone"];
      } else if (gaps.untestedTools.length > 0) {
        actionSummary = `Benchmark untested tool '${gaps.untestedTools[0]}' via invoke_custom_tool, verify live response fidelity, and record capability benchmark.`;
        targetTools = ["invoke_custom_tool", "record_evolution_milestone"];
      } else {
        actionSummary = `Benchmark and upgrade domain capability '${selected.targetCapability}' via invoke_custom_tool / synthesize_tool.`;
        targetTools = ["invoke_custom_tool", "synthesize_tool", "record_evolution_milestone"];
      }
      break;
    }
    case "mesh_calibration": {
      const bindTarget = gaps.unboundTools[0] ?? pack.tools[0]?.name ?? "analyze_url_context";
      actionSummary = `Audit specialist worker capability bindings and upgrade prompt instructions to bind '${bindTarget}' via configure_agent_role.`;
      targetTools = ["configure_agent_role", "recall_memory", "record_evolution_milestone"];
      break;
    }
    case "memory_consolidation": {
      actionSummary = `Consolidate recent cycles and live ${pack.shortLabel} research into embedded semantic memory + refine Entelechy priorities via evolve_entelechy_capsule.`;
      targetTools = ["recall_memory", "evolve_entelechy_capsule", "record_evolution_milestone"];
      break;
    }
    case "resilience_audit": {
      actionSummary = `Audit treasury reserve margin, recent PolicyEngine denials (${gaps.recentDenialCount}), and cycle error patterns; harden guardrails via check_treasury & evolve_entelechy_capsule.`;
      targetTools = ["check_treasury", "evolve_entelechy_capsule", "record_evolution_milestone"];
      break;
    }
  }

  return {
    trajectory: selected,
    actorName: actor.name,
    actorRole: actor.role,
    actionSummary,
    targetTools,
    suggestedBlueprint: nextBlueprint,
    gaps,
  };
}

export function buildEvolutionSummary(input: {
  missions: Mission[];
  activeMissionId?: string | null;
  tasks: Task[];
  workQueue: WorkItem[];
  agentMessages: AgentMessage[];
  trajectories: EvolutionTrajectory[];
  events: EvolutionEvent[];
  cycles: ExecutionCycle[];
  activeDomain: DomainId;
  tools: DynamicTool[];
  children: Child[];
  domainMemories: DomainMemoryItem[];
  denials: PolicyDenial[];
  now?: number;
}): EvolutionSummary {
  const idle = evaluateOperationalIdleState({
    missions: input.missions,
    activeMissionId: input.activeMissionId,
    tasks: input.tasks,
    workQueue: input.workQueue,
    agentMessages: input.agentMessages,
  });

  const plan = selectNextEvolutionStep({
    trajectories: input.trajectories,
    activeDomain: input.activeDomain,
    tools: input.tools,
    children: input.children,
    domainMemories: input.domainMemories,
    cycles: input.cycles,
    denials: input.denials,
    now: input.now,
  });

  const pool = input.trajectories.length > 0 ? input.trajectories : [plan.trajectory];
  const overallMaturity = Math.round(
    pool.reduce((sum, t) => sum + t.maturityScore, 0) / pool.length,
  );
  const capabilitiesUnlockedCount = new Set(
    input.events.map((e) => e.capabilityGained).filter((x): x is string => Boolean(x)),
  ).size;
  const selfEvolutionCyclesCount = input.cycles.filter((c) => c.mode === "self_evolution").length;

  return {
    isIdle: idle.isIdle,
    idleReason: idle.idleReason,
    activeTaskCount: idle.activeTaskCount,
    pendingWorkCount: idle.pendingWorkCount,
    pendingHandoffCount: idle.pendingHandoffCount,
    nextTrajectorySlug: plan.trajectory.slug,
    nextTrajectoryTitle: plan.trajectory.title,
    nextActorName: plan.actorName,
    recommendedAction: plan.actionSummary,
    overallMaturity,
    capabilitiesUnlockedCount,
    selfEvolutionCyclesCount,
    gaps: plan.gaps,
  };
}

export interface DerivedEvolutionOutcome {
  actionKind: EvolutionActionKind;
  summary: string;
  capabilityGained?: string;
  artifactRef?: string;
  maturityDelta: number;
  verified: boolean;
}

export function deriveEvolutionOutcomeFromTurn(input: {
  trajectory: EvolutionTrajectory;
  toolsUsed: string[];
  synthesizedToolNames: string[];
  benchmarkedToolNames: string[];
  upgradedAgents: string[];
  finalText: string;
  defaultBlueprintName?: string;
}): DerivedEvolutionOutcome {
  const used = new Set(input.toolsUsed);
  const cleanSummary = input.finalText.replace(/\s+/g, " ").trim().slice(0, 260);

  if (input.synthesizedToolNames.length > 0) {
    const tool = input.synthesizedToolNames[0]!;
    const alsoTested = input.benchmarkedToolNames.includes(tool);
    return {
      actionKind: alsoTested ? "tool_benchmarked" : "tool_synthesized",
      summary:
        cleanSummary ||
        `Synthesized${alsoTested ? " & live-benchmarked" : ""} capability '${tool}' in Tool Forge.`,
      capabilityGained: tool,
      artifactRef: `tool:${tool}`,
      maturityDelta: alsoTested ? 12 : 9,
      verified: true,
    };
  }

  if (input.benchmarkedToolNames.length > 0) {
    const tool = input.benchmarkedToolNames[0]!;
    return {
      actionKind: "tool_benchmarked",
      summary: cleanSummary || `Verified live execution benchmark for tool '${tool}'.`,
      capabilityGained: `${tool}_verified`,
      artifactRef: `tool:${tool}`,
      maturityDelta: 8,
      verified: true,
    };
  }

  if (input.upgradedAgents.length > 0) {
    const agt = input.upgradedAgents[0]!;
    return {
      actionKind: "agent_upgraded",
      summary: cleanSummary || `Calibrated specialist prompt & tool bindings for ${agt}.`,
      capabilityGained: `${agt}_calibrated`,
      artifactRef: `agent:${agt}`,
      maturityDelta: 8,
      verified: true,
    };
  }

  if (
    used.has("search_arxiv") ||
    used.has("search_github_repos") ||
    used.has("web_grounding_research") ||
    used.has("analyze_url_context") ||
    used.has("query_pubmed_trials") ||
    used.has("query_openfda_events") ||
    used.has("query_usgs_weather") ||
    used.has("query_nvd_cves") ||
    used.has("query_federal_register")
  ) {
    return {
      actionKind: "research_discovery",
      summary: cleanSummary || `Completed live frontier research via ${[...used].slice(0, 3).join(", ")}.`,
      capabilityGained: `${input.trajectory.targetCapability}_insight`,
      maturityDelta: 7,
      verified: true,
    };
  }

  if (used.has("check_treasury") || used.has("evolve_entelechy_capsule")) {
    return {
      actionKind:
        input.trajectory.slug === "resilience_audit"
          ? "resilience_hardened"
          : "memory_distilled",
      summary:
        cleanSummary ||
        `Hardened strategic Entelechy capsule and verified reserve posture along ${input.trajectory.title}.`,
      capabilityGained: input.defaultBlueprintName,
      maturityDelta: 6,
      verified: true,
    };
  }

  return {
    actionKind:
      input.trajectory.slug === "memory_consolidation"
        ? "memory_distilled"
        : input.trajectory.slug === "resilience_audit"
          ? "resilience_hardened"
          : "research_discovery",
    summary:
      cleanSummary ||
      `Executed autonomous self-evolution evaluation pass on trajectory '${input.trajectory.title}'.`,
    maturityDelta: 4,
    verified: input.toolsUsed.length > 0,
  };
}

export function buildEvolutionGrowthMission(input: {
  trajectory: EvolutionTrajectory;
  activeDomain: DomainId;
  healthyAgents: ReadonlyArray<{ name: string; role: string }>;
  idFactory?: (prefix: string, idx: number) => string;
}): {
  title: string;
  objective: string;
  planSummary: string;
  goals: NormalizedGoalInput[];
  tasks: NormalizedTaskInput[];
} {
  const pack = getDomainPack(input.activeDomain);
  const researchAgent =
    input.healthyAgents.find((a) => a.role.toLowerCase().includes("research")) ??
    input.healthyAgents[0] ?? { name: "Orchestrator-Prime", role: "orchestrator" };
  const engineerAgent =
    input.healthyAgents.find((a) => a.role.toLowerCase().includes("engineer")) ??
    input.healthyAgents[0] ?? { name: "Orchestrator-Prime", role: "orchestrator" };
  const auditAgent =
    input.healthyAgents.find((a) => a.role.toLowerCase().includes("verification")) ??
    input.healthyAgents[0] ?? { name: "Orchestrator-Prime", role: "orchestrator" };

  const title = `Self-Evolution [${pack.shortLabel}]: ${input.trajectory.title}`.slice(0, 140);
  const objective = `Advance trajectory '${input.trajectory.title}' (${input.trajectory.horizon}, ${input.trajectory.maturityScore}/100): benchmark & forge '${input.trajectory.targetCapability}', upgrade specialist agent readiness, and archive verified insights into ${pack.name} memory.`;

  const normalized = validateAndNormalizePlan({
    goalsIn: [
      {
        id: "gol_evo_1",
        title: `Upgrade Trajectory: ${input.trajectory.title.slice(0, 64)}`,
        detail: `Execute self-driven research, tool/role synthesis, and verified memory distillation for ${pack.name}.`,
      },
    ],
    tasksIn: [
      {
        id: "tsk_evo_scout",
        goalId: "gol_evo_1",
        title: `Scout frontier gaps for ${input.trajectory.targetCapability}`,
        detail: `Run live ${pack.shortLabel} connectors & arXiv/GitHub reconnaissance to specify concrete capability upgrades.`,
        assignee: researchAgent.name,
        role: researchAgent.role,
        dependsOn: [],
      },
      {
        id: "tsk_evo_forge",
        goalId: "gol_evo_1",
        title: `Synthesize or calibrate ${input.trajectory.targetCapability}`,
        detail: "Use synthesize_tool / configure_agent_role to expand verified capabilities and bind tools to specialists.",
        assignee: engineerAgent.name,
        role: engineerAgent.role,
        dependsOn: ["tsk_evo_scout"],
      },
      {
        id: "tsk_evo_verify",
        goalId: "gol_evo_1",
        title: "Benchmark tool live, distill memory & log milestone",
        detail: "Invoke custom tool live, update Entelechy, and record verified evolution milestone.",
        assignee: auditAgent.name,
        role: auditAgent.role,
        dependsOn: ["tsk_evo_forge"],
      },
    ],
    healthyAgents: input.healthyAgents,
    idFactory: input.idFactory,
  });

  return {
    title,
    objective,
    planSummary: `Autonomous Growth DAG: ${researchAgent.name} (frontier recon) → ${engineerAgent.name} (forge & calibrate) → ${auditAgent.name} (benchmark & milestone).`,
    goals: normalized.goals,
    tasks: normalized.tasks,
  };
}
