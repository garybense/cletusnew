-- Self-Evolution Growth Trajectories, Verified Evolution Ledger & Cycle Mode Tracking

ALTER TABLE cletus_cycles
  ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'mission';

CREATE TABLE IF NOT EXISTS cletus_evolution_trajectories (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  horizon TEXT NOT NULL DEFAULT 'explore',
  maturity_score INTEGER NOT NULL DEFAULT 15,
  target_capability TEXT NOT NULL,
  priority_weight INTEGER NOT NULL DEFAULT 50,
  cycles_completed INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  last_evolved_at BIGINT,
  last_outcome TEXT,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS cletus_evolution_events (
  id TEXT PRIMARY KEY,
  trajectory_id TEXT NOT NULL,
  trajectory_slug TEXT NOT NULL,
  domain_id TEXT NOT NULL,
  cycle_id TEXT,
  agent_name TEXT NOT NULL,
  action_kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  capability_gained TEXT,
  artifact_ref TEXT,
  maturity_delta INTEGER NOT NULL DEFAULT 0,
  verified BOOLEAN NOT NULL DEFAULT TRUE,
  created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cletus_evolution_events_created
  ON cletus_evolution_events (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_cletus_evolution_events_slug_created
  ON cletus_evolution_events (trajectory_slug, created_at DESC);

-- Register the 6th active Heartbeat Cadence for autonomous Self-Evolution & Gap Analysis
INSERT INTO cletus_heartbeats (
  name, cadence, last_run_at, ok, summary, duration_ms, consecutive_failures, repaired_count
) VALUES (
  'self_evolution_pulse',
  'every 15m',
  (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT - 960000,
  TRUE,
  'Trajectories calibrated; awaiting idle cycle or operator evolution pulse.',
  2,
  0,
  0
) ON CONFLICT (name) DO NOTHING;
