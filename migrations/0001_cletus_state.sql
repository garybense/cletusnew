CREATE TABLE IF NOT EXISTS cletus_vitals (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  state TEXT NOT NULL,
  model TEXT NOT NULL,
  credits_cents INTEGER NOT NULL,
  usdc_cents INTEGER NOT NULL,
  reserve_cents INTEGER NOT NULL,
  turns INTEGER NOT NULL,
  started_at BIGINT NOT NULL,
  sleep_until BIGINT,
  creator TEXT NOT NULL,
  sigil TEXT NOT NULL,
  paused BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS cletus_goals (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  detail TEXT NOT NULL,
  status TEXT NOT NULL,
  progress INTEGER NOT NULL,
  expected_revenue_cents INTEGER NOT NULL DEFAULT 0,
  actual_revenue_cents INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS cletus_tasks (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT,
  status TEXT NOT NULL,
  assignee TEXT NOT NULL,
  role TEXT NOT NULL,
  depends_on TEXT NOT NULL DEFAULT '[]',
  result TEXT,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS cletus_work_queue (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  payload TEXT NOT NULL,
  acceptance_predicate TEXT NOT NULL,
  priority INTEGER NOT NULL,
  spend_bearing BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  result TEXT,
  error TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS cletus_inbox (
  id TEXT PRIMARY KEY,
  sender TEXT NOT NULL,
  content TEXT NOT NULL,
  at BIGINT NOT NULL,
  status TEXT NOT NULL,
  priority TEXT NOT NULL,
  tools_used TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS cletus_workers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  role TEXT NOT NULL,
  last_beat_at BIGINT NOT NULL,
  task TEXT,
  latency_ms INTEGER,
  funded_cents INTEGER,
  live BOOLEAN NOT NULL DEFAULT TRUE,
  error_note TEXT
);

CREATE TABLE IF NOT EXISTS cletus_thoughts (
  id TEXT PRIMARY KEY,
  at BIGINT NOT NULL,
  thinking TEXT NOT NULL,
  speech TEXT,
  tools TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS cletus_logs (
  id TEXT PRIMARY KEY,
  at BIGINT NOT NULL,
  level TEXT NOT NULL,
  source TEXT NOT NULL,
  message TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cletus_spend_events (
  id TEXT PRIMARY KEY,
  at BIGINT NOT NULL,
  model TEXT NOT NULL,
  tool TEXT NOT NULL,
  category TEXT NOT NULL,
  cents INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS cletus_denials (
  id TEXT PRIMARY KEY,
  at BIGINT NOT NULL,
  tool TEXT NOT NULL,
  rule TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cletus_skills (
  name TEXT PRIMARY KEY,
  summary TEXT NOT NULL,
  enabled BOOLEAN NOT NULL,
  auto_activate BOOLEAN NOT NULL
);

CREATE TABLE IF NOT EXISTS cletus_heartbeats (
  name TEXT PRIMARY KEY,
  cadence TEXT NOT NULL,
  last_run_at BIGINT NOT NULL,
  ok BOOLEAN NOT NULL
);

CREATE TABLE IF NOT EXISTS cletus_entelechy (
  id INTEGER PRIMARY KEY,
  mission TEXT NOT NULL,
  risk_posture TEXT NOT NULL,
  confidence DOUBLE PRECISION NOT NULL,
  priorities TEXT NOT NULL,
  avoid TEXT NOT NULL,
  recommendation TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cletus_peers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  handle TEXT NOT NULL,
  status TEXT NOT NULL,
  last_at BIGINT NOT NULL,
  note TEXT NOT NULL,
  claimed BOOLEAN NOT NULL,
  posts INTEGER NOT NULL,
  followers INTEGER,
  following INTEGER,
  karma INTEGER
);
