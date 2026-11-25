-- Add priority field (low, medium, high) to cletus_tasks
ALTER TABLE cletus_tasks
  ADD COLUMN IF NOT EXISTS priority TEXT NOT NULL DEFAULT 'medium';
