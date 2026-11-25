import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildFallbackMissionPlan,
  canTransitionTaskStatus,
  computeGoalProgress,
  computeStaleReapActions,
  getReadyTasks,
  getTierPolicy,
  isHeartbeatDue,
  parseHeartbeatCadenceMs,
  reconcileLifecycle,
  renderUrlTemplate,
  selectNextActor,
  tierFromCredits,
  validateAndNormalizePlan,
  validatePublicHttpsUrl,
  wouldCreateTaskCycle,
} from "./mas-engine";
import { normalizeTaskPriority, taskPriorityBadgeClass, taskPriorityLabel } from "./format";
import type { AgentMessage, Child, Goal, InboxMessage, Mission, Task, WorkItem } from "./types";

const BASE_WORKERS: Child[] = [
  {
    id: "agt_orch",
    name: "Orchestrator-Prime",
    kind: "local",
    status: "healthy",
    role: "orchestrator",
    lastBeatAgoMs: 1000,
    model: "nvidia/llama-3.3-nemotron-super-49b-v1",
    capabilities: ["decompose_mission", "configure_agent_role"],
    autonomyLevel: "autonomous",
    cycleCount: 12,
  },
  {
    id: "agt_res",
    name: "Research-Specialist-01",
    kind: "openclaw",
    status: "healthy",
    role: "research",
    lastBeatAgoMs: 2000,
    model: "nvidia/llama-3.3-nemotron-super-49b-v1",
    capabilities: ["search_arxiv", "search_github_repos"],
    autonomyLevel: "autonomous",
    cycleCount: 5,
  },
  {
    id: "agt_gated",
    name: "Systems-Worker-02",
    kind: "openclaw",
    status: "starting",
    role: "sandbox-worker",
    lastBeatAgoMs: 5000,
    model: "nvidia/llama-3.3-nemotron-super-49b-v1",
    capabilities: [],
    autonomyLevel: "gated",
    cycleCount: 0,
  },
];

describe("MAS credit-tier depletion policy", () => {
  it("classifies credit balances into accurate survival tiers", () => {
    assert.equal(tierFromCredits(0, 1000), "dead");
    assert.equal(tierFromCredits(-10, 1000), "dead");
    assert.equal(tierFromCredits(850, 1000), "critical");
    assert.equal(tierFromCredits(2500, 1000), "low_compute");
    assert.equal(tierFromCredits(18420, 1000), "normal");
    assert.equal(tierFromCredits(60000, 1000), "high");
  });

  it("halts inference when dead and blocks worker spawning in critical mode", () => {
    const dead = getTierPolicy("dead", 1000);
    assert.equal(dead.canRunInference, false);
    assert.equal(dead.allowContinuousAutoLoop, false);

    const critical = getTierPolicy("critical", 1000);
    assert.equal(critical.canRunInference, true);
    assert.equal(critical.allowContinuousAutoLoop, false);
    assert.equal(critical.allowSpawnWorkers, false);
    assert.equal(critical.maxChildFundingCents, 0);

    const low = getTierPolicy("low_compute", 1000);
    assert.equal(low.allowSpawnWorkers, false);
    assert.equal(low.maxRoundsPerTurn, 3);
  });
});

describe("DAG dependency readiness, cycle detection & transition safety", () => {
  const tasks: Task[] = [
    {
      id: "t1",
      goalId: "g1",
      title: "Discover papers",
      status: "completed",
      assignee: "Research-Specialist-01",
      role: "research",
      dependsOn: [],
    },
    {
      id: "t2",
      goalId: "g1",
      title: "Synthesize tool",
      status: "pending",
      assignee: "Orchestrator-Prime",
      role: "orchestrator",
      dependsOn: ["t1"],
    },
    {
      id: "t3",
      goalId: "g1",
      title: "Verify tool",
      status: "pending",
      assignee: "Research-Specialist-01",
      role: "verification",
      dependsOn: ["t2"],
    },
  ];

  it("only schedules tasks whose upstream dependencies are completed", () => {
    const ready = getReadyTasks(tasks);
    assert.deepEqual(
      ready.map((t) => t.id),
      ["t2"],
    );
  });

  it("blocks completing or running a task with incomplete upstream prerequisites", () => {
    const blocked = canTransitionTaskStatus(tasks, "t3", "completed");
    assert.equal(blocked.ok, false);
    if (!blocked.ok) {
      assert.deepEqual(blocked.blockedBy, ["t2"]);
    }
    const blockedRun = canTransitionTaskStatus(tasks, "t3", "running");
    assert.equal(blockedRun.ok, false);

    const allowed = canTransitionTaskStatus(tasks, "t2", "completed");
    assert.equal(allowed.ok, true);
  });

  it("detects circular dependencies before persisting edges", () => {
    assert.equal(wouldCreateTaskCycle(tasks, "t1", ["t3"]), true);
    assert.equal(wouldCreateTaskCycle(tasks, "t1", ["t1"]), true);
    assert.equal(wouldCreateTaskCycle(tasks, "t3", ["t1", "t2"]), false);
  });

  it("computes deterministic goal progress from tasks", () => {
    const goal: Goal = {
      id: "g1",
      title: "G1",
      detail: "D1",
      status: "active",
      progress: 0,
      expectedRevenueCents: 0,
      actualRevenueCents: 0,
    };
    assert.equal(computeGoalProgress(goal, tasks), 33);
  });
});

