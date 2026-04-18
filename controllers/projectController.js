const pool = require('../db');
const projectService = require('../services/projectService');
const crypto = require('crypto');

// Helper — generates e.g. "A3F9-XK12"
const generateInviteCode = () => {
  const part = () => crypto.randomBytes(2).toString('hex').toUpperCase();
  return `${part()}-${part()}`;
};

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
    if (err.code === '23505') {
      return res.status(409).json({ message: `Project code "${req.body.code}" already exists.` });
    }
    res.status(500).json({ message: 'Failed to create project', error: err.message });
  }
};

// POST /projects/:code/generate-code
const generateProjectCode = async (req, res) => {
  const { code } = req.params;

  try {
    const project = await pool.query(
      'SELECT id FROM projects WHERE code = $1',
      [code]
    );
    if (project.rows.length === 0)
      return res.status(404).json({ message: `Project ${code} not found.` });

    let inviteCode;
    let isUnique = false;
    while (!isUnique) {
      inviteCode = generateInviteCode();
      const check = await pool.query(
        'SELECT id FROM project_invite_codes WHERE code = $1',
        [inviteCode]
      );
      isUnique = check.rows.length === 0;
    }

    await pool.query(
      `INSERT INTO project_invite_codes (project_id, code, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '7 days')`,
      [code, inviteCode]
    );

    res.json({ success: true, code: inviteCode });
  } catch (err) {
    res.status(500).json({ message: 'Failed to generate code', error: err.message });
  }
};

// POST /projects/join
const joinProject = async (req, res) => {
  const { invite_code, user_name } = req.body;

  if (!user_name) return res.status(400).json({ message: 'user_name is required' });

  try {
    const { rows } = await pool.query(
      `SELECT * FROM project_invite_codes
       WHERE code = $1 AND used = FALSE AND expires_at > NOW()`,
      [invite_code]
    );

    if (rows.length === 0)
      return res.status(400).json({ message: 'Invalid or expired invite code.' });

    const invite = rows[0];

    const already = await pool.query(
      `SELECT id FROM project_members WHERE project_id = $1 AND user_name = $2`,
      [invite.project_id, user_name]
    );
    if (already.rows.length > 0)
      return res.status(409).json({ message: 'You are already a member of this project.' });

    await pool.query(
      `INSERT INTO project_members (project_id, user_name, role)
       VALUES ($1, $2, 'Member')`,
      [invite.project_id, user_name]
    );

    await pool.query(
      `UPDATE project_invite_codes SET used = TRUE, used_at = NOW() WHERE id = $1`,
      [invite.id]
    );

    res.json({
      success: true,
      message: 'Successfully joined the project.',
      project_id: invite.project_id,
    });
  } catch (err) {
    res.status(500).json({ message: 'Failed to join project', error: err.message });
  }
};

// GET /projects/:code/active-code
const getActiveCode = async (req, res) => {
  const { code } = req.params;

  try {
    const { rows } = await pool.query(
      `SELECT code, expires_at FROM project_invite_codes
       WHERE project_id = $1 AND used = FALSE AND expires_at > NOW()
       ORDER BY created_at DESC
       LIMIT 1`,
      [code]
    );

    if (rows.length === 0) {
      return res.json({ success: true, code: null });
    }

    res.json({ success: true, code: rows[0].code, expires_at: rows[0].expires_at });
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch active code', error: err.message });
  }
};

