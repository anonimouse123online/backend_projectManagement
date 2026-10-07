# SitePulse DB script — 10/6/2026

Date: **October 6, 2026**.

This is the complete SQL handoff for the issue-resolution and multiple-task-phase
changes. It includes the existing issue-alert prerequisite so a teammate can apply
the migrations in the correct order.

The complete pasteable script is below. The same SQL is available as
[2026-10-06-sitepulse-db-script.sql](2026-10-06-sitepulse-db-script.sql).

## How to apply

1. Connect pgAdmin Query Tool or your PostgreSQL SQL editor to your existing
   SitePulse database. The base tables must already exist in `public`, including
   `projects`, `project_issues`, `users`, and `tasks`, with the UUID IDs used by
   this backend. This script upgrades the existing schema.
2. Run the first connection `SELECT` by itself and confirm the database is yours.
3. Paste and execute the complete block from `BEGIN;` through `COMMIT;`.
   The transaction uses the `public` schema.
4. If any statement fails, run `ROLLBACK;` in the same connection, resolve the
   reported problem, and rerun the complete transaction. Unknown historical task
   phase names intentionally stop the migration for review.
5. Run the read-only verification queries after `COMMIT;`, then restart the
   updated backend.

Run this on a database with the existing SitePulse schema or these same migrations
already applied. `CREATE TABLE IF NOT EXISTS` does not correct a table created
with a different definition. If you already pasted the earlier alternative script,
compare its tables first: `issue_resolutions.id` must be UUID, both foreign keys
must exist, remarks must be required and nonblank, and every resolution step must
be a nonblank string. This combined script does not convert that alternative
BIGSERIAL table or repair its missing constraints.

## Included changes

| Order | Migration | Purpose |
| --- | --- | --- |
| 1 | `migrations/project_issue_alerts.sql` | Existing prerequisite: issue project IDs, severity/status normalization, synchronization trigger, active-issue index |
| 2 | `migrations/issue_resolutions.sql` | Resolution feedback with UUID IDs, issue/resolver foreign keys, required text, validated JSONB steps, timestamps, lookup indexes |
| 3 | `migrations/task_phases.sql` | Multiple categories per task, legacy mapping/backfill, compatibility check, synchronization trigger, category index |

The migration bodies below are copied from those repository files. The handoff
adds a transaction, an explicit schema, connection information, and read-only
verification queries. Existing issue records and legacy task phase values are retained.
Rerunning the task-phase backfill preserves categories already selected.

The CREATE TASK error `428C9` was caused by explicit writes to generated
`resources.status`. Its fix is in the updated backend, which omits that column
when PostgreSQL generates it. **No alteration to `tasks.status` or
`resources.status` is needed.** Deploy the backend changes along with these
migrations. The issue workflow reuses the existing notifications schema
(`target_user_id` and support for `individual` audience); we added no notification
constraint migration.

## Complete SQL to paste

