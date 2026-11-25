-- Gemini Multimodal Studio & Conversational Persistence

CREATE TABLE IF NOT EXISTS cletus_chat_messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  role TEXT NOT NULL,
  model TEXT NOT NULL,
  grounding_mode TEXT NOT NULL DEFAULT 'none',
  system_role TEXT NOT NULL DEFAULT 'orchestrator',
  content TEXT NOT NULL,
  web_sources_json TEXT NOT NULL DEFAULT '[]',
  maps_places_json TEXT NOT NULL DEFAULT '[]',
  created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cletus_chat_thread_created
  ON cletus_chat_messages (thread_id, created_at ASC);

CREATE TABLE IF NOT EXISTS cletus_video_generations (
  id TEXT PRIMARY KEY,
  prompt TEXT NOT NULL,
  aspect_ratio TEXT NOT NULL DEFAULT '16:9',
  duration TEXT NOT NULL DEFAULT '8s',
  status TEXT NOT NULL,
  interaction_id TEXT,
  video_data_url TEXT,
  mime_type TEXT NOT NULL DEFAULT 'video/mp4',
  error TEXT,
  created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cletus_video_created
  ON cletus_video_generations (created_at DESC);
