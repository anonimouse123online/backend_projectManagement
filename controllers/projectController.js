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

const createProject = async (req, res) => {
  try {
    const { code, name, location, client, due_date, status, progress } = req.body;
    const { rows } = await pool.query(
      `INSERT INTO projects (code, name, location, client, due_date, status, progress)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, code, name, location, client,
         TO_CHAR(due_date, 'Mon DD, YYYY') AS due_date, status, progress`,
      [code, name, location, client, due_date, status, progress]
    );
    res.status(201).json({ success: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ message: 'Failed to create project', error: err.message });
  }
};

module.exports = { getAllProjects, getProjectByCode, createProject };