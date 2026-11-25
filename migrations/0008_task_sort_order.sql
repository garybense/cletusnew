-- Add manual sort_order sequence column to cletus_tasks
ALTER TABLE cletus_tasks
  ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;

WITH ranked AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY created_at ASC, id ASC) - 1 AS rn
  FROM cletus_tasks
)
UPDATE cletus_tasks
SET sort_order = ranked.rn
FROM ranked
WHERE cletus_tasks.id = ranked.id;
