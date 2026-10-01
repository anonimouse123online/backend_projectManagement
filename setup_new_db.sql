-- ═══════════════════════════════════════════════════════════════════════════════
-- SitePulse — Complete New Database Setup Script
-- Database: sitepulse_db
-- ═══════════════════════════════════════════════════════════════════════════════

-- ─── Extensions ───────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─── USERS ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  full_name     VARCHAR(255) NOT NULL,
  email         VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role          VARCHAR(50) NOT NULL DEFAULT 'Site Engineer',
  is_active     BOOLEAN DEFAULT TRUE,
  created_at    TIMESTAMP DEFAULT NOW(),
  updated_at    TIMESTAMP DEFAULT NOW()
);

-- ─── PROJECTS ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS projects (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  code        VARCHAR(50) UNIQUE NOT NULL,
  name        VARCHAR(255) NOT NULL,
  location    TEXT,
  scope       TEXT,
  client      VARCHAR(255),
  budget      NUMERIC(15,2),
  start_date  DATE,
  end_date    DATE,
  phase       VARCHAR(100),
  status      VARCHAR(50) DEFAULT 'Planning',
  progress_pct INTEGER DEFAULT 0,
  owner_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMP DEFAULT NOW(),
  updated_at  TIMESTAMP DEFAULT NOW()
);

-- ─── PROJECT INVITE CODES ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS project_invite_codes (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id  VARCHAR(50) REFERENCES projects(code) ON DELETE CASCADE,
  code        VARCHAR(20) UNIQUE NOT NULL,
  used        BOOLEAN DEFAULT FALSE,
  used_at     TIMESTAMP,
  expires_at  TIMESTAMP NOT NULL,
  created_at  TIMESTAMP DEFAULT NOW()
);

-- ─── PROJECT MEMBERS ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS project_members (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id  VARCHAR(50) REFERENCES projects(code) ON DELETE CASCADE,
  user_id     UUID REFERENCES users(id) ON DELETE CASCADE,
  user_name   VARCHAR(255),
  role        VARCHAR(50) DEFAULT 'Member',
  joined_at   TIMESTAMP DEFAULT NOW(),
  UNIQUE(project_id, user_id)
);

-- ─── TASKS ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tasks (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  task_name           VARCHAR(255) NOT NULL,
  phase               VARCHAR(100),
  assignee_id         UUID REFERENCES users(id) ON DELETE SET NULL,
  due_date            DATE,
  priority            VARCHAR(20) DEFAULT 'Medium',
  status              VARCHAR(50) DEFAULT 'Pending',
  manpower_needed     TEXT,
  materials_required  TEXT,
  site_instructions   TEXT,
  project_id          UUID REFERENCES projects(id) ON DELETE SET NULL,
  subtasks            JSONB DEFAULT '[]'::jsonb,
  progress_pct        INTEGER DEFAULT 0,
  created_at          TIMESTAMP DEFAULT NOW(),
  updated_at          TIMESTAMP DEFAULT NOW()
);

-- ─── TASK IMAGES ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS task_images (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  task_id     UUID REFERENCES tasks(id) ON DELETE CASCADE,
  image_paths JSONB NOT NULL DEFAULT '[]',
  upload_date DATE NOT NULL,
  status      VARCHAR(50) DEFAULT 'pending',
  created_at  TIMESTAMP DEFAULT NOW(),
  UNIQUE(task_id, upload_date)
);

-- ─── REPORTS ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS reports (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  task_id      UUID REFERENCES tasks(id) ON DELETE CASCADE,
  report_date  DATE NOT NULL,
  observations JSONB,
  report_text  TEXT,
  status       VARCHAR(50) DEFAULT 'pending',
  created_at   TIMESTAMP DEFAULT NOW(),
  UNIQUE (task_id, report_date)
);

-- ─── RESOURCES ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS resources (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name            VARCHAR(255) NOT NULL,
  supplier        VARCHAR(255),
  category        VARCHAR(50),
  quantity        INTEGER DEFAULT 0,
  unit            VARCHAR(50),
  min_threshold   INTEGER DEFAULT 0,
  unit_price      NUMERIC(12,2) DEFAULT 0,
  project         VARCHAR(255),
  task_id         UUID,
  task_name       VARCHAR(255),
  status          VARCHAR(50) DEFAULT 'In stock',
  created_at      TIMESTAMP DEFAULT NOW(),
  updated_at      TIMESTAMP DEFAULT NOW()
);

