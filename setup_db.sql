-- =============================================================================
-- SitePulse — Complete Database Setup Script
-- Creates all 29 tables, indexes, constraints, sequences, and seed data
-- matching the active production/development PostgreSQL database.
-- Compatible with PostgreSQL 14, 15, 16, 17, and 18.
-- =============================================================================

-- ─── EXTENSIONS ──────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─── 1. USERS ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY DEFAULT ('u-' || substr(gen_random_uuid()::text, 1, 8)),
  name          TEXT,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'Member',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  full_name     VARCHAR(255),
  is_active     BOOLEAN DEFAULT true,
  phone         VARCHAR(50),
  company       VARCHAR(255),
  preferences   JSONB,
  updated_at    TIMESTAMP DEFAULT now()
);

-- ─── 2. PROJECTS ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS projects (
  id             SERIAL PRIMARY KEY,
  project_code   TEXT UNIQUE,
  name           TEXT NOT NULL,
  location       TEXT NOT NULL DEFAULT '',
  client         TEXT NOT NULL DEFAULT '',
  timeline_start TEXT NOT NULL DEFAULT 'TBD',
  timeline_end   TEXT NOT NULL DEFAULT 'TBD',
  budget         TEXT NOT NULL DEFAULT '—',
  status         TEXT NOT NULL DEFAULT 'planning',
  owner_id       TEXT REFERENCES users(id) ON DELETE CASCADE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  progress_pct   INTEGER DEFAULT 35,
  code           VARCHAR(50),
  phase          VARCHAR(100),
  scope          TEXT,
  start_date     DATE,
  end_date       DATE,
  updated_at     TIMESTAMP DEFAULT now()
);

-- ─── 3. PROJECT MEMBERS ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS project_members (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id VARCHAR(50) NOT NULL,
  user_id    TEXT NOT NULL,
  role       VARCHAR(50) DEFAULT 'Member',
  joined_at  TIMESTAMP DEFAULT now(),
  UNIQUE (project_id, user_id)
);

-- ─── 4. PROJECT MEMBERSHIPS ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS project_memberships (
  id                SERIAL PRIMARY KEY,
  project_id        INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  construction_role TEXT NOT NULL DEFAULT 'Unassigned',
  requested_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, user_id)
);

-- ─── 5. PROJECT INVITE CODES ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS project_invite_codes (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id VARCHAR(50) NOT NULL,
  code       VARCHAR(20) UNIQUE NOT NULL,
  used       BOOLEAN DEFAULT false,
  used_at    TIMESTAMP,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT now()
);

-- ─── 6. TASKS ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tasks (
  id                 TEXT PRIMARY KEY DEFAULT ('task-' || substr(gen_random_uuid()::text, 1, 8)),
  project_id         INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title              TEXT,
  description        TEXT DEFAULT '',
  status             TEXT NOT NULL DEFAULT 'pending',
  priority           TEXT NOT NULL DEFAULT 'medium',
  progress           INTEGER DEFAULT 0,
  due_date           TEXT NOT NULL DEFAULT '—',
  phase              TEXT NOT NULL DEFAULT 'Phase 1 - Foundation',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  task_name          VARCHAR(255),
  assignee_id        TEXT,
  manpower_needed    TEXT,
  materials_required TEXT,
  site_instructions  TEXT,
  progress_pct       INTEGER DEFAULT 0,
  updated_at         TIMESTAMP DEFAULT now(),
  subtasks           JSONB DEFAULT '[]'::jsonb
);

-- ─── 7. TASK ASSIGNEES ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS task_assignees (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, user_id)
);

-- ─── 8. TASK IMAGES ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS task_images (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id     TEXT NOT NULL,
  image_paths JSONB NOT NULL DEFAULT '[]'::jsonb,
  upload_date DATE NOT NULL DEFAULT CURRENT_DATE,
  status      VARCHAR(50) DEFAULT 'pending',
  created_at  TIMESTAMP DEFAULT now()
);

