import type { Sql } from "@/lib/db";
import { nid } from "./format";
import type { TaskStatus } from "./types";

let taskHistorySeeded = false;

export async function recordTaskEvent(
  sql: Sql,
  params: {
    taskId: string;
    missionId?: string | null;
    goalId?: string | null;
    previousStatus?: TaskStatus | null;
    status: TaskStatus;
    actor: string;
    note?: string | null;
    at?: number;
  },
): Promise<void> {
  const id = nid("tevt");
  const createdAt = params.at ?? Date.now();
  await sql`
    INSERT INTO cletus_task_events (
      id, task_id, mission_id, goal_id, previous_status, status, actor, note, created_at
    ) VALUES (
      ${id},
      ${params.taskId},
      ${params.missionId ?? null},
      ${params.goalId ?? null},
      ${params.previousStatus ?? null},
      ${params.status},
      ${params.actor},
      ${params.note ? params.note.slice(0, 260) : null},
      ${createdAt}
    )
  `;
}

export async function ensureTaskEventsSeeded(sql: Sql): Promise<void> {
  if (taskHistorySeeded) return;
  const countRows = await sql<{ cnt: number }>`SELECT COUNT(*)::int AS cnt FROM cletus_task_events`;
  if ((countRows[0]?.cnt ?? 0) > 0) {
    taskHistorySeeded = true;
    return;
  }

  const tasks = await sql<{
    id: string;
    goal_id: string;
    mission_id: string | null;
    title: string;
    status: string;
    assignee: string;
    result: string | null;
    created_at: number;
    updated_at: number | null;
  }>`SELECT id, goal_id, mission_id, title, status, assignee, result, created_at, updated_at FROM cletus_tasks ORDER BY created_at ASC`;

  const now = Date.now();
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i]!;
    const createdAt = Number(t.created_at) || now - 400_000 + i * 35_000;
    const updatedAt = Math.max(createdAt + 25_000, Number(t.updated_at ?? createdAt));

    // Initial planned creation event
    await sql`
      INSERT INTO cletus_task_events (
        id, task_id, mission_id, goal_id, previous_status, status, actor, note, created_at
      ) VALUES (
        ${`tevt_seed_init_${t.id}`},
        ${t.id},
        ${t.mission_id},
        ${t.goal_id},
        ${null},
        ${t.status === "pending" ? "pending" : "assigned"},
        'Orchestrator-Prime',
        ${`Scheduled: ${t.title.slice(0, 120)}`},
        ${createdAt}
      ) ON CONFLICT (id) DO NOTHING
    `;

    if (t.status === "running") {
      await sql`
        INSERT INTO cletus_task_events (
          id, task_id, mission_id, goal_id, previous_status, status, actor, note, created_at
        ) VALUES (
          ${`tevt_seed_run_${t.id}`},
          ${t.id},
          ${t.mission_id},
          ${t.goal_id},
          'assigned',
          'running',
          ${t.assignee},
          ${`Started execution by ${t.assignee}`},
          ${Math.min(now - 10_000, createdAt + 45_000)}
        ) ON CONFLICT (id) DO NOTHING
      `;
    } else if (t.status === "completed") {
      const midAt = Math.min(updatedAt - 10_000, createdAt + 35_000);
      await sql`
        INSERT INTO cletus_task_events (
          id, task_id, mission_id, goal_id, previous_status, status, actor, note, created_at
        ) VALUES (
          ${`tevt_seed_run_${t.id}`},
          ${t.id},
          ${t.mission_id},
          ${t.goal_id},
          'assigned',
          'running',
          ${t.assignee},
          ${`In progress by ${t.assignee}`},
          ${midAt}
        ) ON CONFLICT (id) DO NOTHING
      `;
      await sql`
        INSERT INTO cletus_task_events (
          id, task_id, mission_id, goal_id, previous_status, status, actor, note, created_at
        ) VALUES (
          ${`tevt_seed_done_${t.id}`},
          ${t.id},
          ${t.mission_id},
          ${t.goal_id},
          'running',
          'completed',
          ${t.assignee},
          ${(t.result ?? t.title).slice(0, 180)},
          ${Math.min(now - 5_000, Math.max(midAt + 20_000, updatedAt))}
        ) ON CONFLICT (id) DO NOTHING
      `;
    } else if (t.status === "failed") {
      await sql`
        INSERT INTO cletus_task_events (
          id, task_id, mission_id, goal_id, previous_status, status, actor, note, created_at
        ) VALUES (
          ${`tevt_seed_fail_${t.id}`},
          ${t.id},
          ${t.mission_id},
          ${t.goal_id},
          'running',
          'failed',
          ${t.assignee},
          ${(t.result ?? t.title).slice(0, 180)},
          ${updatedAt}
        ) ON CONFLICT (id) DO NOTHING
      `;
    }
  }

  taskHistorySeeded = true;
}
