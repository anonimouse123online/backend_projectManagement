-- Add modification_reason to tasks table
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS modification_reason TEXT;