```sql
-- SitePulse database changes: October 6, 2026 (10/6/2026).
-- Run on an existing SitePulse database with its base tables in public.
-- Confirm this connection before running BEGIN through COMMIT.
SELECT current_database(), current_schema(), current_setting('search_path');

BEGIN;
SET LOCAL search_path TO public;

-- ============================================================
-- Source: migrations/project_issue_alerts.sql
-- ============================================================
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

-- ============================================================
-- Source: migrations/issue_resolutions.sql
-- ============================================================
-- Run after project_issue_alerts.sql. Existing issues and legacy notes are retained.
CREATE OR REPLACE FUNCTION valid_issue_resolution_steps(steps JSONB) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN jsonb_typeof(steps) = 'array' THEN
    jsonb_array_length(steps) > 0 AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(steps) entry
      WHERE jsonb_typeof(entry) <> 'string' OR (entry #>> '{}') !~ '[^[:space:]]'
    ) ELSE FALSE END;
$$;

CREATE TABLE IF NOT EXISTS issue_resolutions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_id UUID NOT NULL REFERENCES project_issues(id) ON DELETE CASCADE,
  resolution_summary TEXT NOT NULL CHECK (resolution_summary ~ '[^[:space:]]'),
  resolution_steps JSONB NOT NULL CHECK (valid_issue_resolution_steps(resolution_steps)),
  final_remarks TEXT NOT NULL CHECK (final_remarks ~ '[^[:space:]]'),
  resolved_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  resolved_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Multiple records preserve earlier resolutions when an issue is reopened and resolved again.
CREATE INDEX IF NOT EXISTS idx_issue_resolutions_issue_latest
  ON issue_resolutions(issue_id, resolved_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_issue_resolutions_resolved_by ON issue_resolutions(resolved_by);

-- ============================================================
-- Source: migrations/task_phases.sql
-- ============================================================
-- Inspected tasks.id is UUID. Keep tasks.phase and all existing task rows intact.
CREATE OR REPLACE FUNCTION normalize_task_phase(value TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE trim(value)
    WHEN 'Foundation' THEN 'Site Development'
    WHEN 'Phase 1 - Foundation' THEN 'Site Development'
    WHEN 'Phase 2 - Structural' THEN 'Structural'
    WHEN 'Phase 3 - Electrical & Utilities' THEN 'Electrical & Utilities'
    WHEN 'Phase 4 - Plumbing & MEP' THEN 'Plumbing & MEP'
    WHEN 'Finishing' THEN 'Architectural'
    WHEN 'Phase 5 - Finishing' THEN 'Architectural'
    ELSE CASE WHEN trim(value) IN (
      'Site Development', 'Structural', 'Electrical & Utilities', 'Plumbing & MEP',
      'Architectural', 'Construction Phase', 'Turnover Phase'
    ) THEN trim(value) ELSE NULL END
  END;
$$;

CREATE TABLE IF NOT EXISTS task_phases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  phase VARCHAR(100) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT task_phases_phase_check CHECK (phase IN (
    'Site Development', 'Structural', 'Electrical & Utilities', 'Plumbing & MEP',
    'Architectural', 'Construction Phase', 'Turnover Phase'
  )),
  CONSTRAINT task_phases_task_phase_key UNIQUE (task_id, phase)
);
-- The unique (task_id, phase) index also supports lookups by task_id.
CREATE INDEX IF NOT EXISTS idx_task_phases_phase_task ON task_phases(phase, task_id);

-- Unknown historical values must be reviewed, never guessed or silently discarded.
DO $$ DECLARE unsupported TEXT;
BEGIN
  SELECT string_agg(DISTINCT phase, ', ' ORDER BY phase) INTO unsupported
  FROM tasks WHERE phase IS NOT NULL AND trim(phase) <> '' AND normalize_task_phase(phase) IS NULL;
  IF unsupported IS NOT NULL THEN
    RAISE EXCEPTION 'Unsupported historical task phases: %. Review mappings before migrating.', unsupported;
  END IF;
END $$;

INSERT INTO task_phases (task_id, phase)
SELECT t.id, normalize_task_phase(t.phase) FROM tasks t
WHERE normalize_task_phase(t.phase) IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM task_phases tp WHERE tp.task_id = t.id)
ON CONFLICT (task_id, phase) DO NOTHING;

-- Preserve the inspected legacy constraint expression and additionally permit the seven
-- canonical compatibility values. The comment prevents expression nesting on reruns.
DO $$ DECLARE old_check TEXT; migration_comment TEXT;
BEGIN
  SELECT pg_get_expr(conbin, conrelid), obj_description(oid, 'pg_constraint')
  INTO old_check, migration_comment FROM pg_constraint
  WHERE conrelid = 'tasks'::regclass AND conname = 'tasks_phase_check' AND contype = 'c';
  IF migration_comment = 'SitePulse task_phases compatibility v1' THEN RETURN; END IF;
  IF old_check IS NULL THEN
    old_check := $check$(phase IS NULL OR trim(phase) = '' OR phase IN ('Foundation', 'Finishing', 'Phase 1 - Foundation',
      'Phase 2 - Structural', 'Phase 3 - Electrical & Utilities', 'Phase 4 - Plumbing & MEP',
      'Phase 5 - Finishing'))$check$;
  END IF;
  ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_phase_check;
  EXECUTE format($check$ALTER TABLE tasks ADD CONSTRAINT tasks_phase_check CHECK ((%s) OR phase IN (
    'Site Development', 'Structural', 'Electrical & Utilities', 'Plumbing & MEP',
    'Architectural', 'Construction Phase', 'Turnover Phase'))$check$, old_check);
  COMMENT ON CONSTRAINT tasks_phase_check ON tasks IS 'SitePulse task_phases compatibility v1';
END $$;

-- Old backend deployments and scalar SQL writers keep contributing category relations.
-- Scalar writes add the mapped category without deleting any additional selections.
CREATE OR REPLACE FUNCTION sync_legacy_task_phase() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE mapped TEXT;
BEGIN
  mapped := normalize_task_phase(NEW.phase);
  IF mapped IS NOT NULL THEN
    INSERT INTO task_phases (task_id, phase) VALUES (NEW.id, mapped)
    ON CONFLICT (task_id, phase) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS task_phase_legacy_sync ON tasks;
CREATE TRIGGER task_phase_legacy_sync AFTER INSERT OR UPDATE OF phase ON tasks
FOR EACH ROW EXECUTE FUNCTION sync_legacy_task_phase();

COMMENT ON COLUMN tasks.phase IS 'Deprecated compatibility value; use task_phases for all selected categories.';

COMMIT;

-- Read-only verification after a successful COMMIT.
SELECT table_name, column_name, data_type, is_nullable, column_default,
       is_generated, generation_expression
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN ('issue_resolutions', 'task_phases')
ORDER BY table_name, ordinal_position;

SELECT c.relname AS table_name, con.conname AS constraint_name,
       pg_get_constraintdef(con.oid) AS definition
FROM pg_constraint con
JOIN pg_class c ON c.oid = con.conrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('issue_resolutions', 'task_phases', 'tasks')
ORDER BY c.relname, con.conname;

SELECT event_object_table, trigger_name, action_timing, event_manipulation
FROM information_schema.triggers
WHERE event_object_schema = 'public'
  AND trigger_name IN ('project_issue_fields_sync', 'task_phase_legacy_sync')
ORDER BY event_object_table, trigger_name, event_manipulation;

-- Inspect status definitions; these columns are not altered by this script.
SELECT table_name, column_name, data_type, column_default,
       is_generated, generation_expression
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN ('tasks', 'resources')
  AND column_name = 'status'
ORDER BY table_name;
```

For API behavior and the database error diagnosis, see
[Issue resolution feedback](issue-resolution-feedback.md),
[Task phase categories](task-phase-categories.md), and
[CREATE TASK diagnostics](create-task-diagnostics.md).
