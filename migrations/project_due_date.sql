-- Project due-date support uses the existing canonical project date fields.
-- IF NOT EXISTS keeps existing project dates intact on current installations.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS start_date DATE;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS end_date DATE;

-- The due-date endpoint checks task deadlines against a proposed project date.
CREATE INDEX IF NOT EXISTS idx_tasks_project_due_date
  ON tasks (project_id, due_date)
  WHERE due_date IS NOT NULL;
