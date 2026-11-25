import test from "node:test";
import assert from "node:assert/strict";
import {
  applyOptimisticTaskUpdate,
  applyTaskOrder,
  computePrioritySortedTaskIds,
  computeReorderedTaskIds,
  sortTasksBySequence,
} from "./task-order";
import type { Task } from "./types";

function makeTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    goalId: "gol_1",
    missionId: "msn_1",
    title: `Task ${id}`,
    status: "pending",
    priority: "medium",
    assignee: "Orchestrator-Prime",
    role: "orchestrator",
    dependsOn: [],
    createdAt: 1000,
    ...overrides,
  };
}

test("Task drag-and-drop sequence & priority ordering", async (t) => {
  await t.test("sortTasksBySequence respects sortOrder then createdAt", () => {
    const tasks = [
      makeTask("t3", { sortOrder: 2, createdAt: 100 }),
      makeTask("t1", { sortOrder: 0, createdAt: 300 }),
      makeTask("t2", { sortOrder: 1, createdAt: 200 }),
    ];
    assert.deepEqual(
      sortTasksBySequence(tasks).map((x) => x.id),
      ["t1", "t2", "t3"],
    );
  });

  await t.test("computeReorderedTaskIds moves dragged task before and after targets cleanly", () => {
    const tasks = [
      makeTask("t1", { sortOrder: 0 }),
      makeTask("t2", { sortOrder: 1 }),
      makeTask("t3", { sortOrder: 2 }),
      makeTask("t4", { sortOrder: 3 }),
    ];

    assert.deepEqual(computeReorderedTaskIds(tasks, "t4", "t1", "before"), [
      "t4",
      "t1",
      "t2",
      "t3",
    ]);
    assert.deepEqual(computeReorderedTaskIds(tasks, "t1", "t3", "after"), [
      "t2",
      "t3",
      "t1",
      "t4",
    ]);
    assert.deepEqual(computeReorderedTaskIds(tasks, "t2", "t2", "before"), [
      "t1",
      "t2",
      "t3",
      "t4",
    ]);
  });

  await t.test("computePrioritySortedTaskIds orders High -> Medium -> Low stably", () => {
    const tasks = [
      makeTask("t_low", { sortOrder: 0, priority: "low" }),
      makeTask("t_med_a", { sortOrder: 1, priority: "medium" }),
      makeTask("t_high", { sortOrder: 2, priority: "high" }),
      makeTask("t_med_b", { sortOrder: 3, priority: "medium" }),
    ];

    assert.deepEqual(computePrioritySortedTaskIds(tasks), [
      "t_high",
      "t_med_a",
      "t_med_b",
      "t_low",
    ]);
  });

  await t.test("applyTaskOrder normalizes contiguous sortOrder and retains unlisted tasks", () => {
    const tasks = [
      makeTask("t1", { sortOrder: 0 }),
      makeTask("t2", { sortOrder: 1 }),
      makeTask("t3", { sortOrder: 2 }),
    ];

    const updated = applyTaskOrder(tasks, ["t3", "t1"]);
    assert.deepEqual(
      updated.map((x) => [x.id, x.sortOrder]),
      [
        ["t3", 0],
        ["t1", 1],
        ["t2", 2],
      ],
    );
  });

  await t.test("applyOptimisticTaskUpdate updates matching task immediately without mutating originals", () => {
    const original = [
      makeTask("t1", { status: "assigned", sortOrder: 0 }),
      makeTask("t2", { status: "pending", sortOrder: 1 }),
    ];
    const next = applyOptimisticTaskUpdate(original, {
      id: "t1",
      status: "completed",
      result: "Verified immediately",
    });

    assert.equal(original[0]?.status, "assigned");
    assert.equal(next[0]?.status, "completed");
    assert.equal(next[0]?.result, "Verified immediately");
    assert.equal(next[1]?.status, "pending");
  });
});
