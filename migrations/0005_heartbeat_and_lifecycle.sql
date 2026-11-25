-- Active Heartbeat Daemon & Mission/Goal/Task/Work Lifecycle Hardening

ALTER TABLE cletus_goals ADD COLUMN IF NOT EXISTS mission_id TEXT;
ALTER TABLE cletus_tasks ADD COLUMN IF NOT EXISTS mission_id TEXT;
ALTER TABLE cletus_tasks ADD COLUMN IF NOT EXISTS updated_at BIGINT;
ALTER TABLE cletus_work_queue ADD COLUMN IF NOT EXISTS mission_id TEXT;

ALTER TABLE cletus_heartbeats ADD COLUMN IF NOT EXISTS summary TEXT;
ALTER TABLE cletus_heartbeats ADD COLUMN IF NOT EXISTS duration_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cletus_heartbeats ADD COLUMN IF NOT EXISTS consecutive_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cletus_heartbeats ADD COLUMN IF NOT EXISTS repaired_count INTEGER NOT NULL DEFAULT 0;

-- Backfill mission_id on existing rows if unset
UPDATE cletus_goals
SET mission_id = COALESCE(
  (SELECT active_mission_id FROM cletus_vitals WHERE id = 1),
  (SELECT id FROM cletus_missions ORDER BY updated_at DESC LIMIT 1)
)
WHERE mission_id IS NULL;

UPDATE cletus_tasks
SET mission_id = COALESCE(
  (SELECT g.mission_id FROM cletus_goals g WHERE g.id = cletus_tasks.goal_id),
  (SELECT active_mission_id FROM cletus_vitals WHERE id = 1)
)
WHERE mission_id IS NULL;

UPDATE cletus_tasks
SET updated_at = created_at
WHERE updated_at IS NULL;

UPDATE cletus_work_queue
SET mission_id = COALESCE(
  (SELECT active_mission_id FROM cletus_vitals WHERE id = 1),
  (SELECT id FROM cletus_missions ORDER BY updated_at DESC LIMIT 1)
)
WHERE mission_id IS NULL;
