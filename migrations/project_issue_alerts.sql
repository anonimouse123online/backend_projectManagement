-- Reuse the existing project issue records. Keep code/priority for older clients.
ALTER TABLE project_issues ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES projects(id) ON DELETE CASCADE;
ALTER TABLE project_issues ADD COLUMN IF NOT EXISTS severity VARCHAR(20);

UPDATE project_issues i SET project_id = p.id
FROM projects p WHERE p.code = i.project_code AND i.project_id IS NULL;
UPDATE project_issues SET
  status = regexp_replace(lower(trim(status)), '[ -]+', '_', 'g'),
  severity = COALESCE(severity, lower(trim(priority))),
  resolved_at = CASE
    WHEN lower(trim(status)) = 'resolved' THEN COALESCE(resolved_at, updated_at, created_at, NOW())
    ELSE NULL END
WHERE status <> regexp_replace(lower(trim(status)), '[ -]+', '_', 'g')
  OR severity IS NULL
  OR (lower(trim(status)) = 'resolved' AND resolved_at IS NULL)
  OR (lower(trim(status)) <> 'resolved' AND resolved_at IS NOT NULL);

ALTER TABLE project_issues ALTER COLUMN project_id SET NOT NULL;
ALTER TABLE project_issues ALTER COLUMN severity SET NOT NULL;
ALTER TABLE project_issues ALTER COLUMN status SET DEFAULT 'open';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'project_issues'::regclass AND conname = 'project_issues_status_check') THEN
    ALTER TABLE project_issues ADD CONSTRAINT project_issues_status_check CHECK (status IN ('open', 'in_progress', 'resolved'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'project_issues'::regclass AND conname = 'project_issues_severity_check') THEN
    ALTER TABLE project_issues ADD CONSTRAINT project_issues_severity_check CHECK (severity IN ('low', 'medium', 'high', 'critical'));
  END IF;
END $$;

-- Legacy code-based writes must contribute to the same aggregate as new writes.
CREATE OR REPLACE FUNCTION sync_project_issue_fields() RETURNS trigger AS $$
DECLARE linked_id UUID; linked_code VARCHAR(50);
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.project_code IS DISTINCT FROM OLD.project_code AND NEW.project_id IS NOT DISTINCT FROM OLD.project_id THEN
      NEW.project_id := NULL;
    ELSIF NEW.project_id IS DISTINCT FROM OLD.project_id AND NEW.project_code IS NOT DISTINCT FROM OLD.project_code THEN
      NEW.project_code := NULL;
    END IF;
    IF NEW.priority IS DISTINCT FROM OLD.priority AND NEW.severity IS NOT DISTINCT FROM OLD.severity THEN
      NEW.severity := lower(trim(NEW.priority));
    END IF;
    NEW.updated_at := NOW();
  END IF;
  IF NEW.project_id IS NULL THEN
    SELECT id, code INTO linked_id, linked_code FROM projects WHERE code = NEW.project_code;
  ELSE
    SELECT id, code INTO linked_id, linked_code FROM projects WHERE id = NEW.project_id;
  END IF;
  IF linked_id IS NULL OR (NEW.project_code IS NOT NULL AND NEW.project_code <> linked_code) THEN
    RAISE EXCEPTION 'Invalid issue project association' USING ERRCODE = '23503';
  END IF;
  NEW.project_id := linked_id;
  NEW.project_code := linked_code;
  NEW.severity := lower(trim(COALESCE(NEW.severity, NEW.priority, 'medium')));
  NEW.priority := initcap(NEW.severity);
  NEW.status := regexp_replace(lower(trim(NEW.status)), '[ -]+', '_', 'g');
  IF NEW.status = 'resolved' THEN
    NEW.resolved_at := COALESCE(NEW.resolved_at, NOW());
  ELSE
    NEW.resolved_at := NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS project_issue_fields_sync ON project_issues;
CREATE TRIGGER project_issue_fields_sync BEFORE INSERT OR UPDATE ON project_issues
FOR EACH ROW EXECUTE FUNCTION sync_project_issue_fields();

CREATE INDEX IF NOT EXISTS idx_project_issues_active ON project_issues(project_id)
WHERE status IN ('open', 'in_progress');
