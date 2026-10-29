-- Existing issue records remain unchanged and return an empty image list.
ALTER TABLE project_issues ADD COLUMN IF NOT EXISTS image_paths JSONB NOT NULL DEFAULT '[]'::jsonb;
