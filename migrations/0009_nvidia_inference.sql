-- Migrate existing runtime configuration, tools, workers, and historical records to NVIDIA NIM inference

ALTER TABLE cletus_vitals ALTER COLUMN model SET DEFAULT 'nvidia/llama-3.3-nemotron-super-49b-v1';
ALTER TABLE cletus_workers ALTER COLUMN model SET DEFAULT 'nvidia/llama-3.3-nemotron-super-49b-v1';

UPDATE cletus_vitals
SET model = 'nvidia/llama-3.3-nemotron-super-49b-v1'
WHERE model LIKE 'gemini%';

UPDATE cletus_workers
SET model = CASE
  WHEN model = 'gemini-3.1-flash-lite' THEN 'nvidia/llama-3.1-nemotron-nano-8b-v1'
  ELSE 'nvidia/llama-3.3-nemotron-super-49b-v1'
END
WHERE model LIKE 'gemini%' OR model IS NULL;

UPDATE cletus_tools
SET kind = 'nvidia_analyzer'
WHERE kind = 'gemini_analyzer';

UPDATE cletus_tools
SET description = 'Self-evolution primitive: create or update an executable custom tool (http_json or nvidia_analyzer) in cletus_tools.',
    input_schema = '{"name":"string","kind":"http_json | nvidia_analyzer","description":"string","configJson":"object"}'
WHERE name = 'synthesize_tool';

UPDATE cletus_tools
SET description = 'Execute live federated web search grounding via Wikipedia + DuckDuckGo + NVIDIA NIM synthesis.',
    config_json = '{"tool":"webSearch","liveExternal":true}'
WHERE name = 'web_grounding_research';

UPDATE cletus_tools
SET description = 'Execute live OpenStreetMap Nominatim geospatial lookup and NVIDIA NIM synthesis for venues, addresses, and coordinates.',
    config_json = '{"tool":"osmNominatim","liveExternal":true}'
WHERE name = 'maps_grounding_research';

UPDATE cletus_tools
SET description = 'Ingest and synthesize live web documents using SSRF-validated HTTPS fetch and NVIDIA NIM synthesis.',
    config_json = '{"tool":"urlContext","liveExternal":true,"maxUrls":10}'
WHERE name = 'analyze_url_context';

UPDATE cletus_skills
SET summary = 'Allow Execution-Engineer & Orchestrator to register new HTTPS/NVIDIA NIM analyzer tools.'
WHERE name = 'dynamic-tool-synthesis';

UPDATE cletus_tasks
SET detail = 'Register verified HTTPS JSON / NVIDIA analyzer capability for specialist agents.'
WHERE id = 'tsk_synth_tool' AND detail LIKE '%Gemini%';

UPDATE cletus_evolution_trajectories
SET last_outcome = 'Ready to distill idle findings via nvidia/nv-embedqa-e5-v5 into domain memory.'
WHERE slug = 'memory_consolidation' AND last_outcome LIKE '%gemini-embedding-2%';

UPDATE cletus_spend_events
SET model = CASE
  WHEN model = 'gemini-3.1-flash-lite' THEN 'nvidia/llama-3.1-nemotron-nano-8b-v1'
  ELSE 'nvidia/llama-3.3-nemotron-super-49b-v1'
END
WHERE model LIKE 'gemini%';

UPDATE cletus_chat_messages
SET model = CASE
  WHEN model = 'gemini-3.1-flash-lite' THEN 'nvidia/llama-3.1-nemotron-nano-8b-v1'
  WHEN model = 'gemini-4-carbon' THEN 'deepseek-ai/deepseek-r1'
  WHEN model = 'gemini-4-neon' THEN 'meta/llama-3.3-70b-instruct'
  ELSE 'nvidia/llama-3.3-nemotron-super-49b-v1'
END
WHERE model LIKE 'gemini%';
