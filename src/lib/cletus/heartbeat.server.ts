import type { Sql } from "@/lib/db";
import { evaluateEvolutionGaps, selectNextEvolutionStep } from "./evolution";
import { nid } from "./format";
import {
  computeStaleReapActions,
  isHeartbeatDue,
  reconcileLifecycle,
  tierFromCredits,
} from "./mas-engine";
import { readSnapshotFromDb } from "./seed.server";
import { recordTaskEvent } from "./task-history.server";
import type { CletusSnapshot, MissionStatus } from "./types";

export interface HeartbeatExecutionResult {
  name: string;
  cadence: string;
  ran: boolean;
  ok: boolean;
  durationMs: number;
  repairedCount: number;
  summary: string;
}

export interface HeartbeatSweepResponse {
  executed: string[];
  repairedTotal: number;
  results: HeartbeatExecutionResult[];
  snapshot: CletusSnapshot;
}

let inFlightSweep: Promise<HeartbeatSweepResponse> | null = null;
let lastSweepCompletedAt = 0;

/**
 * Reconcile Task DAG unlocks -> Goal progress/status -> Mission status -> Worker active-task bindings.
 */
export async function reconcileAndPersistLifecycle(
  sql: Sql,
  now = Date.now(),
): Promise<{
  unlockedCount: number;
  goalsUpdated: number;
  missionTransition?: { missionId: string; status: MissionStatus; reason: string };
}> {
  const snap = await readSnapshotFromDb(sql);
  const activeMission =
    snap.missions.find((m) => m.id === snap.vitals.activeMissionId) ??
    snap.missions.find((m) => m.status === "active" || m.status === "planning");

  const plan = reconcileLifecycle({
    mission: activeMission,
    goals: snap.goals,
    tasks: snap.tasks,
    workQueue: snap.workQueue,
  });

  if (plan.tasksToUnlock.length > 0) {
    for (const taskId of plan.tasksToUnlock) {
      const target = snap.tasks.find((t) => t.id === taskId);
      await sql`
        UPDATE cletus_tasks
        SET status = 'assigned', updated_at = ${now}
        WHERE id = ${taskId} AND status = 'pending'
      `;
      if (target && target.status === "pending") {
        await recordTaskEvent(sql, {
          taskId,
          missionId: target.missionId ?? null,
          goalId: target.goalId,
          previousStatus: "pending",
          status: "assigned",
          actor: "DAG-Reconciler",
          note: "All upstream dependencies satisfied",
          at: now,
        });
      }
    }
    await sql`
      INSERT INTO cletus_logs (id, at, level, source, message)
      VALUES (
        ${nid("log")},
        ${now},
        'info',
        'dag',
        ${`unlocked ${plan.tasksToUnlock.length} downstream task(s): ${plan.tasksToUnlock.join(", ")}`}
      )
    `;
  }

  let goalsUpdated = 0;
  for (const gu of plan.goalUpdates) {
    if (!gu.changed) continue;
    await sql`
      UPDATE cletus_goals
      SET progress = ${gu.progress}, status = ${gu.status}
      WHERE id = ${gu.id}
    `;
    goalsUpdated += 1;
  }

  let missionTransition:
    | { missionId: string; status: MissionStatus; reason: string }
    | undefined;

  if (plan.missionUpdate) {
    const mu = plan.missionUpdate;
    await sql`
      UPDATE cletus_missions
      SET status = ${mu.nextStatus}, updated_at = ${now}
      WHERE id = ${mu.missionId}
    `;
    if (mu.nextStatus === "halted") {
      await sql`
        UPDATE cletus_vitals
        SET auto_loop = FALSE
        WHERE id = 1 AND active_mission_id = ${mu.missionId}
      `;
    }
    if (mu.nextStatus === "completed" || mu.nextStatus === "halted") {
      const suffix =
        mu.nextStatus === "completed"
          ? " — No open tasks remain; defaulting idle cycles to Self-Evolution."
          : "";
      await sql`
        INSERT INTO cletus_inbox (id, sender, content, at, status, priority, tools_used)
        VALUES (
          ${nid("inb")},
          'system',
          ${`[MISSION ${mu.missionId}] transitioned → ${mu.nextStatus.toUpperCase()}: ${mu.reason}${suffix}`},
          ${now},
          'done',
          'status',
          '[]'
        )
      `;
    }
    await sql`
      INSERT INTO cletus_logs (id, at, level, source, message)
      VALUES (
        ${nid("log")},
        ${now},
        ${mu.nextStatus === "halted" ? "warn" : "info"},
        'mission',
        ${`mission ${mu.missionId} → ${mu.nextStatus}: ${mu.reason}`}
      )
    `;
    missionTransition = {
      missionId: mu.missionId,
      status: mu.nextStatus,
      reason: mu.reason,
    };
  }

  // Keep worker active task labels accurate against current DAG
  const updatedTasks = snap.tasks.map((t) =>
    plan.tasksToUnlock.includes(t.id) ? { ...t, status: "assigned" as const } : t,
  );
  for (const worker of snap.children) {
    if (worker.status !== "healthy") continue;
    const workerTasks = updatedTasks.filter(
      (t) =>
        t.assignee.toLowerCase() === worker.name.toLowerCase() &&
        (t.status === "running" || t.status === "assigned"),
    );
    const activeTask =
      workerTasks.find((t) => t.status === "running") ?? workerTasks[0];
    if (activeTask) {
      const nextLabel = `[${activeTask.id}] ${activeTask.title}`.slice(0, 120);
      if (worker.task !== nextLabel) {
        await sql`
          UPDATE cletus_workers SET task = ${nextLabel} WHERE id = ${worker.id}
        `;
      }
    } else if (
      worker.role !== "orchestrator" &&
      worker.role !== "treasury" &&
      worker.task?.startsWith("[tsk_")
    ) {
      await sql`
        UPDATE cletus_workers SET task = 'Standby — ready for assignment' WHERE id = ${worker.id}
      `;
    }
  }

  return {
    unlockedCount: plan.tasksToUnlock.length,
    goalsUpdated,
    missionTransition,
  };
}

