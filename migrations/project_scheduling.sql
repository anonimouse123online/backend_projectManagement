-- Additive SitePulse scheduling engine schema. Existing tasks and dependencies are preserved.
ALTER TABLE task_dependencies ADD COLUMN IF NOT EXISTS dependency_type VARCHAR(2) NOT NULL DEFAULT 'FS';
ALTER TABLE task_dependencies ADD COLUMN IF NOT EXISTS lag_working_days INTEGER NOT NULL DEFAULT 0;
ALTER TABLE task_dependencies ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE task_dependencies ADD COLUMN IF NOT EXISTS project_id UUID;
ALTER TABLE task_dependencies ADD COLUMN IF NOT EXISTS id UUID DEFAULT gen_random_uuid();
ALTER TABLE task_dependencies ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS task_dependencies_id_idx ON task_dependencies(id);
UPDATE task_dependencies d SET project_id = t.project_id FROM tasks t WHERE t.id=d.task_id AND d.project_id IS NULL;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='task_dependencies_type_check' AND conrelid='task_dependencies'::regclass) THEN
   ALTER TABLE task_dependencies ADD CONSTRAINT task_dependencies_type_check CHECK (dependency_type IN ('FS','SS','FF','SF'));
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='task_dependencies_same_project_fk' AND conrelid='task_dependencies'::regclass) THEN
   ALTER TABLE task_dependencies ADD CONSTRAINT task_dependencies_same_project_fk FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;
 END IF;
END $$;
CREATE INDEX IF NOT EXISTS task_dependencies_project_idx ON task_dependencies(project_id);
CREATE INDEX IF NOT EXISTS task_dependencies_predecessor_idx ON task_dependencies(predecessor_task_id);

CREATE OR REPLACE FUNCTION sitepulse_validate_dependency() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE pred_project UUID; succ_project UUID; cyclic BOOLEAN;
BEGIN
 SELECT project_id INTO succ_project FROM tasks WHERE id=NEW.task_id;
 SELECT project_id INTO pred_project FROM tasks WHERE id=NEW.predecessor_task_id;
 IF succ_project IS NULL OR pred_project IS NULL OR succ_project <> pred_project THEN
   RAISE EXCEPTION 'Dependency tasks must belong to the same project' USING ERRCODE='23514';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(succ_project::text,0));
 NEW.project_id := succ_project;
 WITH RECURSIVE reachable(id) AS (
   SELECT NEW.task_id UNION SELECT d.task_id FROM task_dependencies d JOIN reachable r ON d.predecessor_task_id=r.id
   WHERE d.task_id <> NEW.task_id
 ) SELECT EXISTS(SELECT 1 FROM reachable WHERE id=NEW.predecessor_task_id) INTO cyclic;
 IF cyclic THEN RAISE EXCEPTION 'Dependency would create a cycle' USING ERRCODE='23514'; END IF;
 NEW.updated_at := NOW(); RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS task_dependencies_validate ON task_dependencies;
CREATE TRIGGER task_dependencies_validate BEFORE INSERT OR UPDATE ON task_dependencies FOR EACH ROW EXECUTE FUNCTION sitepulse_validate_dependency();

