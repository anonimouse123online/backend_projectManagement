-- The API uses /timelogs; the PostgreSQL table is time_logs.
-- Drop only the obsolete flag, retaining every Time Log row and all work fields.
-- No CASCADE: an unexpected external dependency must abort the migration.
ALTER TABLE time_logs DROP COLUMN IF EXISTS has_incident;
