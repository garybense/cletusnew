import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildD3TaskHierarchyGraph,
  computeTaskMetadata,
  computeTaskTopologicalLayers,
  getConnectedLineage,
  getIncompleteUpstreamIds,
} from "./d3-graph";
import type { Child, Goal, Mission, Task } from "./types";

const MISSIONS: Mission[] = [
  {
    id: "msn_1",
    title: "Autonomous Capability Verification",
    objective: "Verify tools and agent handoffs",
    status: "active",
    orchestrator: "Orchestrator-Prime",
    successCriteria: "All tasks done",
    cycleCount: 3,
    maxCycles: 12,
    createdAt: 1000,
    updatedAt: 2000,
  },
];

const GOALS: Goal[] = [
  {
    id: "gol_1",
    missionId: "msn_1",
    title: "Deliver Verified Tooling",
    detail: "Scout -> Synthesize -> Audit",
    status: "active",
    progress: 33,
    expectedRevenueCents: 0,
    actualRevenueCents: 0,
  },
];

const TASKS: Task[] = [
  {
    id: "tsk_1",
    goalId: "gol_1",
    missionId: "msn_1",
    title: "Scout arXiv patterns",
    status: "completed",
    assignee: "Research-Specialist-01",
    role: "research",
    dependsOn: [],
    createdAt: 100,
  },
  {
    id: "tsk_2",
    goalId: "gol_1",
    missionId: "msn_1",
    title: "Synthesize live connector",
    status: "running",
    assignee: "Execution-Engineer-01",
    role: "engineering",
    dependsOn: ["tsk_1"],
    createdAt: 200,
  },
  {
    id: "tsk_3",
    goalId: "gol_1",
    missionId: "msn_1",
    title: "Audit acceptance criteria",
    status: "pending",
    assignee: "Verification-Auditor-01",
    role: "verification",
    dependsOn: ["tsk_2"],
    createdAt: 300,
  },
];

const WORKERS: Child[] = [
  {
    id: "w_res",
    name: "Research-Specialist-01",
    kind: "openclaw",
    status: "healthy",
    role: "research",
    lastBeatAgoMs: 1000,
    model: "nvidia/llama-3.3-nemotron-super-49b-v1",
    capabilities: [],
    autonomyLevel: "autonomous",
    cycleCount: 2,
  },
  {
    id: "w_eng",
    name: "Execution-Engineer-01",
    kind: "openclaw",
    status: "healthy",
    role: "engineering",
    lastBeatAgoMs: 1200,
    model: "nvidia/llama-3.3-nemotron-super-49b-v1",
    capabilities: [],
    autonomyLevel: "autonomous",
    cycleCount: 1,
  },
];