CREATE TABLE IF NOT EXISTS project_scheduling_calendars (
 project_id UUID PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
 working_weekdays SMALLINT[] NOT NULL DEFAULT ARRAY[1,2,3,4,5]::SMALLINT[],
 working_hours JSONB NOT NULL DEFAULT '{}'::jsonb,
 timezone VARCHAR(100) NOT NULL DEFAULT 'Asia/Manila', calendar_version INTEGER NOT NULL DEFAULT 1,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 CHECK (cardinality(working_weekdays) BETWEEN 1 AND 7),
 CHECK (working_weekdays <@ ARRAY[0,1,2,3,4,5,6]::SMALLINT[])
);
INSERT INTO project_scheduling_calendars(project_id) SELECT id FROM projects ON CONFLICT(project_id) DO NOTHING;
CREATE TABLE IF NOT EXISTS schedule_baselines (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 version INTEGER NOT NULL, project_completion_date DATE, approved_by UUID REFERENCES users(id) ON DELETE SET NULL,
 created_by UUID REFERENCES users(id) ON DELETE SET NULL, approved_at TIMESTAMPTZ,
 dependency_snapshot JSONB NOT NULL DEFAULT '[]'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(project_id,version)
);
CREATE TABLE IF NOT EXISTS schedule_baseline_tasks (
 snapshot_id UUID PRIMARY KEY DEFAULT gen_random_uuid(), task_id UUID REFERENCES tasks(id) ON DELETE SET NULL, task_name TEXT NOT NULL,
 start_date DATE, end_date DATE, duration_days INTEGER, milestone_date DATE, progress_pct INTEGER,
 baseline_id UUID NOT NULL REFERENCES schedule_baselines(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS schedule_scenarios (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 name VARCHAR(200) NOT NULL, description TEXT, author_id UUID REFERENCES users(id) ON DELETE SET NULL,
 scenario_type VARCHAR(40) NOT NULL DEFAULT 'TASK_DELAY', selected_task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
 modification_reason TEXT NOT NULL DEFAULT 'Scenario simulation', resource_assumptions JSONB NOT NULL DEFAULT '{}'::jsonb,
 original_schedule_version TEXT, calendar_version INTEGER NOT NULL DEFAULT 1, critical_path_changes JSONB NOT NULL DEFAULT '{}'::jsonb,
 status VARCHAR(30) NOT NULL DEFAULT 'simulated' CHECK(status IN ('simulated','submitted','approved','rejected','applied','reversed')),
 original_snapshot JSONB NOT NULL, result_snapshot JSONB NOT NULL, forecast_completion_date DATE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS schedule_scenarios_project_created_idx ON schedule_scenarios(project_id,created_at DESC);
ALTER TABLE schedule_scenarios ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS schedule_scenarios_idempotency_idx ON schedule_scenarios(project_id,author_id,idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE TABLE IF NOT EXISTS scenario_task_changes (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), scenario_id UUID NOT NULL REFERENCES schedule_scenarios(id) ON DELETE CASCADE,
 task_id UUID REFERENCES tasks(id) ON DELETE SET NULL, change JSONB NOT NULL, result JSONB,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS schedule_change_requests (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 scenario_id UUID NOT NULL REFERENCES schedule_scenarios(id) ON DELETE RESTRICT,
 reason TEXT NOT NULL CHECK(length(trim(reason))>0), requested_by UUID REFERENCES users(id) ON DELETE SET NULL,
 reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
 status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK(status IN ('draft','pending','approved','rejected','cancelled','superseded','applied','reversed')),
 before_snapshot JSONB NOT NULL, after_snapshot JSONB NOT NULL, applied_at TIMESTAMPTZ,
 reviewed_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS schedule_change_requests_project_idx ON schedule_change_requests(project_id,created_at DESC);
ALTER TABLE schedule_change_requests ADD COLUMN IF NOT EXISTS review_comments TEXT;
ALTER TABLE schedule_change_requests ADD COLUMN IF NOT EXISTS schedule_version TEXT;
ALTER TABLE schedule_change_requests ADD COLUMN IF NOT EXISTS decision_at TIMESTAMPTZ;
CREATE OR REPLACE FUNCTION sitepulse_schedule_request_decision_time() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.status='pending' AND NEW.status IN ('applied','approved','rejected','cancelled','superseded') THEN NEW.decision_at:=COALESCE(NEW.decision_at,NOW()); END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS schedule_request_decision_time ON schedule_change_requests;
CREATE TRIGGER schedule_request_decision_time BEFORE UPDATE ON schedule_change_requests FOR EACH ROW EXECUTE FUNCTION sitepulse_schedule_request_decision_time();
CREATE TABLE IF NOT EXISTS schedule_audit_logs (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 task_id UUID REFERENCES tasks(id) ON DELETE SET NULL, change_request_id UUID REFERENCES schedule_change_requests(id) ON DELETE SET NULL,
 actor_id UUID REFERENCES users(id) ON DELETE SET NULL, change_type VARCHAR(40) NOT NULL,
 previous_start_date DATE, previous_end_date DATE, new_start_date DATE, new_end_date DATE,
 previous_duration INTEGER, new_duration INTEGER, dependency_changes JSONB NOT NULL DEFAULT '[]'::jsonb,
 reason TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS schedule_audit_project_created_idx ON schedule_audit_logs(project_id,created_at DESC);
CREATE INDEX IF NOT EXISTS schedule_audit_task_created_idx ON schedule_audit_logs(task_id,created_at DESC);
CREATE TABLE IF NOT EXISTS schedule_change_history (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), request_id UUID NOT NULL REFERENCES schedule_change_requests(id) ON DELETE CASCADE,
 actor_id UUID REFERENCES users(id) ON DELETE SET NULL, action VARCHAR(30) NOT NULL,
 before_snapshot JSONB NOT NULL, after_snapshot JSONB NOT NULL, reason TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
