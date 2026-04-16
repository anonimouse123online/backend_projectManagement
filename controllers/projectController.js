const pool = require('../db');
const projectService = require('../services/projectService');

const getAllProjects = async (req, res) => {
  try {
    const { status } = req.query;
    const projects = await projectService.getAll(status);
    res.json({ success: true, data: projects });
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch projects', error: error.message });
  }
};

const getProjectByCode = async (req, res) => {
  try {
    const { code } = req.params;
    const project = await projectService.getByCode(code);
    if (!project) return res.status(404).json({ message: `Project ${code} not found.` });
    res.json({ success: true, data: project });
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch project', error: error.message });
  }
};

const updateProjectStatus = async (req, res) => {
  try {
    const { code } = req.params;
    const { status } = req.body;

    const allowed = ['Planning', 'Ongoing', 'Completed'];
    if (!allowed.includes(status)) {
      return res.status(400).json({ message: `Invalid status. Must be one of: ${allowed.join(', ')}` });
    }

    const { rows } = await pool.query(
      `UPDATE projects SET status = $1 WHERE code = $2
       RETURNING id, code, name, status`,
      [status, code]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: `Project ${code} not found.` });
    }

    res.json({ success: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ message: 'Failed to update project status', error: err.message });
  }
};

const createProject = async (req, res) => {
  try {
    const { code, name, location, scope, client, budget, start_date, end_date, phase } = req.body;

    // Validate required fields
    if (!code || !name || !location || !scope || !client || !budget || !start_date || !end_date || !phase) {
      return res.status(400).json({ message: 'All fields are required.' });
    }

    const { rows } = await pool.query(
      `INSERT INTO projects
        (code, name, location, scope, client, budget, start_date, end_date, phase, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'Planning')
       RETURNING
         id, code, name, location, scope, client, budget, phase, status,
         TO_CHAR(start_date, 'YYYY-MM-DD') AS start_date,
         TO_CHAR(end_date,   'YYYY-MM-DD') AS end_date`,
      [code, name, location, scope, client, budget, start_date, end_date, phase]
    );

    res.status(201).json({ success: true, data: rows[0] });
  } catch (err) {
    // Duplicate project code
    if (err.code === '23505') {
      return res.status(409).json({ message: `Project code "${req.body.code}" already exists.` });
    }
    res.status(500).json({ message: 'Failed to create project', error: err.message });
  }
};

module.exports = { getAllProjects, getProjectByCode, createProject };
