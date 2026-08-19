  // controllers/dashboardController.js
const pool = require('../db');

// ─── STATS (Live Dynamic Aggregation) ──────────────────────
exports.getStats = async (req, res) => {
  try {
    const { range } = req.query;

    const [projRes, taskRes, userRes, issueRes] = await Promise.all([
      pool.query("SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE status = 'Ongoing' OR status = 'Planning') AS active FROM projects"),
      pool.query("SELECT COUNT(*) AS total FROM tasks"),
      pool.query("SELECT COUNT(*) AS total FROM users"),
      pool.query("SELECT COUNT(*) AS total FROM project_issues WHERE status != 'Resolved'"),
    ]);

    const activeProjects = parseInt(projRes.rows[0]?.active ?? projRes.rows[0]?.total ?? 0);
    const totalTasks     = parseInt(taskRes.rows[0]?.total ?? 0);
    const teamMembers    = parseInt(userRes.rows[0]?.total ?? 0);
    const issuesReported = parseInt(issueRes.rows[0]?.total ?? 0);

    const stats = [
      {
        label: 'Active Projects',
        value: String(activeProjects),
        trend: activeProjects > 0 ? '+100%' : '0%',
        up: activeProjects > 0,
        bg: '#EFF6FF',
        clr: '#3B82F6',
        icon: '📋'
      },
      {
        label: 'Total Tasks',
        value: String(totalTasks),
        trend: totalTasks > 0 ? '+100%' : '0%',
        up: totalTasks > 0,
        bg: '#F0FDF4',
        clr: '#22C55E',
        icon: '✅'
      },
      {
        label: 'Team Members',
        value: String(teamMembers),
        trend: teamMembers > 0 ? '+100%' : '0%',
        up: teamMembers > 0,
        bg: '#FFFBEB',
        clr: '#F59E0B',
        icon: '👥'
      },
      {
        label: 'Issues Reported',
        value: String(issuesReported),
        trend: issuesReported > 0 ? '+100%' : '0%',
        up: false,
        bg: '#FEF2F2',
        clr: '#EF4444',
        icon: '⚠️'
      }
    ];

    res.json({ success: true, data: stats, range: range || 'Last 30 days' });
  } catch (err) {
    console.error('getStats error:', err);
    res.status(500).json({ error: 'Failed to fetch stats.' });
  }
};

