-- Reuse tasks.status; subtasks remain independent JSONB objects inside tasks.subtasks.
-- Preserve every existing status-only CHECK expression and add only the new work states.
DO $$
DECLARE status_check RECORD; status_column SMALLINT;
BEGIN
  SELECT attnum INTO status_column FROM pg_attribute
  WHERE attrelid = 'tasks'::regclass AND attname = 'status' AND NOT attisdropped;
  FOR status_check IN
    SELECT conname, pg_get_expr(conbin, conrelid) AS expression,
      obj_description(oid, 'pg_constraint') AS migration_comment, convalidated
    FROM pg_constraint WHERE conrelid = 'tasks'::regclass AND contype = 'c'
      AND conkey = ARRAY[status_column]::SMALLINT[]
  LOOP
    IF status_check.migration_comment = 'SitePulse task work status v1' THEN CONTINUE; END IF;
    EXECUTE format('ALTER TABLE tasks DROP CONSTRAINT %I', status_check.conname);
    EXECUTE format('ALTER TABLE tasks ADD CONSTRAINT %I CHECK ((%s) OR status IN (''pending'', ''ongoing''))%s',
      status_check.conname, status_check.expression, CASE WHEN status_check.convalidated THEN '' ELSE ' NOT VALID' END);
    EXECUTE format('COMMENT ON CONSTRAINT %I ON tasks IS %L', status_check.conname, 'SitePulse task work status v1');
  END LOOP;
END $$;

ALTER TABLE tasks ALTER COLUMN status SET DEFAULT 'pending';
-- Existing rows and timestamps are untouched. Legacy/null values normalize on read.
-- The existing progress_pct constraints and all completion/cancellation states remain.