describe("D3 hierarchical Mission -> Goal -> Task dependency graph", () => {
  it("computes topological stage depth for dependency chains", () => {
    const layers = computeTaskTopologicalLayers(TASKS);
    assert.equal(layers.get("tsk_1"), 0);
    assert.equal(layers.get("tsk_2"), 1);
    assert.equal(layers.get("tsk_3"), 2);
  });

  it("identifies incomplete upstream dependencies accurately", () => {
    assert.deepEqual(getIncompleteUpstreamIds(TASKS, TASKS[1]!), []);
    assert.deepEqual(getIncompleteUpstreamIds(TASKS, TASKS[2]!), ["tsk_2"]);
  });

  it("builds Mission -> Goal -> Multi-Stage Task -> Worker hierarchy with typed edges", () => {
    const layout = buildD3TaskHierarchyGraph({
      missions: MISSIONS,
      goals: GOALS,
      tasks: TASKS,
      children: WORKERS,
      activeMissionId: "msn_1",
    });

    assert.equal(layout.summary.missionsCount, 1);
    assert.equal(layout.summary.goalsCount, 1);
    assert.equal(layout.summary.tasksCount, 3);
    assert.equal(layout.summary.tasksCompleted, 1);
    assert.equal(layout.summary.overallProgressPct, 33);

    const nMission = layout.nodes.find((n) => n.id === "mission:msn_1");
    const nGoal = layout.nodes.find((n) => n.id === "goal:gol_1");
    const nT1 = layout.nodes.find((n) => n.id === "task:tsk_1");
    const nT2 = layout.nodes.find((n) => n.id === "task:tsk_2");
    const nT3 = layout.nodes.find((n) => n.id === "task:tsk_3");

    assert.ok(nMission && nGoal && nT1 && nT2 && nT3);
    assert.ok(nMission.x < nGoal.x);
    assert.ok(nGoal.x < nT1.x);
    assert.ok(nT1.x < nT2.x);
    assert.ok(nT2.x < nT3.x);

    const depEdge12 = layout.edges.find((e) => e.id === "edge:dep:tsk_1:tsk_2");
    const depEdge23 = layout.edges.find((e) => e.id === "edge:dep:tsk_2:tsk_3");
    assert.equal(depEdge12?.satisfied, true);
    assert.equal(depEdge23?.satisfied, false);

    const mgEdge = layout.edges.find((e) => e.kind === "mission_goal");
    const gtEdge = layout.edges.find((e) => e.kind === "goal_task");
    assert.ok(mgEdge && gtEdge);
    assert.equal(gtEdge.targetId, "task:tsk_1");

    const lineage = getConnectedLineage("task:tsk_2", layout.edges);
    // Direct and transitive upstream parents (tsk_1 -> gol_1 -> msn_1)
    assert.ok(lineage.upstreamNodeIds.has("task:tsk_1"));
    assert.ok(lineage.upstreamNodeIds.has("goal:gol_1"));
    assert.ok(lineage.upstreamNodeIds.has("mission:msn_1"));
    // Downstream child task + assigned worker
    assert.ok(lineage.downstreamNodeIds.has("task:tsk_3"));
    assert.ok(lineage.downstreamNodeIds.has("worker:execution-engineer-01"));
    assert.ok(lineage.nodeIds.has("task:tsk_1"));
    assert.ok(lineage.nodeIds.has("task:tsk_3"));
    assert.ok(lineage.nodeIds.has("worker:execution-engineer-01"));

    // Check from root leaf tsk_3: both tsk_2 and tsk_1 (2 hops up) + goal + mission are upstream
    const tailLineage = getConnectedLineage("task:tsk_3", layout.edges);
    assert.ok(tailLineage.upstreamNodeIds.has("task:tsk_2"));
    assert.ok(tailLineage.upstreamNodeIds.has("task:tsk_1"));
    assert.ok(tailLineage.upstreamNodeIds.has("goal:gol_1"));
    assert.ok(tailLineage.upstreamNodeIds.has("mission:msn_1"));
  });

  it("computes detailed task metadata with transitive dependencies and resource metrics", () => {
    const meta = computeTaskMetadata(TASKS[1]!, {
      tasks: TASKS,
      goals: GOALS,
      missions: MISSIONS,
      children: WORKERS,
      cycles: [
        {
          id: "cyc_1",
          missionId: "msn_1",
          turnNumber: 2,
          agentName: "Execution-Engineer-01",
          agentRole: "engineering",
          phasePerceive: "p",
          phaseReason: "Advance tsk_2",
          phaseAct: "Called synth",
          phaseObserve: "ok",
          toolsUsed: ["search_arxiv", "synthesize_tool"],
          durationMs: 1450,
          costCents: 6,
          tier: "normal",
          status: "completed",
          createdAt: 500,
        },
      ],
      spendByModel: [],
      toolSpends: [],
      agentMessages: [],
      taskEvents: [
        {
          id: "ev_1",
          taskId: "tsk_2",
          status: "running",
          actor: "Execution-Engineer-01",
          createdAt: 250,
        },
      ],
      now: 1200,
    });

    assert.equal(meta.startTime, 200);
    assert.equal(meta.elapsedMs, 1000);
    assert.deepEqual(meta.upstreamTasks.map((t) => t.id), ["tsk_1"]);
    assert.deepEqual(meta.downstreamTasks.map((t) => t.id), ["tsk_3"]);
    assert.equal(meta.resourceUsage.cyclesCount, 1);
    assert.equal(meta.resourceUsage.spendCents, 6);
    assert.equal(meta.resourceUsage.toolInvocations, 2);
    assert.equal(meta.resourceUsage.totalDurationMs, 1450);
  });
});
