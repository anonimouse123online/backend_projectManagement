const pool = require('../db');

async function migrate() {
  console.log('🚀 Starting Action tables migration...');

  await pool.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS progress_pct INTEGER DEFAULT 35;`);

  await pool.query(`
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
  `);

  await pool.query(`
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
  `);

  await pool.query(`
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
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_progress_project_code ON project_progress_logs(project_code);
    CREATE INDEX IF NOT EXISTS idx_issues_project_code ON project_issues(project_code);
    CREATE INDEX IF NOT EXISTS idx_reports_project_code ON project_reports(project_code);
  `);

  // Fetch engineer user
  const engineerRes = await pool.query("SELECT id FROM users WHERE email = 'mike.j@sitepulse.com' LIMIT 1");
  const engineerId = engineerRes.rows[0]?.id;

  if (engineerId) {
    const cp = await pool.query("SELECT count(*) FROM project_progress_logs WHERE project_code = 'PRJ-2026-001'");
    if (parseInt(cp.rows[0].count) === 0) {
      await pool.query(`
        INSERT INTO project_progress_logs (project_code, phase, progress_pct, summary, work_completed, manpower, weather, logged_by)
        VALUES ('PRJ-2026-001', 'Phase 2 - Structure', 48, 'Level 4 slab curing completed and Level 5 formwork commenced.', 'Completed beam reinforcements and electrical conduit rough-ins for Level 4.', 32, 'Sunny, 31°C', $1)
      `, [engineerId]);

      await pool.query(`
        INSERT INTO project_progress_logs (project_code, phase, progress_pct, summary, work_completed, manpower, weather, logged_by)
        VALUES ('PRJ-2026-001', 'Phase 2 - Structure', 52, 'Pouring concrete for columns C1-C8 on Level 5.', 'Inspection passed by Structural QA Engineer.', 35, 'Partly Cloudy, 29°C', $1)
      `, [engineerId]);
    }

    const ci = await pool.query("SELECT count(*) FROM project_issues WHERE project_code = 'PRJ-2026-001'");
    if (parseInt(ci.rows[0].count) === 0) {
      await pool.query(`
        INSERT INTO project_issues (project_code, title, category, priority, location, description, status, reported_by, assigned_to)
        VALUES ('PRJ-2026-001', 'Concrete aggregate moisture variance', 'Quality Defect', 'Medium', 'Batching Plant / Site Bay 3', 'High moisture content detected in sand aggregates affecting slump test.', 'In Progress', $1, $1)
      `, [engineerId]);

      await pool.query(`
        INSERT INTO project_issues (project_code, title, category, priority, location, description, status, reported_by, assigned_to)
        VALUES ('PRJ-2026-001', 'Scaffolding safety net tear near Grid 4', 'Safety Hazard', 'High', 'Exterior West Facade L4', 'Wind damage tore perimeter debris netting on Level 4 west section.', 'Open', $1, $1)
      `, [engineerId]);

      await pool.query(`
        INSERT INTO project_issues (project_code, title, category, priority, location, description, status, reported_by, assigned_to)
        VALUES ('PRJ-2026-001', 'HVAC duct routing conflict with beam B-12', 'Design Clash', 'Low', 'Basement 1 Mech Room', 'Duct clash resolved by re-routing around perimeter shear wall.', 'Resolved', $1, $1)
      `, [engineerId]);
    }

    const cr = await pool.query("SELECT count(*) FROM project_reports WHERE project_code = 'PRJ-2026-001'");
    if (parseInt(cr.rows[0].count) === 0) {
      await pool.query(`
        INSERT INTO project_reports (project_code, title, report_type, report_date, prepared_by, summary, key_activities, issues_highlighted, manpower_count, equipment_on_site, weather)
        VALUES ('PRJ-2026-001', 'Daily Site Quality Log - Phase 2', 'Daily Site Log', CURRENT_DATE, $1, 'Routine quality inspection on Level 4 structural framing and rebar density.', 'Checked beam tie-ins, performed slump tests on ready-mix concrete batches.', 'Minor aggregate moisture variance noted and corrected.', 34, '1x Tower Crane, 2x Concrete Pumps, 1x Backhoe', 'Sunny')
      `, [engineerId]);

      await pool.query(`
        INSERT INTO project_reports (project_code, title, report_type, report_date, prepared_by, summary, key_activities, issues_highlighted, manpower_count, equipment_on_site, weather)
        VALUES ('PRJ-2026-001', 'Weekly Milestone Inspection Report', 'Milestone Report', CURRENT_DATE, $1, 'Weekly milestone audit covering Phase 2 foundation transition to superstructure.', 'Completed Level 3 deck inspection and verified structural rebar compliance.', 'No critical non-conformance reported.', 40, '1x Tower Crane, 1x Generator Set', 'Clear')
      `, [engineerId]);
    }
  }

  console.log('✅ Action tables migrated & seeded successfully');
  process.exit(0);
}

migrate().catch(e => {
  console.error('Migration error:', e);
  process.exit(1);
});
