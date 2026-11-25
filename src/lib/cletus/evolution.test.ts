import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildEvolutionGrowthMission,
  buildEvolutionSummary,
  computeHorizonForMaturity,
  createDefaultEvolutionTrajectories,
  deriveEvolutionOutcomeFromTurn,
  evaluateEvolutionGaps,
  evaluateOperationalIdleState,
  selectNextEvolutionStep,
} from "./evolution";
import type { Child, DynamicTool, ExecutionCycle, Mission, PolicyDenial, Task, WorkItem } from "./types";

const SAMPLE_WORKERS: Child[] = [
  {
    id: "agt_orch",
    name: "Orchestrator-Prime",
    kind: "local",
    status: "healthy",
    role: "orchestrator",
    lastBeatAgoMs: 1_000,
    model: "nvidia/llama-3.3-nemotron-super-49b-v1",
    capabilities: ["decompose_mission", "configure_agent_role"],
    autonomyLevel: "autonomous",
    cycleCount: 10,
  },
  {
    id: "agt_res",
    name: "Research-Specialist-01",
    kind: "openclaw",
    status: "healthy",
    role: "research",
    lastBeatAgoMs: 1_500,
    model: "nvidia/llama-3.3-nemotron-super-49b-v1",
    capabilities: ["search_arxiv", "search_github_repos"],
    autonomyLevel: "autonomous",
    cycleCount: 6,
  },
  {
    id: "agt_eng",
    name: "Execution-Engineer-01",
    kind: "openclaw",
    status: "healthy",
    role: "engineer",
    lastBeatAgoMs: 2_000,
    model: "nvidia/llama-3.3-nemotron-super-49b-v1",
    capabilities: ["synthesize_tool", "invoke_custom_tool"],
    autonomyLevel: "autonomous",
    cycleCount: 4,
  },
  {
    id: "agt_ver",
    name: "Audit-Verifier-01",
    kind: "openclaw",
    status: "healthy",
    role: "verification",
    lastBeatAgoMs: 2_500,
    model: "nvidia/llama-3.3-nemotron-super-49b-v1",
    capabilities: ["check_treasury"],
    autonomyLevel: "autonomous",
    cycleCount: 3,
  },
];

const SAMPLE_TOOLS: DynamicTool[] = [
  {
    id: "tl_1",
    name: "search_arxiv",
    category: "research",
    kind: "builtin",
    description: "Search arXiv",
    inputSchema: {},
    configJson: {},
    enabled: true,
    createdBy: "system",
    usageCount: 3,
    createdAt: 1000,
  },
  {
    id: "tl_2",
    name: "synthesize_tool",
    category: "evolution",
    kind: "builtin",
    description: "Forge tools",
    inputSchema: {},
    configJson: {},
    enabled: true,
    createdBy: "system",
    usageCount: 1,
    createdAt: 1000,
  },
  {
    id: "tl_untested",
    name: "custom_beta_probe",
    category: "research",
    kind: "http_json",
    description: "Untested probe",
    inputSchema: {},
    configJson: {},
    enabled: true,
    createdBy: "Execution-Engineer-01",
    usageCount: 0,
    createdAt: 1000,
  },
];

describe("Self-Evolution trajectory horizon & idle evaluation", () => {
  it("computes horizon progression thresholds deterministically", () => {
    assert.equal(computeHorizonForMaturity(0), "seed");
    assert.equal(computeHorizonForMaturity(19), "seed");
    assert.equal(computeHorizonForMaturity(20), "explore");
    assert.equal(computeHorizonForMaturity(45), "synthesize");
    assert.equal(computeHorizonForMaturity(70), "benchmark");
    assert.equal(computeHorizonForMaturity(90), "mastered");
  });

  it("marks runtime idle when active tasks/work/handoffs are zero or tied only to closed missions", () => {
    const completedMission: Mission = {
      id: "msn_done",
      title: "Done",
      objective: "Done",
      status: "completed",
      orchestrator: "Orchestrator-Prime",
      successCriteria: "Done",
      cycleCount: 3,
      maxCycles: 10,
      createdAt: 1000,
      updatedAt: 2000,
    };

    const closedTask: Task = {
      id: "t_stale",
      goalId: "g_1",
      missionId: "msn_done",
      title: "Leftover open status in completed mission",
      status: "assigned",
      assignee: "Research-Specialist-01",
      role: "research",
      dependsOn: [],
    };

    const staleWork: WorkItem = {
      id: "w_stale",
      missionId: "msn_done",
      source: "orchestrator",
      payload: {},
      acceptancePredicate: "ok",
      priority: 50,
      spendBearing: false,
      status: "pending",
      attempts: 0,
      createdAt: 1000,
      updatedAt: 1000,
    };

    const idle = evaluateOperationalIdleState({
      missions: [completedMission],
      activeMissionId: "msn_done",
      tasks: [closedTask],
      workQueue: [staleWork],
      agentMessages: [],
    });

    assert.equal(idle.isIdle, true);
    assert.equal(idle.activeTaskCount, 0);
    assert.equal(idle.pendingWorkCount, 0);
    assert.match(idle.idleReason, /defaulting to Self-Evolution/i);
  });

  it("marks runtime busy when urgent operator directive exists even if mission is completed", () => {
    const completedMission: Mission = {
      id: "msn_done",
      title: "Done",
      objective: "Done",
      status: "completed",
      orchestrator: "Orchestrator-Prime",
      successCriteria: "Done",
      cycleCount: 3,
      maxCycles: 10,
      createdAt: 1000,
      updatedAt: 2000,
    };
    const urgentWork: WorkItem = {
      id: "w_op",
      missionId: "msn_done",
      source: "operator_directive",
      payload: { directive: "Immediate audit" },
      acceptancePredicate: "ok",
      priority: 100,
      spendBearing: false,
      status: "pending",
      attempts: 0,
      createdAt: 1000,
      updatedAt: 1000,
    };

    const busy = evaluateOperationalIdleState({
      missions: [completedMission],
      activeMissionId: "msn_done",
      tasks: [],
      workQueue: [urgentWork],
      agentMessages: [],
    });

    assert.equal(busy.isIdle, false);
    assert.equal(busy.pendingWorkCount, 1);
  });
});