describe("Mission plan validation, cycle stripping & fallback pipeline", () => {
  it("strips circular/invalid deps, starts roots in assigned, and maps unknown assignees", () => {
    let seq = 0;
    const plan = validateAndNormalizePlan({
      goalsIn: [{ id: "g_a", title: "Ship Protocol", detail: "End-to-end" }],
      tasksIn: [
        {
          id: "step_1",
          goalId: "g_a",
          title: "Research",
          assignee: "Ghost-Agent",
          role: "research",
          dependsOn: ["nonexistent"],
        },
        {
          id: "step_2",
          goalId: "g_a",
          title: "Implement",
          assignee: "Orchestrator-Prime",
          role: "orchestrator",
          dependsOn: ["step_1", "step_2"],
        },
      ],
      healthyAgents: BASE_WORKERS.filter((w) => w.status === "healthy").map((w) => ({
        name: w.name,
        role: w.role,
      })),
      idFactory: (p) => `${p}_${++seq}`,
    });

    assert.equal(plan.goals.length, 1);
    assert.equal(plan.tasks.length, 2);
    assert.equal(plan.tasks[0]?.assignee, "Research-Specialist-01");
    assert.equal(plan.tasks[0]?.status, "assigned");
    assert.deepEqual(plan.tasks[0]?.dependsOn, []);
    assert.equal(plan.tasks[1]?.status, "pending");
    assert.deepEqual(plan.tasks[1]?.dependsOn, [plan.tasks[0]!.id]);
    assert.equal(plan.strippedEdges, 2);
  });

  it("synthesizes a deterministic 3-stage acyclic fallback plan when LLM omits decompose_mission", () => {
    let seq = 0;
    const fallback = buildFallbackMissionPlan({
      objective: "Audit post-quantum TLS readiness across repository dependencies",
      healthyAgents: BASE_WORKERS.filter((w) => w.status === "healthy").map((w) => ({
        name: w.name,
        role: w.role,
      })),
      idFactory: (p) => `${p}_${++seq}`,
    });

    assert.equal(fallback.goals.length, 1);
    assert.equal(fallback.tasks.length, 3);
    assert.equal(fallback.tasks[0]?.status, "assigned");
    assert.deepEqual(fallback.tasks[1]?.dependsOn, [fallback.tasks[0]!.id]);
    assert.deepEqual(fallback.tasks[2]?.dependsOn, [fallback.tasks[1]!.id]);
  });
});