/**
 * Active Heartbeat Coordinator:
 * Runs due cadences (or all cadences when `forceAll: true`) under a single-flight lock:
 * - mesh_health_probe: verifies DB/tools/local agents & refreshes healthy local beats
 * - cycle_telemetry: reconciles DAG unlocks, Goal progress/status, and Mission completion/budget caps
 * - treasury_audit: checks reserve floor & enforces auto_loop halt in dead/critical tiers
 * - stale_slot_reaper: re-queues/expires stale claimed work, resets stuck running tasks, closes orphan inbox items
 * - entelechy_reflect: recalculates strategic confidence & recommendation from verified outcome metrics
 */
export async function runHeartbeatSweep(
  sql: Sql,
  opts: { forceAll?: boolean; minCooldownMs?: number } = {},
): Promise<HeartbeatSweepResponse> {
  const forceAll = Boolean(opts.forceAll);
  const cooldownMs = opts.minCooldownMs ?? 20_000;
  const now = Date.now();

  if (inFlightSweep) {
    return inFlightSweep;
  }

  if (!forceAll && now - lastSweepCompletedAt < cooldownMs) {
    return {
      executed: [],
      repairedTotal: 0,
      results: [],
      snapshot: await readSnapshotFromDb(sql),
    };
  }

  inFlightSweep = (async (): Promise<HeartbeatSweepResponse> => {
    const sweepStart = Date.now();
    const rows = await sql<{
      name: string;
      cadence: string;
      last_run_at: number;
      ok: boolean;
      summary: string | null;
      consecutive_failures: number | null;
      repaired_count: number | null;
    }>`SELECT name, cadence, last_run_at, ok, summary, consecutive_failures, repaired_count FROM cletus_heartbeats ORDER BY name ASC`;

    const dueNames = new Set(
      rows
        .filter((r) => forceAll || isHeartbeatDue({ cadence: r.cadence, lastRunAt: Number(r.last_run_at) }, sweepStart))
        .map((r) => r.name),
    );

    if (dueNames.size === 0) {
      lastSweepCompletedAt = sweepStart;
      return {
        executed: [],
        repairedTotal: 0,
        results: rows.map((r) => ({
          name: r.name,
          cadence: r.cadence,
          ran: false,
          ok: Boolean(r.ok),
          durationMs: 0,
          repairedCount: Number(r.repaired_count ?? 0),
          summary: r.summary ?? "Within cadence window",
        })),
        snapshot: await readSnapshotFromDb(sql),
      };
    }

    const snap = await readSnapshotFromDb(sql);
    const results: HeartbeatExecutionResult[] = [];
    const executed: string[] = [];
    let repairedTotal = 0;

    for (const row of rows) {
      if (!dueNames.has(row.name)) {
        results.push({
          name: row.name,
          cadence: row.cadence,
          ran: false,
          ok: Boolean(row.ok),
          durationMs: 0,
          repairedCount: Number(row.repaired_count ?? 0),
          summary: row.summary ?? "Within cadence window",
        });
        continue;
      }

      const cadencePerf = performance.now();
      const cadenceNow = Date.now();
      let ok = true;
      let repaired = 0;
      let summary = "";

      try {
        switch (row.name) {
          case "mesh_health_probe": {
            const toolsCountRows = await sql<{ cnt: number }>`
              SELECT COUNT(*)::int AS cnt FROM cletus_tools WHERE enabled = TRUE
            `;
            const enabledTools = Number(toolsCountRows[0]?.cnt ?? 0);
            const healthyLocalIds = snap.children
              .filter((c) => c.kind === "local" && c.status === "healthy")
              .map((c) => c.id);
            for (const id of healthyLocalIds) {
              await sql`UPDATE cletus_workers SET last_beat_at = ${cadenceNow} WHERE id = ${id}`;
            }
            const healthyTotal = snap.children.filter((c) => c.status === "healthy").length;
            const startingTotal = snap.children.filter((c) => c.status === "starting").length;
            const unhealthyTotal = snap.children.filter((c) => c.status === "unhealthy").length;
            ok = healthyTotal > 0 && unhealthyTotal === 0;
            summary = `${healthyTotal}/${snap.children.length} mesh healthy${startingTotal ? `, ${startingTotal} gated` : ""}${unhealthyTotal ? `, ${unhealthyTotal} unhealthy` : ""} · ${enabledTools} tools armed.`;
            break;
          }

          case "cycle_telemetry": {
            const rec = await reconcileAndPersistLifecycle(sql, cadenceNow);
            repaired += rec.unlockedCount + rec.goalsUpdated + (rec.missionTransition ? 1 : 0);
            const latestSnap = await readSnapshotFromDb(sql);
            const doneTasks = latestSnap.tasks.filter((t) => t.status === "completed").length;
            const recentErrors = latestSnap.cycles.slice(0, 10).filter((c) => c.status === "error").length;
            ok = recentErrors <= 2;
            const mNote = rec.missionTransition
              ? ` · ${rec.missionTransition.missionId}→${rec.missionTransition.status}`
              : "";
            summary = `${doneTasks}/${latestSnap.tasks.length} tasks done · ${rec.unlockedCount} unlocked · ${rec.goalsUpdated} goals synced${mNote}`;
            break;
          }

          case "treasury_audit": {
            const tier = tierFromCredits(snap.vitals.creditsCents, snap.vitals.reserveCents);
            if ((tier === "dead" || tier === "critical") && snap.vitals.autoLoop) {
              await sql`UPDATE cletus_vitals SET auto_loop = FALSE WHERE id = 1`;
              repaired += 1;
            }
            ok = tier !== "dead" && tier !== "critical";
            const cr = (snap.vitals.creditsCents / 100).toFixed(2);
            const fl = (snap.vitals.reserveCents / 100).toFixed(2);
            summary = `Credits ${cr} cr (floor ${fl} cr) · tier=${tier} · USDC $${(snap.vitals.usdcCents / 100).toFixed(2)}`;
            break;
          }

          case "stale_slot_reaper": {
            const reap = computeStaleReapActions({
              tasks: snap.tasks,
              workQueue: snap.workQueue,
              inbox: snap.inbox,
              children: snap.children,
              now: cadenceNow,
            });

            for (const wid of reap.workToRetry) {
              await sql`
                UPDATE cletus_work_queue
                SET status = 'pending', error = 'Re-queued by stale_slot_reaper after claim timeout', updated_at = ${cadenceNow}
                WHERE id = ${wid} AND status = 'claimed'
              `;
              repaired += 1;
            }
            for (const wid of reap.workToExpire) {
              await sql`
                UPDATE cletus_work_queue
                SET status = 'expired', error = 'Expired by stale_slot_reaper after 3 failed claim attempts', updated_at = ${cadenceNow}
                WHERE id = ${wid} AND status = 'claimed'
              `;
              repaired += 1;
            }
            for (const tid of reap.tasksToResetAssigned) {
              const target = snap.tasks.find((t) => t.id === tid);
              await sql`
                UPDATE cletus_tasks
                SET status = 'assigned', updated_at = ${cadenceNow}
                WHERE id = ${tid} AND status = 'running'
              `;
              if (target) {
                await recordTaskEvent(sql, {
                  taskId: tid,
                  missionId: target.missionId ?? null,
                  goalId: target.goalId,
                  previousStatus: "running",
                  status: "assigned",
                  actor: "stale_slot_reaper",
                  note: "Reset stuck running task back to assigned",
                  at: cadenceNow,
                });
              }
              repaired += 1;
            }
            for (const mid of reap.inboxToClose) {
              await sql`
                UPDATE cletus_inbox
                SET status = 'done'
                WHERE id = ${mid} AND status IN ('received', 'claimed')
              `;
              repaired += 1;
            }
            for (const cid of reap.workersToFlagUnhealthy) {
              await sql`
                UPDATE cletus_workers
                SET status = 'unhealthy', error_note = 'Worker beat silent > 15m (flagged by stale_slot_reaper)'
                WHERE id = ${cid} AND status = 'healthy'
              `;
              repaired += 1;
            }

            summary =
              repaired > 0
                ? `Reaped ${repaired} stale slot(s) (work retry=${reap.workToRetry.length}, exp=${reap.workToExpire.length}, tasks=${reap.tasksToResetAssigned.length}).`
                : "Clean: zero stuck claims, orphaned tasks, or expired slots.";
            break;
          }

          case "entelechy_reflect": {
            const latest = await readSnapshotFromDb(sql);
            const totalTasks = latest.tasks.length;
            const completedTasks = latest.tasks.filter((t) => t.status === "completed").length;
            const completionRatio = totalTasks > 0 ? completedTasks / totalTasks : 0.7;
            const recentCycles = latest.cycles.slice(0, 10);
            const cycleSuccessRatio =
              recentCycles.length > 0
                ? recentCycles.filter((c) => c.status === "completed").length / recentCycles.length
                : 0.9;
            const nextConfidence = Number(
              Math.min(0.97, Math.max(0.45, 0.45 + completionRatio * 0.3 + cycleSuccessRatio * 0.22)).toFixed(2),
            );
            const openWork = latest.workQueue.filter((w) => w.status === "pending" || w.status === "claimed").length;
            const nextRec =
              latest.vitals.tier === "dead" || latest.vitals.tier === "critical"
                ? "Reserve floor threshold reached: suspend non-essential spawns and prioritize task closure or credit replenishment."
                : latest.evolutionSummary.isIdle
                  ? `Idle operational state: advance Self-Evolution trajectory '${latest.evolutionSummary.nextTrajectoryTitle}' (${latest.evolutionSummary.overallMaturity}/100 avg maturity).`
                  : openWork > 0
                    ? `Execute ${openWork} queued work item(s) and advance ready Task DAG nodes through verification.`
                    : "Advance dependency-ready Task DAG deliverables before transitioning to autonomous Self-Evolution.";

            await sql`
              UPDATE cletus_entelechy
              SET confidence = ${nextConfidence}, recommendation = ${nextRec}
              WHERE id = 1
            `;
            summary = `Confidence ${nextConfidence.toFixed(2)} (${completedTasks}/${totalTasks} tasks verified, ${openWork} open work).`;
            break;
          }

          case "self_evolution_pulse": {
            const latest = await readSnapshotFromDb(sql);
            const gaps = evaluateEvolutionGaps({
              activeDomain: latest.activeDomain,
              tools: latest.tools,
              children: latest.children,
              domainMemories: latest.domainMemories,
              cycles: latest.cycles,
              denials: latest.denials,
            });
            const plan = selectNextEvolutionStep({
              trajectories: latest.evolutionTrajectories,
              activeDomain: latest.activeDomain,
              tools: latest.tools,
              children: latest.children,
              domainMemories: latest.domainMemories,
              cycles: latest.cycles,
              denials: latest.denials,
              now: cadenceNow,
            });

            const forgeTarget =
              gaps.missingDomainCapabilities[0] ??
              gaps.untestedTools[0] ??
              plan.suggestedBlueprint?.name ??
              "domain_capability_benchmark";
            const forgePriority =
              gaps.missingDomainCapabilities.length > 0 || gaps.untestedTools.length > 0 ? 94 : 82;
            const bindTarget = gaps.unboundTools[0] ?? "specialist_tool_binding";
            const meshPriority = gaps.unboundTools.length > 0 ? 88 : 72;
            const resPriority = gaps.recentFaultCount > 0 || gaps.recentDenialCount >= 3 ? 95 : 68;
            const memPriority = gaps.domainMemoryCount < 2 ? 86 : 74;

            await sql`
              UPDATE cletus_evolution_trajectories
              SET target_capability = ${forgeTarget}, priority_weight = ${forgePriority}, updated_at = ${cadenceNow}
              WHERE slug = 'capability_forging'
            `;
            await sql`
              UPDATE cletus_evolution_trajectories
              SET target_capability = ${bindTarget}, priority_weight = ${meshPriority}, updated_at = ${cadenceNow}
              WHERE slug = 'mesh_calibration'
            `;
            await sql`
              UPDATE cletus_evolution_trajectories
              SET priority_weight = ${resPriority}, updated_at = ${cadenceNow}
              WHERE slug = 'resilience_audit'
            `;
            await sql`
              UPDATE cletus_evolution_trajectories
              SET priority_weight = ${memPriority}, updated_at = ${cadenceNow}
              WHERE slug = 'memory_consolidation'
            `;

            if (gaps.untestedTools.length > 0 || gaps.unboundTools.length > 0) {
              repaired += 1;
            }

            summary = `Next: ${plan.trajectory.slug} (${plan.actorName}) · ${gaps.missingDomainCapabilities.length} forgeable, ${gaps.untestedTools.length} untested, ${gaps.unboundTools.length} unbound.`;
            break;
          }

          default: {
            summary = `Cadence ${row.name} verified.`;
          }
        }
      } catch (err) {
        ok = false;
        summary = `Error: ${err instanceof Error ? err.message : String(err)}`;
      }

      const durationMs = Math.max(1, Math.round(performance.now() - cadencePerf));
      const nextFailures = ok ? 0 : Number(row.consecutive_failures ?? 0) + 1;

      await sql`
        UPDATE cletus_heartbeats
        SET last_run_at = ${cadenceNow},
            ok = ${ok},
            summary = ${summary},
            duration_ms = ${durationMs},
            consecutive_failures = ${nextFailures},
            repaired_count = COALESCE(repaired_count, 0) + ${repaired}
        WHERE name = ${row.name}
      `;

      executed.push(row.name);
      repairedTotal += repaired;
      results.push({
        name: row.name,
        cadence: row.cadence,
        ran: true,
        ok,
        durationMs,
        repairedCount: repaired,
        summary,
      });
    }

    if (forceAll || repairedTotal > 0 || results.some((r) => r.ran && !r.ok)) {
      await sql`
        INSERT INTO cletus_logs (id, at, level, source, message)
        VALUES (
          ${nid("log")},
          ${Date.now()},
          ${results.some((r) => r.ran && !r.ok) ? "warn" : "info"},
          'heartbeat',
          ${`sweep executed [${executed.join(", ")}] · repaired ${repairedTotal} slot(s)`}
        )
      `;
    }

    lastSweepCompletedAt = Date.now();
    return {
      executed,
      repairedTotal,
      results,
      snapshot: await readSnapshotFromDb(sql),
    };
  })().finally(() => {
    inFlightSweep = null;
  });

  return inFlightSweep;
}
