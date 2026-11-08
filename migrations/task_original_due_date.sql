-- Migration: Add original_due_date and is_extended to tasks table
-- Purpose: Track baseline/initial task due date and extended deadline badge in Status
-- Date: 2026-11-09

ALTER TABLE tasks
ADD COLUMN IF NOT EXISTS original_due_date DATE DEFAULT NULL;

ALTER TABLE tasks
ADD COLUMN IF NOT EXISTS is_extended BOOLEAN DEFAULT FALSE;

-- Initialize baseline due date for existing tasks
UPDATE tasks
SET original_due_date = due_date
WHERE original_due_date IS NULL AND due_date IS NOT NULL;

-- Only mark extended if due date is strictly after original baseline due date
UPDATE tasks
SET is_extended = (due_date > original_due_date)
WHERE original_due_date IS NOT NULL;

COMMENT ON COLUMN tasks.original_due_date IS 'Baseline/initial scheduled due date when the task was created';
COMMENT ON COLUMN tasks.is_extended IS 'Indicates if task due date was extended beyond initial schedule (due_date > original_due_date)';
