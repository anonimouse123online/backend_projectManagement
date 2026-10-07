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
