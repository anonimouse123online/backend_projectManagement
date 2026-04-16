// controllers/dashboardController.js
const pool = require('../db');

// ─── STATS ────────────────────────────────────────────────
exports.getStats = async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT label, value, trend, up, bg, clr, icon FROM dashboard_stats ORDER BY sort_order'
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('getStats error:', err);
    res.status(500).json({ error: 'Failed to fetch stats.' });
  }
};

// ─── PROJECTS ─────────────────────────────────────────────
exports.getProjects = async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT
         name,
         client AS pm,
         TO_CHAR(end_date, 'Mon DD, YYYY') AS date,
         status,
         COALESCE(phase, '—') AS prog
       FROM projects
       ORDER BY created_at DESC`
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('getProjects error:', err);
    res.status(500).json({ error: 'Failed to fetch projects.' });
  }
};

// ─── MONITOR ITEMS ────────────────────────────────────────
exports.getMonitorItems = async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT label, checked FROM monitor_items ORDER BY sort_order'
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('getMonitorItems error:', err);
    res.status(500).json({ error: 'Failed to fetch monitor items.' });
  }
};

// ─── URGENT RFIs ──────────────────────────────────────────
exports.getRFIs = async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT label FROM rfis WHERE is_urgent = TRUE ORDER BY sort_order'
    );
    res.json({ success: true, data: rows.map(r => r.label) });
  } catch (err) {
    console.error('getRFIs error:', err);
    res.status(500).json({ error: 'Failed to fetch RFIs.' });
  }
};

// ─── NOTES ────────────────────────────────────────────────
exports.getNotes = async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT label, status, cls FROM notes ORDER BY sort_order'
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('getNotes error:', err);
    res.status(500).json({ error: 'Failed to fetch notes.' });
  }
};

// ─── GAUGE STATS ──────────────────────────────────────────
exports.getGaugeStats = async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT v, l, c FROM gauge_stats ORDER BY sort_order'
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('getGaugeStats error:', err);
    res.status(500).json({ error: 'Failed to fetch gauge stats.' });
  }
};