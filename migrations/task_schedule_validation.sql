-- Additive scheduling fields. Existing rows remain valid with NULL optional values.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS start_date DATE;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS estimated_duration_days INTEGER;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tasks_estimated_duration_days_check'
    AND conrelid = 'tasks'::regclass) THEN
    ALTER TABLE tasks ADD CONSTRAINT tasks_estimated_duration_days_check
      CHECK (estimated_duration_days IS NULL OR estimated_duration_days BETWEEN 1 AND 3650);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS task_dependencies (
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  predecessor_task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  PRIMARY KEY (task_id, predecessor_task_id),
  CHECK (task_id <> predecessor_task_id)
);
CREATE INDEX IF NOT EXISTS idx_task_dependencies_predecessor ON task_dependencies(predecessor_task_id);

CREATE TABLE IF NOT EXISTS project_holidays (
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  holiday_date DATE NOT NULL,
  name VARCHAR(255),
  PRIMARY KEY (project_id, holiday_date)
);