// GET /projects/joined?user_name=John
const getJoinedProjects = async (req, res) => {
  const { user_name } = req.query;
  if (!user_name) return res.status(400).json({ message: 'user_name is required' });

  try {
    const { rows } = await pool.query(
      `SELECT p.code, p.name, p.status, p.phase
       FROM project_members pm
       JOIN projects p ON p.code = pm.project_id
       WHERE pm.user_name = $1
       ORDER BY pm.joined_at DESC`,
      [user_name]
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch joined projects', error: err.message });
  }
};

// GET /projects/:code/available-members
const getAvailableMembers = async (req, res) => {
  const { code } = req.params;

  try {
    const project = await pool.query(
      'SELECT id FROM projects WHERE code = $1',
      [code]
    );
    if (project.rows.length === 0)
      return res.status(404).json({ message: `Project ${code} not found.` });

    const { rows } = await pool.query(
      `SELECT u.id, u.full_name AS name, u.email, u.role
       FROM users u
       WHERE u.full_name NOT IN (
         SELECT pm.user_name
         FROM project_members pm
         WHERE pm.project_id = $1
       )
       AND u.is_active = TRUE`,
      [code]
    );

    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch available members', error: err.message });
  }
};

// POST /projects/:code/members
const addMember = async (req, res) => {
  const { code } = req.params;
  const { userId } = req.body;

  if (!userId) return res.status(400).json({ message: 'userId is required' });

  try {
    const userRes = await pool.query(
      'SELECT full_name FROM users WHERE id = $1',
      [userId]
    );
    if (userRes.rows.length === 0)
      return res.status(404).json({ message: 'User not found.' });

    const user_name = userRes.rows[0].full_name;

    const projectRes = await pool.query(
      'SELECT id FROM projects WHERE code = $1',
      [code]
    );
    if (projectRes.rows.length === 0)
      return res.status(404).json({ message: `Project ${code} not found.` });

    const already = await pool.query(
      'SELECT id FROM project_members WHERE project_id = $1 AND user_name = $2',
      [code, user_name]
    );
    if (already.rows.length > 0)
      return res.status(409).json({ message: 'User is already a member of this project.' });

    await pool.query(
      `INSERT INTO project_members (project_id, user_name, role)
       VALUES ($1, $2, 'Member')`,
      [code, user_name]
    );

    res.json({ success: true, message: `${user_name} added to project ${code}.` });
  } catch (err) {
    res.status(500).json({ message: 'Failed to add member', error: err.message });
  }
};

// GET /projects/:code/members
const getProjectMembers = async (req, res) => {
  const { code } = req.params;

  try {
    const project = await pool.query(
      'SELECT id FROM projects WHERE code = $1',
      [code]
    );
    if (project.rows.length === 0)
      return res.status(404).json({ message: `Project ${code} not found.` });

    const { rows } = await pool.query(
      `SELECT u.id, u.full_name AS name, u.email, u.role, pm.joined_at
       FROM project_members pm
       JOIN users u ON u.full_name = pm.user_name
       WHERE pm.project_id = $1
       ORDER BY pm.joined_at ASC`,
      [code]
    );

    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch project members', error: err.message });
  }
};
// GET /projects/:code/documents
const getDocuments = async (req, res) => {
  const { code } = req.params;
  const { category } = req.query; // optional filter

  try {
    const project = await pool.query(
      'SELECT id FROM projects WHERE code = $1', [code]
    );
    if (project.rows.length === 0)
      return res.status(404).json({ message: `Project ${code} not found.` });

    let query = `
      SELECT id, name, type, category, uploaded_at
      FROM documents
      WHERE project_code = $1
    `;
    const params = [code];

    if (category) {
      query += ` AND category = $2`;
      params.push(category);
    }

    query += ` ORDER BY uploaded_at DESC`;

    const { rows } = await pool.query(query, params);
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch documents', error: err.message });
  }
};

// POST /projects/:code/documents
const uploadDocument = async (req, res) => {
  const { code } = req.params;
  const { name, type, category } = req.body;

  if (!name || !type || !category)
    return res.status(400).json({ message: 'name, type, and category are required.' });

  const allowedTypes = ['DWG', 'PDF', 'XLS', 'DOC'];
  const allowedCategories = ['Design & Engineering', 'Project Management', 'Site Reference'];

  if (!allowedTypes.includes(type))
    return res.status(400).json({ message: `Invalid type. Must be one of: ${allowedTypes.join(', ')}` });
  if (!allowedCategories.includes(category))
    return res.status(400).json({ message: `Invalid category.` });

  try {
    const { rows } = await pool.query(
      `INSERT INTO documents (project_code, name, type, category)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, type, category, uploaded_at`,
      [code, name, type, category]
    );
    res.status(201).json({ success: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ message: 'Failed to upload document', error: err.message });
  }
};

// DELETE /projects/:code/documents/:docId
const deleteDocument = async (req, res) => {
  const { code, docId } = req.params;

  try {
    const { rows } = await pool.query(
      `DELETE FROM documents WHERE id = $1 AND project_code = $2 RETURNING id`,
      [docId, code]
    );
    if (rows.length === 0)
      return res.status(404).json({ message: 'Document not found.' });

    res.json({ success: true, message: 'Document deleted.' });
  } catch (err) {
    res.status(500).json({ message: 'Failed to delete document', error: err.message });
  }
};
module.exports = {
  getAllProjects,
  getProjectByCode,
  createProject,
  updateProjectStatus,
  generateProjectCode,
  joinProject,
  getActiveCode,
  getJoinedProjects,
  getAvailableMembers,
  addMember,
  getProjectMembers,
  getDocuments,
  uploadDocument,
  deleteDocument,
};