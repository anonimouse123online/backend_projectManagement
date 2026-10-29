-- Migration: Add original_end_date to projects table
-- Purpose: Track baseline/initial project completion date for schedule extensions
-- Date: 2026-10-29

ALTER TABLE projects
ADD COLUMN IF NOT EXISTS original_end_date DATE DEFAULT NULL;

-- Initialize baseline end date for existing projects
UPDATE projects
SET original_end_date = end_date
WHERE original_end_date IS NULL AND end_date IS NOT NULL;

COMMENT ON COLUMN projects.original_end_date IS 'Baseline/initial scheduled end date when the project was created';