describe("Multi-agent handoff & actor scheduler", () => {
  it("prioritizes pending inter-agent handoffs to healthy specialist agents", () => {
    const msgs: AgentMessage[] = [
      {
        id: "msg_1",
        missionId: "msn_1",
        taskId: "t2",
        fromAgent: "Orchestrator-Prime",
        toAgent: "Research-Specialist-01",
        messageType: "handoff",
        subject: "Run arXiv query",
        payload: { query: "multi-agent planning" },
        status: "pending",
        createdAt: 1000,
      },
    ];
    const next = selectNextActor({
      children: BASE_WORKERS,
      tasks: [],
      workQueue: [],
      agentMessages: msgs,
    });
    assert.equal(next.agentName, "Research-Specialist-01");
    assert.equal(next.pendingMessageId, "msg_1");
  });

  it("preempts background tasks when an urgent operator directive is queued", () => {
    const next = selectNextActor({
      children: BASE_WORKERS,
      tasks: [
        {
          id: "t_bg",
          goalId: "g1",
          title: "Routine background task",
          status: "assigned",
          assignee: "Research-Specialist-01",
          role: "research",
          dependsOn: [],
        },
      ],
      workQueue: [
        {
          id: "wrk_op",
          source: "operator_directive",
          payload: { directive: "Halt external calls and audit reserves" },
          acceptancePredicate: "result.success === true",
          priority: 100,
          spendBearing: false,
          status: "pending",
          attempts: 0,
          createdAt: 5000,
          updatedAt: 5000,
        },
      ],
      agentMessages: [],
    });
    assert.equal(next.agentName, "Orchestrator-Prime");
    assert.equal(next.focusWorkItemId, "wrk_op");
  });

  it("ranks critical-path tasks unlocking downstream nodes ahead of leaf tasks", () => {
    const next = selectNextActor({
      children: BASE_WORKERS,
      tasks: [
        {
          id: "t_leaf",
          goalId: "g1",
          missionId: "msn_1",
          title: "Optional leaf check",
          status: "assigned",
          assignee: "Orchestrator-Prime",
          role: "orchestrator",
          dependsOn: [],
          createdAt: 100,
        },
        {
          id: "t_blocker",
          goalId: "g1",
          missionId: "msn_1",
          title: "Core prerequisite discovery",
          status: "assigned",
          assignee: "Research-Specialist-01",
          role: "research",
          dependsOn: [],
          createdAt: 200,
        },
        {
          id: "t_downstream_1",
          goalId: "g1",
          missionId: "msn_1",
          title: "Build deliverable",
          status: "pending",
          assignee: "Orchestrator-Prime",
          role: "orchestrator",
          dependsOn: ["t_blocker"],
        },
      ],
      workQueue: [],
      agentMessages: [],
      activeMissionId: "msn_1",
    });
    assert.equal(next.focusTaskId, "t_blocker");
    assert.equal(next.agentName, "Research-Specialist-01");
  });

  it("skips unhealthy/starting gated agents when scheduling tasks", () => {
    const tasks: Task[] = [
      {
        id: "t_gated",
        goalId: "g1",
        title: "Wait for attestation",
        status: "pending",
        assignee: "Systems-Worker-02",
        role: "sandbox-worker",
        dependsOn: [],
      },
    ];
    const workQueue: WorkItem[] = [];
    const next = selectNextActor({
      children: BASE_WORKERS,
      tasks,
      workQueue,
      agentMessages: [],
    });
    assert.equal(next.agentName, "Orchestrator-Prime");
  });

  it("defaults to self_evolution mode when no operational tasks, work, or handoffs remain", () => {
    const completedMission: Mission = {
      id: "msn_done",
      title: "Completed",
      objective: "Done",
      status: "completed",
      orchestrator: "Orchestrator-Prime",
      successCriteria: "Done",
      cycleCount: 3,
      maxCycles: 12,
      createdAt: 1000,
      updatedAt: 2000,
    };

    const next = selectNextActor({
      children: BASE_WORKERS,
      missions: [completedMission],
      activeMissionId: "msn_done",
      tasks: [
        {
          id: "t_closed",
          goalId: "g1",
          missionId: "msn_done",
          title: "Old task on completed mission",
          status: "assigned",
          assignee: "Research-Specialist-01",
          role: "research",
          dependsOn: [],
        },
      ],
      workQueue: [],
      agentMessages: [],
      idleEvolutionTarget: {
        agentName: "Research-Specialist-01",
        agentRole: "research",
        reason: "Self-Evolution: Frontier Research",
      },
    });

    assert.equal(next.mode, "self_evolution");
    assert.equal(next.agentName, "Research-Specialist-01");
    assert.match(next.reason, /Self-Evolution/);
  });

  it("ranks high-priority ready tasks ahead of medium/low priority tasks and exposes color badges", () => {
    const tasks: Task[] = [
      {
        id: "t_low",
        goalId: "g1",
        title: "Low task",
        status: "assigned",
        priority: "low",
        assignee: "Orchestrator-Prime",
        role: "orchestrator",
        dependsOn: [],
        createdAt: 100,
      },
      {
        id: "t_high",
        goalId: "g1",
        title: "High task",
        status: "assigned",
        priority: "high",
        assignee: "Research-Specialist-01",
        role: "research",
        dependsOn: [],
        createdAt: 200,
      },
    ];
    const next = selectNextActor({
      children: BASE_WORKERS,
      tasks,
      workQueue: [],
      agentMessages: [],
    });
    assert.equal(next.focusTaskId, "t_high");
    assert.equal(normalizeTaskPriority(undefined), "medium");
    assert.equal(taskPriorityLabel("high"), "High");
    assert.equal(taskPriorityLabel("low"), "Low");
    assert.notEqual(taskPriorityBadgeClass("high"), taskPriorityBadgeClass("medium"));
    assert.notEqual(taskPriorityBadgeClass("medium"), taskPriorityBadgeClass("low"));
  });

  it("respects manual sortOrder as scheduler tie-breaker across equal-priority ready tasks", () => {
    const orderedWins = selectNextActor({
      children: BASE_WORKERS,
      tasks: [
        {
          id: "t_second",
          goalId: "g1",
          title: "Second in manual sequence",
          status: "assigned",
          priority: "high",
          sortOrder: 5,
          assignee: "Research-Specialist-01",
          role: "research",
          dependsOn: [],
          createdAt: 100,
        },
        {
          id: "t_first",
          goalId: "g1",
          title: "First in manual sequence",
          status: "assigned",
          priority: "high",
          sortOrder: 1,
          assignee: "Research-Specialist-01",
          role: "research",
          dependsOn: [],
          createdAt: 900,
        },
      ],
      workQueue: [],
      agentMessages: [],
    });

    assert.equal(orderedWins.focusTaskId, "t_first");
  });
});

