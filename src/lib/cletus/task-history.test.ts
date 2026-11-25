import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeNormalizedRmsLevel } from "./browser-audio";
import { buildTaskStatusTimeline, reconstructOperationalStateAt } from "./task-history";
import type { Task, TaskStatusEvent } from "./types";

const TASKS: Task[] = [
  {
    id: "tsk_a",
    goalId: "gol_1",
    missionId: "msn_1",
    title: "Scout sources",
    status: "completed",
    priority: "high",
    assignee: "Research-Specialist-01",
    role: "research",
    dependsOn: [],
    createdAt: 1000,
    updatedAt: 3000,
  },
  {
    id: "tsk_b",
    goalId: "gol_1",
    missionId: "msn_1",
    title: "Build module",
    status: "running",
    priority: "high",
    assignee: "Execution-Engineer-01",
    role: "engineering",
    dependsOn: ["tsk_a"],
    createdAt: 1000,
    updatedAt: 4000,
  },
  {
    id: "tsk_c",
    goalId: "gol_1",
    missionId: "msn_1",
    title: "Verify audit",
    status: "pending",
    priority: "medium",
    assignee: "Verification-Auditor-01",
    role: "verification",
    dependsOn: ["tsk_b"],
    createdAt: 1000,
    updatedAt: 1000,
  },
];

const EVENTS: TaskStatusEvent[] = [
  { id: "e1", taskId: "tsk_a", missionId: "msn_1", status: "pending", actor: "Orchestrator", createdAt: 1000 },
  { id: "e2", taskId: "tsk_b", missionId: "msn_1", status: "pending", actor: "Orchestrator", createdAt: 1000 },
  { id: "e3", taskId: "tsk_c", missionId: "msn_1", status: "pending", actor: "Orchestrator", createdAt: 1000 },
  {
    id: "e4",
    taskId: "tsk_a",
    missionId: "msn_1",
    previousStatus: "pending",
    status: "running",
    actor: "Research-Specialist-01",
    createdAt: 2000,
  },
  {
    id: "e5",
    taskId: "tsk_a",
    missionId: "msn_1",
    previousStatus: "running",
    status: "completed",
    actor: "Research-Specialist-01",
    createdAt: 3000,
  },
  {
    id: "e6",
    taskId: "tsk_b",
    missionId: "msn_1",
    previousStatus: "pending",
    status: "running",
    actor: "Execution-Engineer-01",
    createdAt: 4000,
  },
];

describe("Historical task status timeline & scrubber reconstruction", () => {
  it("builds cumulative timeline buckets across transitions up to now", () => {
    const points = buildTaskStatusTimeline(EVENTS, TASKS, 5000, "msn_1");
    assert.equal(points.length, 5);
    assert.deepEqual(
      points.map((p) => [p.timestamp, p.pending, p.running, p.completed]),
      [
        [1000, 3, 0, 0],
        [2000, 2, 1, 0],
        [3000, 2, 0, 1],
        [4000, 1, 1, 1],
        [5000, 1, 1, 1],
      ],
    );
  });

  it("reconstructs historical operational counts and task states when scrubbing", () => {
    const mid = reconstructOperationalStateAt(EVENTS, TASKS, 3500, 5000, "msn_1");
    assert.equal(mid.counts.completed, 1);
    assert.equal(mid.counts.pending, 2);
    assert.equal(mid.statusesByTaskId.get("tsk_a"), "completed");
    assert.equal(mid.statusesByTaskId.get("tsk_b"), "pending");
    assert.equal(mid.latestEvent?.id, "e5");

    const end = reconstructOperationalStateAt(EVENTS, TASKS, 4500, 5000, "msn_1");
    assert.equal(end.counts.running, 1);
    assert.equal(end.statusesByTaskId.get("tsk_b"), "running");
  });
});

describe("Audio RMS level computation", () => {
  it("returns 0 for silence/noise floor and scales speech amplitude cleanly into 0..1", () => {
    assert.equal(computeNormalizedRmsLevel(new Float32Array([0, 0.001, -0.001])), 0);
    const moderate = computeNormalizedRmsLevel(new Float32Array([0.12, -0.12, 0.12, -0.12]));
    const loud = computeNormalizedRmsLevel(new Float32Array([0.6, -0.6, 0.6, -0.6]));
    assert.ok(moderate > 0.2 && moderate < 0.85);
    assert.equal(loud, 1);

    // Byte time domain centered around 128
    assert.equal(computeNormalizedRmsLevel(new Uint8Array([128, 128, 128, 128]), true), 0);
    assert.ok(computeNormalizedRmsLevel(new Uint8Array([168, 88, 168, 88]), true) > 0.5);
  });
});