describe("Self-Evolution gap analysis, specialist routing, outcomes & growth DAG", () => {
  it("prioritizes resilience_audit on cycle errors or excessive denials", () => {
    const faultCycle: ExecutionCycle = {
      id: "cyc_err",
      mode: "mission",
      turnNumber: 4,
      agentName: "Execution-Engineer-01",
      agentRole: "engineer",
      phasePerceive: "p",
      phaseReason: "r",
      phaseAct: "a",
      phaseObserve: "err",
      toolsUsed: [],
      durationMs: 120,
      costCents: 1,
      tier: "normal",
      status: "error",
      createdAt: 5000,
    };
    const denials: PolicyDenial[] = [
      { id: "d1", tool: "t", rule: "r", at: 1000 },
    ];

    const gaps = evaluateEvolutionGaps({
      activeDomain: "mas_rnd",
      tools: SAMPLE_TOOLS,
      children: SAMPLE_WORKERS,
      domainMemories: [],
      cycles: [faultCycle],
      denials,
    });

    assert.equal(gaps.recommendedTrajectory, "resilience_audit");
    assert.ok(gaps.untestedTools.includes("custom_beta_probe"));
    assert.ok(gaps.unboundTools.includes("custom_beta_probe"));
    assert.ok(gaps.missingDomainCapabilities.includes("semantic_scholar_papers"));
  });

  it("selects capability_forging when missing domain capabilities exist & assigns Execution-Engineer", () => {
    const now = 2_000_000;
    const trajectories = createDefaultEvolutionTrajectories(now - 500_000);
    const plan = selectNextEvolutionStep({
      trajectories,
      activeDomain: "mas_rnd",
      tools: SAMPLE_TOOLS,
      children: SAMPLE_WORKERS,
      domainMemories: [],
      cycles: [],
      denials: [],
      now,
    });

    assert.equal(plan.trajectory.slug, "capability_forging");
    assert.equal(plan.actorName, "Execution-Engineer-01");
    assert.equal(plan.suggestedBlueprint?.name, "semantic_scholar_papers");
  });

  it("derives highest maturity deltas for synthesized + benchmarked tools", () => {
    const tr = createDefaultEvolutionTrajectories(10_000)[1]!;
    const out = deriveEvolutionOutcomeFromTurn({
      trajectory: tr,
      toolsUsed: ["synthesize_tool", "invoke_custom_tool"],
      synthesizedToolNames: ["semantic_scholar_papers"],
      benchmarkedToolNames: ["semantic_scholar_papers"],
      upgradedAgents: [],
      finalText: "",
    });
    assert.equal(out.actionKind, "tool_benchmarked");
    assert.equal(out.maturityDelta, 12);
    assert.equal(out.capabilityGained, "semantic_scholar_papers");
    assert.equal(out.verified, true);
  });

  it("builds a 3-stage acyclic Growth Mission DAG for a trajectory", () => {
    const tr = createDefaultEvolutionTrajectories(10_000)[0]!;
    let seq = 0;
    const growth = buildEvolutionGrowthMission({
      trajectory: tr,
      activeDomain: "climate_geospatial",
      healthyAgents: SAMPLE_WORKERS.map((w) => ({ name: w.name, role: w.role })),
      idFactory: (p) => `${p}_evo_${++seq}`,
    });

    assert.equal(growth.goals.length, 1);
    assert.equal(growth.tasks.length, 3);
    assert.equal(growth.tasks[0]?.status, "assigned");
    assert.deepEqual(growth.tasks[1]?.dependsOn, [growth.tasks[0]!.id]);
    assert.deepEqual(growth.tasks[2]?.dependsOn, [growth.tasks[1]!.id]);

    const summary = buildEvolutionSummary({
      missions: [],
      tasks: [],
      workQueue: [],
      agentMessages: [],
      trajectories: createDefaultEvolutionTrajectories(10_000),
      events: [],
      cycles: [],
      activeDomain: "climate_geospatial",
      tools: SAMPLE_TOOLS,
      children: SAMPLE_WORKERS,
      domainMemories: [],
      denials: [],
      now: 100_000,
    });
    assert.equal(summary.isIdle, true);
    assert.ok(summary.overallMaturity > 0);
  });
});
