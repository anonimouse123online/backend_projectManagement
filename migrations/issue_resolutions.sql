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
