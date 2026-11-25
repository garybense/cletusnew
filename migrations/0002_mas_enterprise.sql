-- Enterprise Multi-Agent System (MAS) schema expansion

ALTER TABLE cletus_vitals ADD COLUMN IF NOT EXISTS auto_loop BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE cletus_vitals ADD COLUMN IF NOT EXISTS active_mission_id TEXT;
ALTER TABLE cletus_vitals ADD COLUMN IF NOT EXISTS credits_synthetic_override BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE cletus_workers ADD COLUMN IF NOT EXISTS system_prompt TEXT;
ALTER TABLE cletus_workers ADD COLUMN IF NOT EXISTS model TEXT NOT NULL DEFAULT 'gemini-4-hydrogen';
ALTER TABLE cletus_workers ADD COLUMN IF NOT EXISTS capabilities TEXT NOT NULL DEFAULT '[]';
ALTER TABLE cletus_workers ADD COLUMN IF NOT EXISTS autonomy_level TEXT NOT NULL DEFAULT 'autonomous';
ALTER TABLE cletus_workers ADD COLUMN IF NOT EXISTS cycle_count INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS cletus_missions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  objective TEXT NOT NULL,
  status TEXT NOT NULL,
  orchestrator TEXT NOT NULL,
  plan_summary TEXT,
  success_criteria TEXT NOT NULL,
  cycle_count INTEGER NOT NULL DEFAULT 0,
  max_cycles INTEGER NOT NULL DEFAULT 12,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS cletus_cycles (
  id TEXT PRIMARY KEY,
  mission_id TEXT,
  turn_number INTEGER NOT NULL,
  agent_name TEXT NOT NULL,
  agent_role TEXT NOT NULL,
  phase_perceive TEXT NOT NULL,
  phase_reason TEXT NOT NULL,
  phase_act TEXT NOT NULL,
  phase_observe TEXT NOT NULL,
  tools_used TEXT NOT NULL DEFAULT '[]',
  handoff_to TEXT,
  duration_ms INTEGER NOT NULL,
  cost_cents INTEGER NOT NULL DEFAULT 0,
  tier TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS cletus_tools (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL,
  kind TEXT NOT NULL,
  description TEXT NOT NULL,
  input_schema TEXT NOT NULL,
  config_json TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_by TEXT NOT NULL,
  usage_count INTEGER NOT NULL DEFAULT 0,
  last_used_at BIGINT,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS cletus_agent_messages (
  id TEXT PRIMARY KEY,
  mission_id TEXT,
  task_id TEXT,
  from_agent TEXT NOT NULL,
  to_agent TEXT NOT NULL,
  message_type TEXT NOT NULL,
  subject TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at BIGINT NOT NULL
);

-- Normalize any legacy non-enterprise rows in persistent DBs
DELETE FROM cletus_workers WHERE id IN ('ch_junebug', 'ch_hayseed', 'ch_local', 'oc_super', 'oc_ent1');
DELETE FROM cletus_goals WHERE id = 'gol_junebug';
DELETE FROM cletus_tasks WHERE id IN ('tsk_scout', 'tsk_draft', 'tsk_hayseed', 'tsk_invoice', 'tsk_reap', 'tsk_guard') AND assignee IN ('Junebug', 'Hayseed', 'local-infer-1');
DELETE FROM cletus_work_queue WHERE id = 'wrk_hayseed_verify';
UPDATE cletus_vitals SET sigil = 'CLETUS-CORE-01' WHERE sigil = 'CLETUS-01';
