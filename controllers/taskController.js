const pool = require('../db');

exports.getTasks = async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT
         id,
         task_name,
         phase,
         assignee,
         TO_CHAR(due_date, 'Mon DD, YYYY') AS due_date,
         priority,
         status,
         manpower_needed,
         materials_required,
         site_instructions
       FROM tasks
       ORDER BY phase, created_at DESC`
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('getTasks error:', err);
    res.status(500).json({ error: 'Failed to fetch tasks.' });
  }
};

exports.createTask = async (req, res) => {
  try {
    const {
      taskName,
      phase,
      assignee,
      dueDate,
      priority,
      manpowerNeeded,
      materialsRequired,
      siteInstructions
    } = req.body;

    const { rows } = await pool.query(
      `INSERT INTO tasks
         (task_name, phase, assignee, due_date, priority, manpower_needed, materials_required, site_instructions, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'Pending')
       RETURNING *`,
      [taskName, phase, assignee, dueDate, priority, manpowerNeeded, materialsRequired, siteInstructions]
    );

    res.status(201).json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('createTask error:', err);
    res.status(500).json({ error: 'Failed to create task.' });
  }
};