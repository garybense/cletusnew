CREATE TABLE IF NOT EXISTS cletus_task_events (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  mission_id TEXT,
  goal_id TEXT,
  previous_status TEXT,
  status TEXT NOT NULL,
  actor TEXT NOT NULL,
  note TEXT,
  created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cletus_task_events_created_at
  ON cletus_task_events (created_at ASC);

CREATE INDEX IF NOT EXISTS idx_cletus_task_events_task_id
  ON cletus_task_events (task_id, created_at ASC);