// ─── PROJECTS ─────────────────────────────────────────────
exports.getProjects = async (req, res) => {
  try {
    const { project, pm, status, search } = req.query;
    const conditions = [];
    const params = [];

    if (project && project !== 'All') {
      params.push(project);
      conditions.push(`name ILIKE $${params.length}`);
    }

    if (pm && pm !== 'All') {
      params.push(pm);
      conditions.push(`client ILIKE $${params.length}`);
    }

    if (status && status !== 'All') {
      params.push(status);
      conditions.push(`status ILIKE $${params.length}`);
    }

    if (search) {
      params.push(`%${search}%`);
      conditions.push(`(name ILIKE $${params.length} OR client ILIKE $${params.length} OR phase ILIKE $${params.length})`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const { rows } = await pool.query(
      `SELECT
         id,
         code,
         name,
         client AS pm,
         TO_CHAR(end_date, 'Mon DD, YYYY') AS date,
         status,
         COALESCE(phase, '—') AS prog
       FROM projects
       ${where}
       ORDER BY created_at DESC`,
      params
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
    const { search } = req.query;
    let query = 'SELECT label, checked FROM monitor_items';
    const params = [];

    if (search) {
      params.push(`%${search}%`);
      query += ` WHERE label ILIKE $1`;
    }

    query += ' ORDER BY sort_order';

    const { rows } = await pool.query(query, params);
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('getMonitorItems error:', err);
    res.status(500).json({ error: 'Failed to fetch monitor items.' });
  }
};

// ─── URGENT RFIs ──────────────────────────────────────────
exports.getRFIs = async (req, res) => {
  try {
    const { search } = req.query;
    let query = 'SELECT label FROM rfis WHERE is_urgent = TRUE';
    const params = [];

    if (search) {
      params.push(`%${search}%`);
      query += ' AND label ILIKE $1';
    }

    query += ' ORDER BY sort_order';

    const { rows } = await pool.query(query, params);
    res.json({ success: true, data: rows.map(r => r.label) });
  } catch (err) {
    console.error('getRFIs error:', err);
    res.status(500).json({ error: 'Failed to fetch RFIs.' });
  }
};

// ─── NOTES ────────────────────────────────────────────────
exports.getNotes = async (req, res) => {
  try {
    const { search } = req.query;
    let query = 'SELECT label, status, cls FROM notes';
    const params = [];

    if (search) {
      params.push(`%${search}%`);
      query += ' WHERE label ILIKE $1';
    }

    query += ' ORDER BY sort_order';

    const { rows } = await pool.query(query, params);
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('getNotes error:', err);
    res.status(500).json({ error: 'Failed to fetch notes.' });
  }
};

// ─── GAUGE STATS (Live dynamic metrics from tasks/projects) ───────────
exports.getGaugeStats = async (req, res) => {
  try {
    const { category } = req.query;
    const taskConditions = [];
    const taskParams = [];

    if (category && category !== 'All') {
      taskParams.push(`%${category}%`);
      taskConditions.push(`phase ILIKE $${taskParams.length}`);
    }

    const taskWhere = taskConditions.length ? `WHERE ${taskConditions.join(' AND ')}` : '';

    const statsRes = await pool.query(`
      SELECT
        COUNT(*)                                                                      AS total,
        COUNT(*) FILTER (WHERE status ILIKE 'in%progress' OR status ILIKE 'ongoing') AS active_count,
        COUNT(*) FILTER (WHERE status ILIKE 'completed')                              AS done_count,
        COUNT(*) FILTER (WHERE status ILIKE 'delayed' OR status ILIKE 'blocked')     AS delayed_count,
        COUNT(*) FILTER (WHERE status ILIKE 'pending')                                AS pending_count
      FROM tasks
      ${taskWhere}
    `, taskParams);

    const { active_count, done_count, delayed_count, pending_count } = statsRes.rows[0];

    const data = [
      { v: String(active_count || 0), l: 'Active', c: '#2563eb' },
      { v: String(done_count || 0), l: 'Done', c: '#16a34a' },
      { v: String(delayed_count || 0), l: 'Delayed', c: '#ef4444' },
      { v: String(pending_count || 0), l: 'Pending', c: '#f59e0b' },
    ];

    res.json({ success: true, data });
  } catch (err) {
    console.error('getGaugeStats error:', err);
    res.status(500).json({ error: 'Failed to fetch gauge stats.' });
  }
};

// ─── OVERALL PROGRESS (computed from real weighted data with optional category filter) ───────────
exports.getOverallProgress = async (req, res) => {
  try {
    const { category } = req.query;
    const taskConditions = [];
    const taskParams = [];

    if (category && category !== 'All') {
      taskParams.push(`%${category}%`);
      taskConditions.push(`phase ILIKE $${taskParams.length}`);
    }

    const taskWhere = taskConditions.length ? `WHERE ${taskConditions.join(' AND ')}` : '';

    const taskStats = await pool.query(`
      SELECT
        COUNT(*)                                                                      AS total,
        COUNT(*) FILTER (WHERE status ILIKE 'completed')                              AS completed,
        COUNT(*) FILTER (WHERE status ILIKE 'in%progress' OR status ILIKE 'ongoing')  AS in_progress,
        COUNT(*) FILTER (WHERE status ILIKE 'pending')                                AS pending,
        COALESCE(ROUND(AVG(COALESCE(progress_pct, 0))), 0)                           AS weighted_progress
      FROM tasks
      ${taskWhere}
    `, taskParams);

    const { total, completed, in_progress, pending, weighted_progress } = taskStats.rows[0];
    const totalNum = parseInt(total) || 0;
    const percentage = parseInt(weighted_progress) || 0;

    // Also compute project-level stats
    const projectStats = await pool.query(`
      SELECT
        COUNT(*)                                      AS total,
        COUNT(*) FILTER (WHERE status = 'Ongoing')    AS active,
        COUNT(*) FILTER (WHERE status = 'Completed')  AS completed,
        COUNT(*) FILTER (WHERE status = 'Planning')   AS planning,
        COALESCE(ROUND(AVG(COALESCE(progress_pct, 0))), 0) AS avg_proj_progress
      FROM projects
    `);

    const projects = projectStats.rows[0];

    res.json({
      success: true,
      data: {
        overallProgress: percentage,
        category: category || 'All',
        tasks: {
          total: totalNum,
          completed: parseInt(completed) || 0,
          in_progress: parseInt(in_progress) || 0,
          pending: parseInt(pending) || 0,
        },
        projects: {
          total:     parseInt(projects.total) || 0,
          active:    parseInt(projects.active) || 0,
          completed: parseInt(projects.completed) || 0,
          planning:  parseInt(projects.planning) || 0,
          avgProgress: parseInt(projects.avg_proj_progress) || 0,
        },
      },
    });
  } catch (err) {
    console.error('getOverallProgress error:', err);
    res.status(500).json({ error: 'Failed to compute progress.' });
  }
};