const pool = require('../db');

// GET /timelogs
exports.getTimelogs = async (req, res) => {
  try {
    const { search, date, engineer } = req.query;
    const conditions = [];
    const params = [];

    if (search) {
      params.push(`%${search}%`);
      conditions.push(`(p.name ILIKE $${params.length} OR pl.project_code ILIKE $${params.length} OR u.full_name ILIKE $${params.length} OR pl.summary ILIKE $${params.length} OR pl.work_completed ILIKE $${params.length})`);
    }

    if (date) {
      params.push(date);
      conditions.push(`TO_CHAR(pl.created_at, 'YYYY-MM-DD') = $${params.length}`);
    }

    if (engineer && engineer !== 'All Engineers') {
      params.push(engineer);
      conditions.push(`u.full_name ILIKE $${params.length}`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const { rows } = await pool.query(`
      SELECT
        pl.id,
        pl.project_code,
        COALESCE(p.name, pl.project_code) AS project_name,
        COALESCE(u.full_name, 'Site Engineer') AS engineer_name,
        TO_CHAR(pl.created_at, 'YYYY-MM-DD') AS date,
        pl.phase,
        pl.progress_pct,
        pl.summary,
        COALESCE(pl.work_completed, pl.summary) AS work_completed,
        COALESCE(pl.manpower, 0) AS work_on_site,
        COALESCE(pl.weather, 'Sunny') AS weather,
        pl.created_at
      FROM project_progress_logs pl
      LEFT JOIN projects p ON p.code = pl.project_code
      LEFT JOIN users u ON u.id = pl.logged_by
      ${where}
      ORDER BY pl.created_at DESC
    `, params);

    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('getTimelogs error:', err);
    res.status(500).json({ error: 'Failed to fetch time logs.' });
  }
};