-- ─── 9. SUBTASKS ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS subtasks (
  id         TEXT PRIMARY KEY DEFAULT ('node-' || substr(gen_random_uuid()::text, 1, 8)),
  task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  parent_id  TEXT REFERENCES subtasks(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  details    TEXT NOT NULL DEFAULT '',
  done       BOOLEAN NOT NULL DEFAULT false,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── 10. SUBTASK ISSUES ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS subtask_issues (
  id         SERIAL PRIMARY KEY,
  subtask_id TEXT NOT NULL REFERENCES subtasks(id) ON DELETE CASCADE,
  text       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── 11. SUBTASK PHOTOS ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS subtask_photos (
  id         SERIAL PRIMARY KEY,
  subtask_id TEXT NOT NULL REFERENCES subtasks(id) ON DELETE CASCADE,
  file_path  TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── 12. RESOURCES ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS resources (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          VARCHAR(255) NOT NULL,
  supplier      VARCHAR(255),
  category      VARCHAR(50),
  quantity      INTEGER DEFAULT 0,
  unit          VARCHAR(50),
  min_threshold INTEGER DEFAULT 0,
  unit_price    NUMERIC(12,2) DEFAULT 0,
  project       VARCHAR(255),
  status        VARCHAR(50) DEFAULT 'In stock',
  created_at    TIMESTAMP DEFAULT now(),
  updated_at    TIMESTAMP DEFAULT now()
);

-- ─── 13. DOCUMENTS ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS documents (
  id            TEXT PRIMARY KEY DEFAULT ('doc-' || substr(gen_random_uuid()::text, 1, 8)),
  project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  file_type     TEXT NOT NULL DEFAULT 'PDF' CHECK (file_type IN ('PDF', 'DWG', 'XLS', 'DOC')),
  section       TEXT NOT NULL DEFAULT '',
  category      TEXT NOT NULL DEFAULT '',
  uploaded_by   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  uploaded_date TEXT NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  project_code  VARCHAR(50),
  type          VARCHAR(50),
  file_url      TEXT,
  file_path     TEXT,
  file_size     BIGINT,
  uploaded_at   TIMESTAMP DEFAULT now()
);

-- ─── 14. CONVERSATIONS ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS conversations (
  id         TEXT PRIMARY KEY DEFAULT ('conv-' || substr(gen_random_uuid()::text, 1, 8)),
  type       TEXT NOT NULL DEFAULT 'dm' CHECK (type IN ('dm', 'group')),
  name       TEXT NOT NULL DEFAULT '',
  subtitle   TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── 15. CONVERSATION MEMBERS ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS conversation_members (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (conversation_id, user_id)
);

-- ─── 16. MESSAGES ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY DEFAULT ('msg-' || substr(gen_random_uuid()::text, 1, 8)),
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text            TEXT NOT NULL DEFAULT '',
  attachment_name TEXT,
  attachment_path TEXT,
  attachment_type TEXT,
  attachment_size INTEGER,
  is_image        BOOLEAN DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── 17. NOTIFICATIONS ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notifications (
  id         TEXT PRIMARY KEY DEFAULT ('n-' || substr(gen_random_uuid()::text, 1, 8)),
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       TEXT NOT NULL DEFAULT 'task' CHECK (type IN ('task', 'message', 'weather', 'file', 'project', 'member', 'deadline')),
  title      TEXT NOT NULL,
  body       TEXT NOT NULL DEFAULT '',
  link       TEXT,
  read       BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── 18. DAILY LOGS ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS daily_logs (
  id                  TEXT PRIMARY KEY DEFAULT ('log-' || substr(gen_random_uuid()::text, 1, 8)),
  task_id             TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date                DATE NOT NULL DEFAULT CURRENT_DATE,
  workers_on_site     INTEGER NOT NULL DEFAULT 0,
  supervisors         INTEGER NOT NULL DEFAULT 0,
  sub_contractors     INTEGER NOT NULL DEFAULT 0,
  total_work_hours    INTEGER NOT NULL DEFAULT 0,
  weather             TEXT NOT NULL DEFAULT 'Clear / Sunny',
  temperature         TEXT NOT NULL DEFAULT '',
  work_completed      TEXT NOT NULL DEFAULT '',
  materials_delivered TEXT NOT NULL DEFAULT '',
  equipment_used      TEXT NOT NULL DEFAULT '',
  safety_incidents    TEXT NOT NULL DEFAULT '',
  additional_notes    TEXT NOT NULL DEFAULT '',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── 19. TIME LOGS ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS time_logs (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_name        VARCHAR(255) NOT NULL,
  engineer_name       VARCHAR(255),
  date                DATE NOT NULL DEFAULT CURRENT_DATE,
  work_on_site        INTEGER DEFAULT 0,
  supervisors         INTEGER DEFAULT 0,
  sub_contractors     INTEGER DEFAULT 0,
  total_work_hours    VARCHAR(50) DEFAULT '8 hrs',
  weather             VARCHAR(50) DEFAULT 'Sunny',
  temperature         VARCHAR(50) DEFAULT '31°C',
  work_completed      TEXT,
  materials_delivered TEXT,
  equipment_used      TEXT,
  additional_notes    TEXT,
  has_incident        BOOLEAN DEFAULT false,
  created_at          TIMESTAMP DEFAULT now(),
  updated_at          TIMESTAMP DEFAULT now()
);

-- ─── 20. USER SETTINGS ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_settings (
  id            SERIAL PRIMARY KEY,
  user_id       TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  settings_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── 21. PROJECT ISSUES ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS project_issues (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_code     VARCHAR(50) NOT NULL,
  title            VARCHAR(255) NOT NULL,
  category         VARCHAR(100) NOT NULL,
  priority         VARCHAR(20) NOT NULL DEFAULT 'Medium',
  location         VARCHAR(255),
  description      TEXT NOT NULL,
  status           VARCHAR(50) NOT NULL DEFAULT 'Open',
  reported_by      TEXT,
  assigned_to      TEXT,
  resolution_notes TEXT,
  resolved_at      TIMESTAMP,
  created_at       TIMESTAMP DEFAULT now(),
  updated_at       TIMESTAMP DEFAULT now()
);

-- ─── 22. PROJECT REPORTS ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS project_reports (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_code       VARCHAR(50) NOT NULL,
  title              VARCHAR(255) NOT NULL,
  report_type        VARCHAR(100) NOT NULL DEFAULT 'Daily Site Log',
  report_date        DATE NOT NULL DEFAULT CURRENT_DATE,
  prepared_by        TEXT,
  summary            TEXT NOT NULL,
  key_activities     TEXT,
  issues_highlighted TEXT,
  manpower_count     INTEGER DEFAULT 0,
  equipment_on_site  TEXT,
  weather            VARCHAR(50) DEFAULT 'Clear',
  status             VARCHAR(50) DEFAULT 'Final',
  created_at         TIMESTAMP DEFAULT now()
);

-- ─── 23. PROJECT PROGRESS LOGS ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS project_progress_logs (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_code   VARCHAR(50) NOT NULL,
  phase          VARCHAR(100) NOT NULL,
  progress_pct   INTEGER NOT NULL DEFAULT 0,
  summary        TEXT NOT NULL,
  work_completed TEXT,
  manpower       INTEGER DEFAULT 0,
  weather        VARCHAR(50) DEFAULT 'Sunny',
  logged_by      TEXT,
  created_at     TIMESTAMP DEFAULT now()
);

-- ─── 24. SOFTWARE ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS software (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        VARCHAR(255) NOT NULL,
  version     VARCHAR(50),
  description TEXT,
  license_key VARCHAR(255),
  status      VARCHAR(50) DEFAULT 'active',
  project_id  TEXT,
  created_at  TIMESTAMP DEFAULT now(),
  updated_at  TIMESTAMP DEFAULT now()
);

-- ─── 25. DASHBOARD STATS ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS dashboard_stats (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  label      VARCHAR(100) NOT NULL,
  value      VARCHAR(50) NOT NULL,
  trend      VARCHAR(50),
  up         BOOLEAN DEFAULT true,
  bg         VARCHAR(50),
  clr        VARCHAR(50),
  icon       VARCHAR(10),
  sort_order INTEGER DEFAULT 0
);

-- ─── 26. MONITOR ITEMS ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS monitor_items (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  label      VARCHAR(255) NOT NULL,
  checked    BOOLEAN DEFAULT false,
  sort_order INTEGER DEFAULT 0
);

-- ─── 27. RFIS ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rfis (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  label      VARCHAR(255) NOT NULL,
  is_urgent  BOOLEAN DEFAULT false,
  sort_order INTEGER DEFAULT 0
);

-- ─── 28. NOTES ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notes (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  label      VARCHAR(255) NOT NULL,
  status     VARCHAR(50),
  cls        VARCHAR(50),
  sort_order INTEGER DEFAULT 0
);

-- ─── 29. GAUGE STATS ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS gauge_stats (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  v          VARCHAR(50) NOT NULL,
  l          VARCHAR(50) NOT NULL,
  c          VARCHAR(50),
  sort_order INTEGER DEFAULT 0
);

-- ═══════════════════════════════════════════════════════════════════════════════
-- INDEXES
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_projects_code ON projects(code);
CREATE INDEX IF NOT EXISTS idx_projects_owner ON projects(owner_id);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_subtasks_task ON subtasks(task_id);
CREATE INDEX IF NOT EXISTS idx_subtasks_parent ON subtasks(parent_id);
CREATE INDEX IF NOT EXISTS idx_documents_project ON documents(project_id);
CREATE INDEX IF NOT EXISTS idx_memberships_project ON project_memberships(project_id);
CREATE INDEX IF NOT EXISTS idx_memberships_user ON project_memberships(user_id);
CREATE INDEX IF NOT EXISTS idx_project_members_project ON project_members(project_id);
CREATE INDEX IF NOT EXISTS idx_project_members_user ON project_members(user_id);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_daily_logs_task ON daily_logs(task_id);

-- ═══════════════════════════════════════════════════════════════════════════════
-- SEED DATA
-- Default password for all seed accounts: "password123"
-- Hash: byAvj5jhVn2r1lVFqzpPhOZ0gEOIWmWOQh8V1C5V9hL1xAvA0JgsS
-- ═══════════════════════════════════════════════════════════════════════════════

-- ─── USERS ───────────────────────────────────────────────────────────────────
INSERT INTO users (id, name, email, password_hash, role, full_name, is_active) VALUES
  ('u-admin',    'Alex Meian',             'admin@sitepulse.com',         'byAvj5jhVn2r1lVFqzpPhOZ0gEOIWmWOQh8V1C5V9hL1xAvA0JgsS', 'Admin',         'Alex Meian',             true),
  ('u-9382fdd6', 'Khyan Earl G. Villegas', 'villegaskhyanearl@gmail.com', 'byAvj5jhVn2r1lVFqzpPhOZ0gEOIWmWOQh8V1C5V9hL1xAvA0JgsS', 'Admin',         'Khyan Earl G. Villegas', true),
  ('u-b8852abb', 'Khyan Earl Villeags',    'khyan@gmail.com',             'byAvj5jhVn2r1lVFqzpPhOZ0gEOIWmWOQh8V1C5V9hL1xAvA0JgsS', 'Admin',         'Khyan Earl Villeags',    true),
  ('u-b7c767be', 'villegas',               'villegas@gmail.com',          'byAvj5jhVn2r1lVFqzpPhOZ0gEOIWmWOQh8V1C5V9hL1xAvA0JgsS', 'Admin',         'villegas',               true),
  ('u-mike-j',   'Mike Johnson',           'mike.j@sitepulse.com',        'byAvj5jhVn2r1lVFqzpPhOZ0gEOIWmWOQh8V1C5V9hL1xAvA0JgsS', 'Site Engineer', 'Mike Johnson',           true),
  ('u-sarah-c',  'Sarah Chen',             'sarah.c@sitepulse.com',       'byAvj5jhVn2r1lVFqzpPhOZ0gEOIWmWOQh8V1C5V9hL1xAvA0JgsS', 'Site Engineer', 'Sarah Chen',             true),
  ('u-robert-m', 'Robert Martinez',        'robert.m@sitepulse.com',      'byAvj5jhVn2r1lVFqzpPhOZ0gEOIWmWOQh8V1C5V9hL1xAvA0JgsS', 'Site Engineer', 'Robert Martinez',        true)
ON CONFLICT (email) DO UPDATE SET
  password_hash = EXCLUDED.password_hash,
  role = EXCLUDED.role,
  full_name = EXCLUDED.full_name;

-- ─── PROJECTS ────────────────────────────────────────────────────────────────
INSERT INTO projects (id, project_code, code, name, location, client, status, owner_id, progress_pct) VALUES
  (17, 'test-123-123', 'test-123-123', 'Test1', 'test',  'SitePulse Client', 'Ongoing', 'u-9382fdd6', 71),
  (19, 'test-234-234', 'test-234-234', 'Test2', 'test2', 'SitePulse Client', 'Ongoing', 'u-9382fdd6', 0)
ON CONFLICT (id) DO NOTHING;

-- Align sequence for projects so new inserts do not collide
SELECT setval('projects_id_seq', COALESCE((SELECT MAX(id) FROM projects), 1));

-- ─── PROJECT MEMBERS ─────────────────────────────────────────────────────────
INSERT INTO project_members (project_id, user_id, role) VALUES
  ('test-123-123', 'u-9382fdd6', 'Admin'),
  ('test-123-123', 'u-b8852abb', 'Admin'),
  ('test-123-123', 'u-b7c767be', 'Admin'),
  ('test-234-234', 'u-admin',    'Admin'),
  ('test-234-234', 'u-9382fdd6', 'Owner'),
  ('test-234-234', 'u-b8852abb', 'Admin')
ON CONFLICT (project_id, user_id) DO NOTHING;

-- ─── PROJECT INVITE CODES ────────────────────────────────────────────────────
INSERT INTO project_invite_codes (id, project_id, code, used, expires_at) VALUES
  ('98e6e370-3c22-4287-840e-56821e4b9b25', 'test-123-123', '52DD-AF61', false, NOW() + INTERVAL '30 days'),
  ('da81f17c-9a2a-437d-a147-694d6e681386', 'test-123-123', '2C9C-5DE3', false, NOW() + INTERVAL '30 days')
ON CONFLICT (code) DO NOTHING;

-- ─── RESOURCES ───────────────────────────────────────────────────────────────
INSERT INTO resources (id, name, supplier, category, quantity, unit, min_threshold, unit_price, project, status) VALUES
  ('1ca46e6a-bae0-421f-8f28-ccc183cc12eb', 'Portland Cement Type 1',  'Eagle Cement',    'Material',  50,  'bags',  10, 280.00,   'Test1', 'In stock'),
  ('8734f1d8-b2ec-4dbc-8458-f36038ada4f8', 'Kabilya',                 'SteelAsia',       'Material',  100, 'pcs',   20, 195.00,   'Test1', 'In stock'),
  ('ae742159-a338-4711-88cd-ba0028f42354', 'High Grade Steel Rebar',  'SteelAsia Mfg.',  'Material',  150, 'pcs',   30, 210.00,   'Test2', 'In stock'),
  ('8922530b-3ce9-42a7-a3e5-994fc1aaa1ae', 'Concrete Mixer 1-Bagger', 'HeavyEquip Inc.', 'Equipment', 2,   'units', 1,  15000.00, 'Test2', 'In stock')
ON CONFLICT (id) DO NOTHING;

-- ─── TASKS ───────────────────────────────────────────────────────────────────
INSERT INTO tasks (id, project_id, title, task_name, status, priority, due_date, phase, assignee_id, manpower_needed, materials_required, site_instructions, progress_pct) VALUES
  ('task-7c08111c', 17, 'test3',                                     'test3',                                     'In Progress', 'Medium', '2026-09-14', 'Electrical & Utilities', 'u-9382fdd6', '3 workers', 'PVC conduits', 'Follow standard electrical code', 50),
  ('task-ade314b3', 17, 'test5',                                     'test5',                                     'Pending',     'Medium', '2026-09-18', 'Plumbing & MEP',        'u-b8852abb', '2 workers', 'PPR pipes',     'Inspect pipe joints for pressure leakage', 0),
  ('task-3fe484fd', 17, 'Rebar Tying & Footing Formwork Inspection', 'Rebar Tying & Footing Formwork Inspection', 'Completed',   'High',   '2026-09-25', 'Foundation',            'u-admin',    '8 workers', '100 pcs Kabilya', 'Verify rebar spacing per design blueprint', 100),
  ('task-850ea290', 17, 'Test1',                                     'Test1',                                     'Completed',   'Medium', '2026-10-02', 'Foundation',            'u-9382fdd6', '5 workers', '50 bags cement', 'Cure footing slab for 7 days', 100),
  ('task-81335e9e', 17, 'Structural Column Pouring',                'Structural Column Pouring',                'Completed',   'Medium', '2026-10-02', 'Structural',            'u-b8852abb', '6 workers', 'Cement & gravel', 'Ensure proper vibrator compaction', 100),
  ('task-713f7f8f', 17, 'Excavation & Ground Preparation',           'Excavation & Ground Preparation',           'Completed',   'Medium', '2026-10-01', 'Foundation',            'u-admin',    '4 workers', 'Backhoe equipment', 'Grade foundation pit to correct elevation', 100),
  ('task-000ff613', 19, 'Task With Full Resource Fields',            'Task With Full Resource Fields',            'Pending',     'High',   '2026-09-14', 'Foundation',            'u-9382fdd6', '1 worker',  'High Grade Rebar', 'Follow engineer on-site guidance', 0)
ON CONFLICT (id) DO NOTHING;

-- ─── DASHBOARD STATS ─────────────────────────────────────────────────────────
INSERT INTO dashboard_stats (id, label, value, trend, up, bg, clr, icon, sort_order) VALUES
  ('11111111-1111-1111-1111-111111111111', 'Active Projects',    '2',    '12%', true,  '#EFF6FF', '#3B82F6', '📋', 1),
  ('22222222-2222-2222-2222-222222222222', 'Total Tasks',        '7',    '8%',  true,  '#F0FDF4', '#22C55E', '✅', 2),
  ('33333333-3333-3333-3333-333333333333', 'Team Members',       '4',    '5%',  true,  '#FFFBEB', '#F59E0B', '👷', 3),
  ('44444444-4444-4444-4444-444444444444', 'Issues Reported',    '0',    '0%',  false, '#FEF2F2', '#EF4444', '⚠️', 4)
ON CONFLICT (id) DO NOTHING;

-- ─── MONITOR ITEMS ───────────────────────────────────────────────────────────
INSERT INTO monitor_items (id, label, checked, sort_order) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Downtown Office Complex — Block A', true,  1),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Riverside Bridge — South Abutment', true,  2),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'Northside Residential — Site Prep', false, 3),
  ('dddddddd-dddd-dddd-dddd-dddddddddddd', 'Highway 5 Ext. — Final Inspection', true,  4)
ON CONFLICT (id) DO NOTHING;

-- ─── RFIS ────────────────────────────────────────────────────────────────────
INSERT INTO rfis (id, label, is_urgent, sort_order) VALUES
  ('12345678-aaaa-bbbb-cccc-000000000001', 'RFI-042: Column spacing clarification', true,  1),
  ('12345678-aaaa-bbbb-cccc-000000000002', 'RFI-043: Rebar grade substitution',     true,  2),
  ('12345678-aaaa-bbbb-cccc-000000000003', 'RFI-044: Drainage pipe routing change', false, 3)
ON CONFLICT (id) DO NOTHING;

-- ─── NOTES ───────────────────────────────────────────────────────────────────
INSERT INTO notes (id, label, status, cls, sort_order) VALUES
  ('12345678-bbbb-cccc-dddd-000000000001', 'Safety briefing — all hands 8 AM Mon', 'Action',  'action',  1),
  ('12345678-bbbb-cccc-dddd-000000000002', 'Concrete test results pending',        'Waiting', 'waiting', 2),
  ('12345678-bbbb-cccc-dddd-000000000003', 'Material delivery ETA: Aug 18',        'Info',    'info',    3),
  ('12345678-bbbb-cccc-dddd-000000000004', 'Weather alert: Rain expected Fri',     'Warning', 'warning', 4)
ON CONFLICT (id) DO NOTHING;

-- ─── GAUGE STATS ─────────────────────────────────────────────────────────────
INSERT INTO gauge_stats (id, v, l, c, sort_order) VALUES
  ('12345678-cccc-dddd-eeee-000000000001', '2', 'Total',     '#64748b', 1),
  ('12345678-cccc-dddd-eeee-000000000002', '2', 'Active',    '#3b82f6', 2),
  ('12345678-cccc-dddd-eeee-000000000003', '0', 'Completed', '#22c55e', 3),
  ('12345678-cccc-dddd-eeee-000000000004', '0', 'Planning',  '#f59e0b', 4)
ON CONFLICT (id) DO NOTHING;

-- Align other sequences
SELECT setval('project_memberships_id_seq', COALESCE((SELECT MAX(id) FROM project_memberships), 1));
SELECT setval('subtask_issues_id_seq', COALESCE((SELECT MAX(id) FROM subtask_issues), 1));
SELECT setval('subtask_photos_id_seq', COALESCE((SELECT MAX(id) FROM subtask_photos), 1));
SELECT setval('user_settings_id_seq', COALESCE((SELECT MAX(id) FROM user_settings), 1));

-- =============================================================================
-- Setup Complete! All tables, indexes, constraints & seeds initialized.
-- =============================================================================