-- ─── PROJECT PROGRESS LOGS ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS project_progress_logs (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_code  VARCHAR(50) REFERENCES projects(code) ON DELETE CASCADE,
  phase         VARCHAR(100) NOT NULL,
  progress_pct  INTEGER NOT NULL DEFAULT 0,
  summary       TEXT NOT NULL,
  work_completed TEXT,
  manpower      INTEGER DEFAULT 0,
  weather       VARCHAR(50) DEFAULT 'Sunny',
  logged_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMP DEFAULT NOW()
);

-- ─── PROJECT ISSUES ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS project_issues (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_code      VARCHAR(50) REFERENCES projects(code) ON DELETE CASCADE,
  title             VARCHAR(255) NOT NULL,
  category          VARCHAR(100) NOT NULL,
  priority          VARCHAR(20) NOT NULL DEFAULT 'Medium',
  location          VARCHAR(255),
  description       TEXT NOT NULL,
  status            VARCHAR(50) NOT NULL DEFAULT 'Open',
  reported_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  assigned_to       UUID REFERENCES users(id) ON DELETE SET NULL,
  resolution_notes  TEXT,
  resolved_at       TIMESTAMP,
  created_at        TIMESTAMP DEFAULT NOW(),
  updated_at        TIMESTAMP DEFAULT NOW()
);

-- ─── PROJECT REPORTS ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS project_reports (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_code        VARCHAR(50) REFERENCES projects(code) ON DELETE CASCADE,
  title               VARCHAR(255) NOT NULL,
  report_type         VARCHAR(100) NOT NULL DEFAULT 'Daily Site Log',
  report_date         DATE NOT NULL DEFAULT CURRENT_DATE,
  prepared_by         UUID REFERENCES users(id) ON DELETE SET NULL,
  summary             TEXT NOT NULL,
  key_activities      TEXT,
  issues_highlighted  TEXT,
  manpower_count      INTEGER DEFAULT 0,
  equipment_on_site   TEXT,
  weather             VARCHAR(50) DEFAULT 'Clear',
  status              VARCHAR(50) DEFAULT 'Final',
  created_at          TIMESTAMP DEFAULT NOW()
);

-- ─── DOCUMENTS ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS documents (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_code  VARCHAR(50) REFERENCES projects(code) ON DELETE CASCADE,
  name          VARCHAR(255) NOT NULL,
  type          VARCHAR(10) NOT NULL,
  category      VARCHAR(100) NOT NULL,
  uploaded_at   TIMESTAMP DEFAULT NOW()
);

-- ─── SOFTWARE ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS software (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name        VARCHAR(255) NOT NULL,
  version     VARCHAR(50),
  description TEXT,
  license_key VARCHAR(255),
  status      VARCHAR(50) DEFAULT 'active',
  project_id  UUID REFERENCES projects(id) ON DELETE SET NULL,
  created_at  TIMESTAMP DEFAULT NOW(),
  updated_at  TIMESTAMP DEFAULT NOW()
);

-- ─── DASHBOARD: Stats ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS dashboard_stats (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  label       VARCHAR(100) NOT NULL,
  value       VARCHAR(50) NOT NULL,
  trend       VARCHAR(50),
  up          BOOLEAN DEFAULT TRUE,
  bg          VARCHAR(50),
  clr         VARCHAR(50),
  icon        VARCHAR(10),
  sort_order  INTEGER DEFAULT 0
);

-- ─── DASHBOARD: Monitor Items ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS monitor_items (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  label       VARCHAR(255) NOT NULL,
  checked     BOOLEAN DEFAULT FALSE,
  sort_order  INTEGER DEFAULT 0
);

-- ─── DASHBOARD: RFIs ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rfis (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  label       VARCHAR(255) NOT NULL,
  is_urgent   BOOLEAN DEFAULT FALSE,
  sort_order  INTEGER DEFAULT 0
);

-- ─── DASHBOARD: Notes ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notes (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  label       VARCHAR(255) NOT NULL,
  status      VARCHAR(50),
  cls         VARCHAR(50),
  sort_order  INTEGER DEFAULT 0
);

