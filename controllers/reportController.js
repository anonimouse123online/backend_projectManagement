const pool = require('../db');
const { generateAIReport } = require('../services/aiService');
const { processPendingReports } = require('../services/schedulerService');

// ─── GET ALL REPORTS ──────────────────────────────────────────────────────────
// GET /api/reports?project_id=xxx&date=2025-04-19
exports.getReports = async (req, res) => {
  try {
    const { project_id, date } = req.query;

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
       WHERE ($1::uuid IS NULL OR t.project_id = $1::uuid)
         AND ($2::date IS NULL OR r.report_date = $2::date)
       ORDER BY r.report_date DESC, t.task_name ASC`,
      [project_id || null, date || null]
    );

    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('getReports error:', err);
    res.status(500).json({ error: 'Failed to fetch reports.' });
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