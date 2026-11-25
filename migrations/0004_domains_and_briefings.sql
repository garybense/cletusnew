-- Multi-Domain Operations, Semantic Knowledge Memory & Executive Audio Briefings

ALTER TABLE cletus_vitals ADD COLUMN IF NOT EXISTS active_domain TEXT NOT NULL DEFAULT 'mas_rnd';

CREATE TABLE IF NOT EXISTS cletus_domain_memories (
  id TEXT PRIMARY KEY,
  domain_id TEXT NOT NULL,
  source_type TEXT NOT NULL,
  title TEXT NOT NULL,
  source_url TEXT,
  summary TEXT NOT NULL,
  raw_excerpt TEXT,
  embedding_json TEXT,
  tags_json TEXT NOT NULL DEFAULT '[]',
  created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cletus_domain_memories_domain_created
  ON cletus_domain_memories (domain_id, created_at DESC);

CREATE TABLE IF NOT EXISTS cletus_audio_briefings (
  id TEXT PRIMARY KEY,
  domain_id TEXT NOT NULL,
  title TEXT NOT NULL,
  voice_name TEXT NOT NULL,
  script TEXT NOT NULL,
  audio_data_url TEXT NOT NULL,
  mime_type TEXT NOT NULL DEFAULT 'audio/wav',
  created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cletus_audio_briefings_domain_created
  ON cletus_audio_briefings (domain_id, created_at DESC);