describe("Lifecycle reconciliation & heartbeat stale-slot reaper", () => {
  it("unlocks downstream tasks, completes goals, and completes active mission when done", () => {
    const mission: Mission = {
      id: "msn_1",
      title: "Test Mission",
      objective: "Complete pipeline",
      status: "active",
      orchestrator: "Orchestrator-Prime",
      planSummary: "Two steps",
      successCriteria: "Both done",
      cycleCount: 3,
      maxCycles: 12,
      createdAt: 1000,
      updatedAt: 2000,
    };
    const goals: Goal[] = [
      {
        id: "g1",
        missionId: "msn_1",
        title: "Goal 1",
        detail: "Detail",
        status: "active",
        progress: 50,
        expectedRevenueCents: 0,
        actualRevenueCents: 0,
      },
    ];
    const tasks: Task[] = [
      {
        id: "t1",
        goalId: "g1",
        missionId: "msn_1",
        title: "Step 1",
        status: "completed",
        assignee: "Research-Specialist-01",
        role: "research",
        dependsOn: [],
      },
      {
        id: "t2",
        goalId: "g1",
        missionId: "msn_1",
        title: "Step 2",
        status: "pending",
        assignee: "Orchestrator-Prime",
        role: "orchestrator",
        dependsOn: ["t1"],
      },
    ];

    const step1 = reconcileLifecycle({ mission, goals, tasks, workQueue: [] });
    assert.deepEqual(step1.tasksToUnlock, ["t2"]);
    assert.equal(step1.goalUpdates[0]?.progress, 63);
    assert.equal(step1.missionUpdate, undefined);

    const allDoneTasks = tasks.map((t) => ({ ...t, status: "completed" as const }));
    const step2 = reconcileLifecycle({ mission, goals, tasks: allDoneTasks, workQueue: [] });
    assert.equal(step2.goalUpdates[0]?.progress, 100);
    assert.equal(step2.goalUpdates[0]?.status, "completed");
    assert.equal(step2.missionUpdate?.nextStatus, "completed");
  });

  it("halts mission cleanly when cycleCount hits maxCycles with remaining tasks", () => {
    const mission: Mission = {
      id: "msn_2",
      title: "Budget Cap Test",
      objective: "Reach maxCycles",
      status: "active",
      orchestrator: "Orchestrator-Prime",
      planSummary: "Test",
      successCriteria: "Test",
      cycleCount: 12,
      maxCycles: 12,
      createdAt: 1000,
      updatedAt: 2000,
    };
    const res = reconcileLifecycle({
      mission,
      goals: [],
      tasks: [
        {
          id: "t_open",
          goalId: "g1",
          missionId: "msn_2",
          title: "Still open",
          status: "assigned",
          assignee: "Orchestrator-Prime",
          role: "orchestrator",
          dependsOn: [],
        },
      ],
      workQueue: [],
    });
    assert.equal(res.missionUpdate?.nextStatus, "halted");
  });

  it("parses heartbeat cadences and reaps stale claims, stuck tasks, orphan inbox, and silent workers", () => {
    assert.equal(parseHeartbeatCadenceMs("2m"), 120_000);
    assert.equal(parseHeartbeatCadenceMs("6h"), 21_600_000);
    assert.equal(isHeartbeatDue({ cadence: "2m", lastRunAt: 1_000_000 }, 1_125_000), true);
    assert.equal(isHeartbeatDue({ cadence: "2m", lastRunAt: 1_000_000 }, 1_050_000), false);

    const now = 10_000_000;
    const reap = computeStaleReapActions({
      now,
      tasks: [
        {
          id: "tsk_stuck",
          goalId: "g1",
          title: "Hung inference",
          status: "running",
          assignee: "Research-Specialist-01",
          role: "research",
          dependsOn: [],
          updatedAt: now - 11 * 60_000,
        },
      ],
      workQueue: [
        {
          id: "wrk_retry",
          source: "operator_directive",
          payload: {},
          acceptancePredicate: "ok",
          priority: 100,
          spendBearing: false,
          status: "claimed",
          attempts: 1,
          createdAt: now - 5 * 60_000,
          updatedAt: now - 4 * 60_000,
        },
        {
          id: "wrk_expire",
          source: "orchestrator",
          payload: {},
          acceptancePredicate: "ok",
          priority: 50,
          spendBearing: false,
          status: "claimed",
          attempts: 3,
          createdAt: now - 10 * 60_000,
          updatedAt: now - 4 * 60_000,
        },
      ],
      inbox: [
        {
          id: "inb_old",
          from: "creator",
          content: "Old directive",
          at: now - 15 * 60_000,
          status: "received",
        } as InboxMessage,
      ],
      children: [
        {
          ...BASE_WORKERS[1]!,
          lastBeatAgoMs: 16 * 60_000,
        },
      ],
    });

    assert.deepEqual(reap.workToRetry, ["wrk_retry"]);
    assert.deepEqual(reap.workToExpire, ["wrk_expire"]);
    assert.deepEqual(reap.tasksToResetAssigned, ["tsk_stuck"]);
    assert.deepEqual(reap.workersToFlagUnhealthy, ["agt_res"]);
    // When pending/claimed work exists, inbox stays open; when clear, closes stale inbox
    assert.deepEqual(reap.inboxToClose, []);

    const reapNoWork = computeStaleReapActions({
      now,
      tasks: [],
      workQueue: [],
      inbox: [
        {
          id: "inb_old",
          from: "creator",
          content: "Old directive",
          at: now - 15 * 60_000,
          status: "received",
          priority: "work",
        },
      ],
      children: [],
    });
    assert.deepEqual(reapNoWork.inboxToClose, ["inb_old"]);
  });
});

describe("SSRF URL guard & safe template rendering", () => {
  it("blocks localhost, loopback, metadata, and non-HTTPS URLs", () => {
    assert.equal(validatePublicHttpsUrl("http://export.arxiv.org/api/query").ok, false);
    assert.equal(validatePublicHttpsUrl("https://127.0.0.1:8080/secret").ok, false);
    assert.equal(validatePublicHttpsUrl("https://169.254.169.254/latest/meta-data").ok, false);
    assert.equal(validatePublicHttpsUrl("https://10.0.0.1/internal").ok, false);
    assert.equal(validatePublicHttpsUrl("https://localhost/admin").ok, false);
    assert.equal(validatePublicHttpsUrl("https://export.arxiv.org/api/query").ok, true);
  });

  it("URL-encodes dynamic query template substitutions", () => {
    const url = renderUrlTemplate(
      "https://api.github.com/search/repositories?q={{query}}&per_page={{limit}}",
      { query: "multi agent & tools", limit: 5 },
    );
    assert.equal(
      url,
      "https://api.github.com/search/repositories?q=multi%20agent%20%26%20tools&per_page=5",
    );
  });
});
