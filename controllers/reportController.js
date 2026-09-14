const pool = require('../db');
const { generateAIReport } = require('../services/aiService');
const { processPendingReports } = require('../services/schedulerService');

// ─── GET ALL REPORTS ──────────────────────────────────────────────────────────
// GET /reports?project_code=xxx&date=2026-08-20
exports.getReports = async (req, res) => {
  try {
    const { project_code, project_id, date } = req.query;

    const { rows } = await pool.query(
      `SELECT
         pr.id,
         pr.project_code,
         pr.title,
         pr.report_type,
         pr.report_date,
         pr.summary,
         pr.key_activities,
         pr.issues_highlighted,
         pr.manpower_count,
         pr.equipment_on_site,
         pr.weather,
         pr.status,
         pr.created_at,
         u.full_name AS prepared_by_name,
         u.role      AS prepared_by_role,
         p.name      AS project_name
       FROM project_reports pr
       LEFT JOIN users u ON u.id = pr.prepared_by
       LEFT JOIN projects p ON p.code = pr.project_code
       WHERE ($1::text IS NULL OR pr.project_code = $1::text)
         AND ($2::date IS NULL OR pr.report_date = $2::date)
       ORDER BY pr.report_date DESC, pr.created_at DESC`,
      [project_code || project_id || null, date || null]
    );

    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('getReports error:', err);
    res.status(500).json({ error: 'Failed to fetch reports.', details: err.message });
  }
};

// ─── GET SINGLE REPORT BY ID ──────────────────────────────────────────────────
// GET /api/reports/:id
exports.getReportById = async (req, res) => {
  try {
    const { id } = req.params;

    const { rows } = await pool.query(
      `SELECT
         r.id,
         r.report_date,
         r.report_text,
         r.observations,
         r.status,
         r.created_at,
         t.task_name,
         t.phase,
         p.name       AS project_name,
         u.full_name  AS assignee
       FROM reports r
       JOIN tasks    t ON t.id = r.task_id
       LEFT JOIN projects p ON p.id = t.project_id
       LEFT JOIN users    u ON u.id = t.assignee_id
       WHERE r.id = $1`,
      [id]
    );

    if (rows.length === 0)
      return res.status(404).json({ error: 'Report not found.' });

    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('getReportById error:', err);
    res.status(500).json({ error: 'Failed to fetch report.' });
  }
};

// ─── GET REPORTS FOR A SPECIFIC TASK ─────────────────────────────────────────
// GET /api/reports/task/:taskId
exports.getReportsByTask = async (req, res) => {
  try {
    const { taskId } = req.params;

    const { rows } = await pool.query(
      `SELECT
         r.id,
         r.report_date,
         r.report_text,
         r.observations,
         r.status,
         r.created_at
       FROM reports r
       WHERE r.task_id = $1
       ORDER BY r.report_date DESC`,
      [taskId]
    );

    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('getReportsByTask error:', err);
    res.status(500).json({ error: 'Failed to fetch reports for task.' });
  }
};

// ─── MANUALLY TRIGGER BATCH PROCESSING (for testing) ─────────────────────────
// POST /api/reports/process-now
exports.processReportsNow = async (req, res) => {
  try {
    res.json({
      success: true,
      message: 'Batch report processing started. Check server logs for progress.',
    });

    // Run in background
    processPendingReports();
  } catch (err) {
    console.error('processReportsNow error:', err);
    res.status(500).json({ error: 'Failed to trigger batch processing.' });
  }
};