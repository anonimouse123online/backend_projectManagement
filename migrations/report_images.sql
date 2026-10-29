-- These two tables are already defined in setup_new_db.sql and used by the
-- existing task upload/AI flow, but are missing from some installed databases.
CREATE TABLE IF NOT EXISTS task_images (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID REFERENCES tasks(id) ON DELETE CASCADE,
  image_paths JSONB NOT NULL DEFAULT '[]',
  upload_date DATE NOT NULL,
  status VARCHAR(50) DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE (task_id, upload_date)
);

CREATE TABLE IF NOT EXISTS reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID REFERENCES tasks(id) ON DELETE CASCADE,
  report_date DATE NOT NULL,
  observations JSONB,
  report_text TEXT,
  status VARCHAR(50) DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE (task_id, report_date)
);

-- NULL distinguishes legacy AI reports from new reports with an exact snapshot.
ALTER TABLE reports ADD COLUMN IF NOT EXISTS image_paths JSONB;
ALTER TABLE project_reports ADD COLUMN IF NOT EXISTS image_paths JSONB NOT NULL DEFAULT '[]';
