const pool = require('../db');

exports.getTasks = async (req, res) => {
  try {
    const { project_id } = req.query; // optional filter

    const { rows } = await pool.query(
      `SELECT
         t.id,
         t.task_name,
         t.phase,
         t.project_id,
         p.name        AS project_name,
         p.code        AS project_code,
         u.full_name   AS assignee,
         u.id          AS assignee_id,
         TO_CHAR(t.due_date, 'Mon DD, YYYY') AS due_date,
         t.priority,
         t.status,
         t.manpower_needed,
         t.materials_required,
         t.site_instructions
       FROM tasks t
       LEFT JOIN users    u ON u.id = t.assignee_id
       LEFT JOIN projects p ON p.id = t.project_id
       WHERE ($1::uuid IS NULL OR t.project_id = $1::uuid)
       ORDER BY t.phase, t.created_at DESC`,
      [project_id || null]
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('getTasks error:', err);
    res.status(500).json({ error: 'Failed to fetch tasks.' });
  }
};

exports.getTaskById = async (req, res) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query(
      `SELECT
         t.id,
         t.task_name,
         t.phase,
         u.full_name  AS assignee,
         TO_CHAR(t.due_date, 'Mon DD, YYYY') AS due_date,
         t.priority,
         t.status,
         t.manpower_needed,
         t.materials_required,
         t.site_instructions
      FROM tasks t
      LEFT JOIN users u ON u.id = t.assignee_id      -- ← changed
      WHERE t.id = $1`,
      [id]
    );
    if (rows.length === 0)
      return res.status(404).json({ error: 'Task not found.' });
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('getTaskById error:', err);
    res.status(500).json({ error: 'Failed to fetch task.' });
  }
};

exports.updateTaskStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const allowed = ['Pending', 'In Progress', 'Completed'];
    if (!allowed.includes(status))
      return res.status(400).json({ error: 'Invalid status value.' });

    const { rows } = await pool.query(
      `UPDATE tasks
       SET status = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [status, id]
    );
    if (rows.length === 0)
      return res.status(404).json({ error: 'Task not found.' });
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('updateTaskStatus error:', err);
    res.status(500).json({ error: 'Failed to update task status.' });
  }
};

exports.createTask = async (req, res) => {
  try {
    const {
      taskName, phase, assigneeId, dueDate, priority,
      manpowerNeeded, materialsRequired, siteInstructions,
      projectId   // ← new
    } = req.body;

    const { rows } = await pool.query(
      `INSERT INTO tasks
         (task_name, phase, assignee_id, due_date, priority,
          manpower_needed, materials_required, site_instructions,
          project_id, status)
       VALUES ($1, $2, $3::uuid, $4, $5, $6, $7, $8, $9, 'Pending')
       RETURNING *`,
      [taskName, phase, assigneeId, dueDate, priority,
       manpowerNeeded, materialsRequired, siteInstructions, projectId || null]
    );
    res.status(201).json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('createTask error:', err);
    res.status(500).json({ error: 'Failed to create task.' });
  }
};
exports.getUsers = async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT
         u.id,
         u.full_name,
         u.email,
         u.role,
         COUNT(t.id) FILTER (WHERE t.status != 'Completed') AS current_tasks
       FROM users u
       LEFT JOIN tasks t ON t.assignee_id = u.id
       WHERE u.is_active = TRUE
       GROUP BY u.id
       ORDER BY u.full_name ASC`
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('getUsers error:', err);
    res.status(500).json({ error: 'Failed to fetch users.' });
  }
};