-- ─── DASHBOARD: Gauge Stats ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS gauge_stats (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  v           VARCHAR(50) NOT NULL,
  l           VARCHAR(50) NOT NULL,
  c           VARCHAR(50),
  sort_order  INTEGER DEFAULT 0
);

-- ─── NOTIFICATIONS ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notifications (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  title       VARCHAR(255) NOT NULL,
  message     TEXT NOT NULL,
  audience    VARCHAR(50) NOT NULL DEFAULT 'all',
  created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMP DEFAULT NOW()
);

-- ─── TIME LOGS ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS time_logs (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
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
  has_incident        BOOLEAN DEFAULT FALSE,
  created_at          TIMESTAMP DEFAULT NOW(),
  updated_at          TIMESTAMP DEFAULT NOW()
);

-- ─── MESSAGING: Conversations ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS conversations (
  id          SERIAL PRIMARY KEY,
  is_group    BOOLEAN DEFAULT FALSE,
  group_name  VARCHAR(255),
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ─── MESSAGING: Conversation Members ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS conversation_members (
  id              SERIAL PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(conversation_id, user_id)
);

-- ─── MESSAGING: Messages ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS messages (
  id              SERIAL PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_text    TEXT,
  message_type    VARCHAR(30) DEFAULT 'text',
  is_read         BOOLEAN DEFAULT FALSE,
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ─── MESSAGING: Attachments ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS message_attachments (
  id            SERIAL PRIMARY KEY,
  message_id    INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  original_name TEXT NOT NULL,
  file_name     TEXT NOT NULL,
  file_path     TEXT NOT NULL,
  mime_type     VARCHAR(150),
  file_size     BIGINT,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ─── USER SETTINGS ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_settings (
  id            SERIAL PRIMARY KEY,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE UNIQUE,
  settings_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at    TIMESTAMP DEFAULT NOW()
);

-- ═══════════════════════════════════════════════════════════════════════════════
-- INDEXES
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_projects_code ON projects(code);
CREATE INDEX IF NOT EXISTS idx_tasks_project_id ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee_id ON tasks(assignee_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_reports_task_id ON reports(task_id);
CREATE INDEX IF NOT EXISTS idx_task_images_task_id ON task_images(task_id);
CREATE INDEX IF NOT EXISTS idx_project_members_project_id ON project_members(project_id);
CREATE INDEX IF NOT EXISTS idx_project_members_user_id ON project_members(user_id);
CREATE INDEX IF NOT EXISTS idx_progress_project_code ON project_progress_logs(project_code);
CREATE INDEX IF NOT EXISTS idx_issues_project_code ON project_issues(project_code);
CREATE INDEX IF NOT EXISTS idx_reports_project_code ON project_reports(project_code);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id);
CREATE INDEX IF NOT EXISTS idx_conversation_members_user ON conversation_members(user_id);
CREATE INDEX IF NOT EXISTS idx_time_logs_date ON time_logs(date);
CREATE INDEX IF NOT EXISTS idx_notifications_created_by ON notifications(created_by);

-- ═══════════════════════════════════════════════════════════════════════════════
-- SEED DATA
-- ═══════════════════════════════════════════════════════════════════════════════

-- Users (password: "password123")
INSERT INTO users (full_name, email, password_hash, role) VALUES
  ('Admin User',       'admin@sitepulse.com',   '$2b$10$4yAvj5jhVn2r1lVFqzpPhOZ0gEOIWmWOQh8V1C5V9hL1xAvA0JgsS', 'Admin'),
  ('Mike Johnson',     'mike.j@sitepulse.com',  '$2b$10$4yAvj5jhVn2r1lVFqzpPhOZ0gEOIWmWOQh8V1C5V9hL1xAvA0JgsS', 'Site Engineer'),
  ('Sarah Chen',       'sarah.c@sitepulse.com', '$2b$10$4yAvj5jhVn2r1lVFqzpPhOZ0gEOIWmWOQh8V1C5V9hL1xAvA0JgsS', 'Site Engineer'),
  ('Robert Martinez',  'robert.m@sitepulse.com','$2b$10$4yAvj5jhVn2r1lVFqzpPhOZ0gEOIWmWOQh8V1C5V9hL1xAvA0JgsS', 'Site Engineer')
ON CONFLICT (email) DO NOTHING;

-- Projects
INSERT INTO projects (code, name, location, scope, client, budget, start_date, end_date, phase, status, progress_pct) VALUES
  ('PRJ-2026-001', 'Downtown Office Complex',        'Makati CBD, Metro Manila',          'Construction of 15-story commercial building with underground parking', 'ABC Corporation',     45000000.00, '2026-01-15', '2027-06-30', 'Phase 2 - Structure', 'Ongoing', 52),
  ('PRJ-2026-002', 'Riverside Bridge Renovation',     'Pasig River, Mandaluyong',          'Full structural renovation and widening of existing bridge',           'DPWH Metro Manila',   28000000.00, '2026-03-01', '2026-12-15', 'Phase 1 - Foundation', 'Ongoing', 35),
  ('PRJ-2026-003', 'Northside Residential Tower',     'Quezon City, Metro Manila',         '20-story residential tower with amenities and retail podium',          'Golden Land Dev.',    62000000.00, '2026-06-01', '2028-03-31', 'Phase 1 - Foundation', 'Planning', 10),
  ('PRJ-2026-004', 'Highway 5 Extension',             'Bulacan - Pampanga',                'Extension of 12km highway with 3 interchanges',                       'DPWH Region III',     150000000.00,'2025-08-01', '2026-07-31', 'Phase 5 - Finishing',  'Completed', 100)
ON CONFLICT (code) DO NOTHING;

-- Project Members
INSERT INTO project_members (project_id, user_id, role) VALUES
  ('PRJ-2026-001', (SELECT id FROM users WHERE email = 'mike.j@sitepulse.com'),   'Lead Engineer'),
  ('PRJ-2026-001', (SELECT id FROM users WHERE email = 'sarah.c@sitepulse.com'),  'Member'),
  ('PRJ-2026-002', (SELECT id FROM users WHERE email = 'robert.m@sitepulse.com'), 'Lead Engineer'),
  ('PRJ-2026-002', (SELECT id FROM users WHERE email = 'mike.j@sitepulse.com'),   'Member'),
  ('PRJ-2026-003', (SELECT id FROM users WHERE email = 'sarah.c@sitepulse.com'),  'Lead Engineer')
ON CONFLICT (project_id, user_id) DO NOTHING;

-- Tasks
INSERT INTO tasks (task_name, phase, assignee_id, due_date, priority, status, manpower_needed, materials_required, site_instructions, project_id, progress_pct) VALUES
  ('Foundation Pouring - Block A',   'Phase 1 - Foundation', (SELECT id FROM users WHERE email = 'mike.j@sitepulse.com'),   '2026-09-01', 'High',   'In Progress', '15 workers', '200 bags cement, 50 cu.m gravel',       'Ensure proper curing for 7 days', (SELECT id FROM projects WHERE code = 'PRJ-2026-001'), 65),
  ('Steel Column Installation',      'Phase 2 - Structure',  (SELECT id FROM users WHERE email = 'sarah.c@sitepulse.com'),  '2026-09-15', 'High',   'Pending',     '12 workers', '80 steel columns, welding rods',         'Follow structural plan rev. 3',   (SELECT id FROM projects WHERE code = 'PRJ-2026-001'), 0),
  ('Rebar Tying - Deck Slab',        'Phase 1 - Foundation', (SELECT id FROM users WHERE email = 'robert.m@sitepulse.com'), '2026-09-10', 'Medium', 'In Progress', '10 workers', '5 tons rebar, tie wire',                'Use #16mm for main bars',         (SELECT id FROM projects WHERE code = 'PRJ-2026-002'), 40),
  ('Electrical Conduit Rough-In',    'Phase 3 - Electrical', (SELECT id FROM users WHERE email = 'mike.j@sitepulse.com'),   '2026-09-20', 'Medium', 'Pending',     '8 workers',  'PVC conduits, junction boxes, wiring',  'Coordinate with structural team', (SELECT id FROM projects WHERE code = 'PRJ-2026-001'), 0),
  ('Formwork Removal - Columns',     'Phase 2 - Structure',  (SELECT id FROM users WHERE email = 'sarah.c@sitepulse.com'),  '2026-08-25', 'Low',    'Completed',   '6 workers',  'None (labor only)',                     'Min 14-day curing before removal',(SELECT id FROM projects WHERE code = 'PRJ-2026-001'), 100),
  ('Site Grading & Excavation',      'Phase 1 - Foundation', (SELECT id FROM users WHERE email = 'robert.m@sitepulse.com'), '2026-08-20', 'High',   'Completed',   '20 workers', '2 excavators, dump trucks',             'Maintain 2% slope for drainage',  (SELECT id FROM projects WHERE code = 'PRJ-2026-002'), 100)
ON CONFLICT DO NOTHING;

-- Resources
INSERT INTO resources (name, supplier, category, quantity, unit, min_threshold, unit_price, project, status) VALUES
  ('Portland Cement',      'Eagle Cement Corp.',   'Material',  850,  'bags',  200, 250.00,   'Downtown Office Complex',    'In stock'),
  ('Deformed Steel Bars',  'SteelAsia Mfg.',       'Material',  320,  'pcs',   100, 1850.00,  'Downtown Office Complex',    'In stock'),
  ('Ready-Mix Concrete',   'Holcim Philippines',   'Material',  45,   'cu.m',  20,  5500.00,  'Riverside Bridge Renovation','In stock'),
  ('Excavator (CAT 320)',  'HeavyEquip Rentals',   'Equipment', 2,    'units', 1,   15000.00, 'Riverside Bridge Renovation','Available'),
  ('Tower Crane',          'Liebherr PH',          'Equipment', 1,    'unit',  1,   45000.00, 'Downtown Office Complex',    'Available'),
  ('Welding Machine',      'Lincoln Electric',     'Equipment', 4,    'units', 2,   8500.00,  'Downtown Office Complex',    'Available'),
  ('Fine Sand',            'Quarry Supplies Inc.', 'Material',  15,   'cu.m',  30,  1200.00,  'Northside Residential Tower','Low stock'),
  ('PPE Hard Hats',        'Safety First PH',      'Material',  8,    'pcs',   25,  350.00,   'Downtown Office Complex',    'Low stock')
ON CONFLICT DO NOTHING;

-- Documents
INSERT INTO documents (project_code, name, type, category) VALUES
  ('PRJ-2026-001', 'Structural Plan Rev.3',       'DWG', 'Design & Engineering'),
  ('PRJ-2026-001', 'Project Timeline',             'XLS', 'Project Management'),
  ('PRJ-2026-001', 'Safety Protocol Manual',       'PDF', 'Site Reference'),
  ('PRJ-2026-002', 'Bridge Load Analysis',         'PDF', 'Design & Engineering'),
  ('PRJ-2026-002', 'Material Procurement List',    'XLS', 'Project Management')
ON CONFLICT DO NOTHING;

-- Dashboard Stats
INSERT INTO dashboard_stats (label, value, trend, up, bg, clr, icon, sort_order) VALUES
  ('Active Projects',    '4',    '12%', TRUE,  '#EFF6FF', '#3B82F6', '📋', 1),
  ('Total Tasks',        '6',    '8%',  TRUE,  '#F0FDF4', '#22C55E', '✅', 2),
  ('Team Members',       '4',    '5%',  TRUE,  '#FFFBEB', '#F59E0B', '👷', 3),
  ('Issues Reported',    '2',    '3%',  FALSE, '#FEF2F2', '#EF4444', '⚠️', 4)
ON CONFLICT DO NOTHING;

-- Monitor Items
INSERT INTO monitor_items (label, checked, sort_order) VALUES
  ('Downtown Office Complex — Block A',     TRUE,  1),
  ('Riverside Bridge — South Abutment',     TRUE,  2),
  ('Northside Residential — Site Prep',     FALSE, 3),
  ('Highway 5 Ext. — Final Inspection',     TRUE,  4)
ON CONFLICT DO NOTHING;

-- RFIs
INSERT INTO rfis (label, is_urgent, sort_order) VALUES
  ('RFI-042: Column spacing clarification',     TRUE,  1),
  ('RFI-043: Rebar grade substitution',         TRUE,  2),
  ('RFI-044: Drainage pipe routing change',     TRUE,  3)
ON CONFLICT DO NOTHING;

-- Notes
INSERT INTO notes (label, status, cls, sort_order) VALUES
  ('Safety briefing — all hands 8 AM Mon',   'Action',    'action',    1),
  ('Concrete test results pending',          'Waiting',   'waiting',   2),
  ('Material delivery ETA: Aug 18',          'Info',      'info',      3),
  ('Weather alert: Rain expected Fri',       'Warning',   'warning',   4)
ON CONFLICT DO NOTHING;

-- Gauge Stats
INSERT INTO gauge_stats (v, l, c, sort_order) VALUES
  ('4',  'Total',     '#64748b', 1),
  ('2',  'Active',    '#3b82f6', 2),
  ('1',  'Completed', '#22c55e', 3),
  ('1',  'Planning',  '#f59e0b', 4)
ON CONFLICT DO NOTHING;

-- Progress Logs & Issues & Reports
DO $$
DECLARE
  eng_id UUID;
BEGIN
  SELECT id INTO eng_id FROM users WHERE email = 'mike.j@sitepulse.com' LIMIT 1;
  IF eng_id IS NOT NULL THEN
    INSERT INTO project_progress_logs (project_code, phase, progress_pct, summary, work_completed, manpower, weather, logged_by)
    VALUES
      ('PRJ-2026-001', 'Phase 2 - Structure', 48, 'Level 4 slab curing completed and Level 5 formwork commenced.', 'Completed beam reinforcements and electrical conduit rough-ins for Level 4.', 32, 'Sunny, 31°C', eng_id),
      ('PRJ-2026-001', 'Phase 2 - Structure', 52, 'Pouring concrete for columns C1-C8 on Level 5.', 'Inspection passed by Structural QA Engineer.', 35, 'Partly Cloudy, 29°C', eng_id);

    INSERT INTO project_issues (project_code, title, category, priority, location, description, status, reported_by, assigned_to)
    VALUES
      ('PRJ-2026-001', 'Concrete aggregate moisture variance', 'Quality Defect', 'Medium', 'Batching Plant / Site Bay 3', 'High moisture content detected in sand aggregates affecting slump test.', 'In Progress', eng_id, eng_id),
      ('PRJ-2026-001', 'Scaffolding safety net tear near Grid 4', 'Safety Hazard', 'High', 'Exterior West Facade L4', 'Wind damage tore perimeter debris netting on Level 4 west section.', 'Open', eng_id, eng_id),
      ('PRJ-2026-001', 'HVAC duct routing conflict with beam B-12', 'Design Clash', 'Low', 'Basement 1 Mech Room', 'Duct clash resolved by re-routing around perimeter shear wall.', 'Resolved', eng_id, eng_id);

    INSERT INTO project_reports (project_code, title, report_type, report_date, prepared_by, summary, key_activities, issues_highlighted, manpower_count, equipment_on_site, weather)
    VALUES
      ('PRJ-2026-001', 'Daily Site Quality Log - Phase 2', 'Daily Site Log', CURRENT_DATE, eng_id, 'Routine quality inspection on Level 4 structural framing and rebar density.', 'Checked beam tie-ins, performed slump tests on ready-mix concrete batches.', 'Minor aggregate moisture variance noted and corrected.', 34, '1x Tower Crane, 2x Concrete Pumps, 1x Backhoe', 'Sunny'),
      ('PRJ-2026-001', 'Weekly Milestone Inspection Report', 'Milestone Report', CURRENT_DATE, eng_id, 'Weekly milestone audit covering Phase 2 foundation transition to superstructure.', 'Completed Level 3 deck inspection and verified structural rebar compliance.', 'No critical non-conformance reported.', 40, '1x Tower Crane, 1x Generator Set', 'Clear');
  END IF;
END $$;

-- Notifications
INSERT INTO notifications (title, message, audience, created_by)
VALUES
  ('Welcome to SitePulse', 'Welcome to the SitePulse Construction Management platform. Review your assigned tasks and daily logs.', 'all', (SELECT id FROM users WHERE email = 'admin@sitepulse.com'));

-- Time Logs
INSERT INTO time_logs (project_name, engineer_name, date, work_on_site, supervisors, sub_contractors, total_work_hours, weather, temperature, work_completed, materials_delivered, equipment_used, additional_notes, has_incident)
VALUES
  ('Downtown Office Complex', 'Mike Johnson', CURRENT_DATE, 25, 3, 5, '8 hrs', 'Sunny', '31°C', 'Level 4 beam reinforcements and rebar installation.', '200 bags Portland Cement', '1x Tower Crane, 2x Concrete Mixers', 'All safety protocols followed.', FALSE);
