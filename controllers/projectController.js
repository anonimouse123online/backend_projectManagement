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
    const { status, search, code } = req.query;
    const projects = await projectService.getAll(status, search, code);
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
        (code, project_code, name, location, scope, client, budget, start_date, end_date, phase, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'Planning')
       RETURNING
         id, code, name, location, scope, client, budget, phase, status,
         TO_CHAR(start_date, 'YYYY-MM-DD') AS start_date,
         TO_CHAR(end_date,   'YYYY-MM-DD') AS end_date`,
      [code, code, name, location, scope, client, budget, start_date, end_date, phase]
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
  const { invite_code } = req.body;

  const userId = req.user?.id;
  const userEmail = req.user?.email;

  if (!userId || !userEmail) {
    return res.status(401).json({
      message: 'Authentication required.'
    });
  }

  try {

    // ============================================================
    // CHECK INVITE CODE
    // ============================================================

    const { rows } = await pool.query(
      `
      SELECT *
      FROM project_invite_codes
      WHERE code = $1
        AND used = FALSE
        AND expires_at > NOW()
      `,
      [invite_code]
    );

    if (rows.length === 0) {
      return res.status(400).json({
        message: 'Invalid or expired invite code.'
      });
    }

    const invite = rows[0];


    // ============================================================
    // CHECK IF USER ALREADY JOINED
    // project_members uses user_name instead of user_id
    // ============================================================

    const already = await pool.query(
      `
      SELECT id
      FROM project_members
      WHERE project_id = $1
        AND user_name = $2
      `,
      [
        invite.project_id,
        userEmail
      ]
    );

    if (already.rows.length > 0) {
      return res.status(409).json({
        message: 'You are already a member of this project.'
      });
    }


    // ============================================================
    // ADD USER TO PROJECT
    // ============================================================

    await pool.query(
      `
      INSERT INTO project_members (
        project_id,
        user_name,
        role
      )
      VALUES ($1, $2, 'Member')
      `,
      [
        invite.project_id,
        userEmail
      ]
    );


    // ============================================================
    // MARK INVITE CODE AS USED
    // ============================================================

    await pool.query(
      `
      UPDATE project_invite_codes
      SET used = TRUE,
          used_at = NOW()
      WHERE id = $1
      `,
      [invite.id]
    );


    // ============================================================
    // SUCCESS
    // ============================================================

    return res.json({
      success: true,
      message: 'Successfully joined the project.',
      project_id: invite.project_id
    });

  } catch (err) {

    console.error(
      'joinProject error:',
      err
    );

    return res.status(500).json({
      message: 'Failed to join project',
      error: err.message
    });
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

// GET /projects/joined
// ============================================================
// GET PROJECTS JOINED BY CURRENT USER
// GET /projects/joined
// ============================================================

const getJoinedProjects = async (req, res) => {

  const userEmail = req.user?.email;

  if (!userEmail) {
    return res.status(401).json({
      success: false,
      message: 'Authentication required.'
    });
  }

  try {

    console.log('======================================');
    console.log('[JOINED PROJECTS]');
    console.log('USER EMAIL:', userEmail);
    console.log('======================================');


    const { rows } = await pool.query(
      `
      SELECT
        p.id,
        p.code,
        p.name,
        p.location,
        p.scope,
        p.client,
        p.budget,
        p.phase,
        p.status,

        0 AS progress,

        TO_CHAR(
          p.start_date,
          'YYYY-MM-DD'
        ) AS start_date,

        TO_CHAR(
          p.end_date,
          'YYYY-MM-DD'
        ) AS due_date,

        'Not assigned' AS manager

      FROM project_members pm

      INNER JOIN projects p
        ON p.code = pm.project_id

      WHERE LOWER(TRIM(pm.user_name))
            =
            LOWER(TRIM($1))

      ORDER BY pm.joined_at DESC
      `,
      [
        userEmail
      ]
    );


    console.log(
      `[JOINED PROJECTS] FOUND ${rows.length} PROJECT(S)`
    );

    console.log(
      '[JOINED PROJECTS] DATA:',
      rows
    );


    return res.status(200).json({
      success: true,
      data: rows
    });


  } catch (err) {

    console.error(
      '❌ getJoinedProjects error:',
      err
    );


    return res.status(500).json({
      success: false,
      message: 'Failed to fetch joined projects.',
      error: err.message
    });
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
       WHERE u.id NOT IN (
         SELECT pm.user_id
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
      'SELECT id, full_name FROM users WHERE id = $1',
      [userId]
    );
    if (userRes.rows.length === 0)
      return res.status(404).json({ message: 'User not found.' });

    const projectRes = await pool.query(
      'SELECT id FROM projects WHERE code = $1',
      [code]
    );
    if (projectRes.rows.length === 0)
      return res.status(404).json({ message: `Project ${code} not found.` });

    const already = await pool.query(
      'SELECT id FROM project_members WHERE project_id = $1 AND user_id = $2',
      [code, userId]
    );
    if (already.rows.length > 0)
      return res.status(409).json({ message: 'User is already a member of this project.' });

    await pool.query(
      `INSERT INTO project_members (project_id, user_id, role)
       VALUES ($1, $2, 'Member')`,
      [code, userId]
    );

    res.json({ success: true, message: `${userRes.rows[0].full_name} added to project ${code}.` });
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
       JOIN users u ON u.id = pm.user_id
       WHERE pm.project_id = $1
       ORDER BY pm.joined_at ASC`,
      [code]
    );

    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch project members', error: err.message });
  }
};

// DELETE /projects/:code/members/:memberId
const removeMember = async (req, res) => {
  const { code, memberId } = req.params;

  try {
    const { rows } = await pool.query(
      `DELETE FROM project_members
       WHERE project_id = $1 AND user_id = $2
       RETURNING id`,
      [code, memberId]
    );
    if (rows.length === 0)
      return res.status(404).json({ message: 'Member not found in this project.' });

    res.json({ success: true, message: 'Member removed from project.' });
  } catch (err) {
    res.status(500).json({ message: 'Failed to remove member', error: err.message });
  }
};

// GET /projects/:code/stats
const getProjectStats = async (req, res) => {
  const { code } = req.params;

  try {
    const project = await pool.query(
      'SELECT id FROM projects WHERE code = $1',
      [code]
    );
    if (project.rows.length === 0)
      return res.status(404).json({ message: `Project ${code} not found.` });

    const projectId = project.rows[0].id;

    const [taskStats, memberStats, issueStats] = await Promise.all([
      pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE status != 'Completed') AS active_tasks,
           COUNT(*) FILTER (WHERE status = 'Pending')    AS pending_task_issues
         FROM tasks
         WHERE project_id = $1`,
        [projectId]
      ),
      pool.query(
        `SELECT COUNT(*) AS member_count
         FROM project_members
         WHERE project_id = $1`,
        [code]
      ),
      pool.query(
        `SELECT COUNT(*) AS pending_issues
         FROM project_issues
         WHERE project_code = $1 AND status != 'Resolved'`,
        [code]
      ),
    ]);

    const realIssues = parseInt(issueStats.rows[0]?.pending_issues) || 0;
    const taskPending = parseInt(taskStats.rows[0]?.pending_task_issues) || 0;

    res.json({
      success: true,
      data: {
        activeTaskCount:   parseInt(taskStats.rows[0]?.active_tasks) || 0,
        memberCount:       parseInt(memberStats.rows[0]?.member_count) || 0,
        pendingIssueCount: realIssues > 0 ? realIssues : taskPending,
      },
    });
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch project stats', error: err.message });
  }
};

// GET /projects/:code/active-task
const getProjectActiveTask = async (req, res) => {
  const { code } = req.params;

  try {
    const project = await pool.query(
      'SELECT id FROM projects WHERE code = $1',
      [code]
    );
    if (project.rows.length === 0)
      return res.status(404).json({ message: `Project ${code} not found.` });

    const projectId = project.rows[0].id;

    const { rows } = await pool.query(
      `SELECT t.id, t.task_name AS title, t.status,
              u.full_name AS assignee
       FROM tasks t
       LEFT JOIN users u ON u.id = t.assignee_id
       WHERE t.project_id = $1 AND (t.status ILIKE '%progress%' OR t.status ILIKE '%ongoing%' OR t.status ILIKE '%pending%')
       ORDER BY (CASE WHEN t.status ILIKE '%progress%' THEN 1 WHEN t.status ILIKE '%ongoing%' THEN 2 ELSE 3 END), t.updated_at DESC
       LIMIT 1`,
      [projectId]
    );

    res.json({
      success: true,
      data: rows[0] || null,
    });
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch active task', error: err.message });
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

  // Support flat payload { name, type, category }, { documents: [...] }, or array [...]
  let docs = [];
  if (Array.isArray(req.body.documents) && req.body.documents.length > 0) {
    docs = req.body.documents;
  } else if (Array.isArray(req.body) && req.body.length > 0) {
    docs = req.body;
  } else if (req.body && (req.body.name || req.body.category || req.body.type)) {
    docs = [req.body];
  }

  if (docs.length === 0) {
    return res.status(400).json({ message: 'name, type, and category are required.' });
  }

  const allowedTypes = ['DWG', 'PDF', 'XLS', 'DOC'];
  const allowedCategories = ['Design & Engineering', 'Project Management', 'Site Reference'];

  // Normalize and validate each document
  const validatedDocs = [];
  for (let i = 0; i < docs.length; i++) {
    const doc = docs[i];
    let docName = (doc.name || '').trim();
    let docType = (doc.type || 'PDF').trim().toUpperCase();
    let docCategory = (doc.category || 'Design & Engineering').trim();

    // Normalize type aliases
    if (docType === 'DOCX') docType = 'DOC';
    if (docType === 'XLSX' || docType === 'CSV') docType = 'XLS';
    if (['JPG', 'JPEG', 'PNG', 'WEBP'].includes(docType)) docType = 'PDF';

    if (!docName) {
      return res.status(400).json({ message: 'name, type, and category are required.' });
    }
    if (!allowedTypes.includes(docType)) {
      docType = 'PDF'; // fallback safe type
    }
    if (!allowedCategories.includes(docCategory)) {
      docCategory = 'Design & Engineering'; // fallback safe category
    }

    validatedDocs.push({ name: docName, type: docType, category: docCategory });
  }

  try {
    const inserted = [];
    for (const doc of validatedDocs) {
      const { rows } = await pool.query(
        `INSERT INTO documents (project_code, name, type, category)
         VALUES ($1, $2, $3, $4)
         RETURNING id, name, type, category, uploaded_at`,
        [code, doc.name, doc.type, doc.category]
      );
      inserted.push(rows[0]);
    }

    res.status(201).json({
      success: true,
      data: inserted.length === 1 ? inserted[0] : inserted,
      count: inserted.length,
    });
  } catch (err) {
    console.error('uploadDocument error:', err);
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
// DELETE /projects/:code
const deleteProject = async (req, res) => {
  const { code } = req.params;

  try {
    const { rows } = await pool.query(
      'DELETE FROM projects WHERE code = $1 RETURNING id, code, name',
      [code]
    );
    if (rows.length === 0) {
      return res.status(404).json({ message: `Project ${code} not found.` });
    }

    res.json({ success: true, message: `Project "${rows[0].name}" deleted.` });
  } catch (err) {
    res.status(500).json({ message: 'Failed to delete project', error: err.message });
  }
};

// ─── ACTION 1: PROJECT PROGRESS ─────────────────────────────────────────────

// GET /projects/:code/progress
const getProjectProgress = async (req, res) => {
  const { code } = req.params;

  try {
    const projectRes = await pool.query(
      'SELECT id, code, name, phase, status, progress_pct, start_date, end_date FROM projects WHERE code = $1',
      [code]
    );
    if (projectRes.rows.length === 0) {
      return res.status(404).json({ message: `Project ${code} not found.` });
    }

    const project = projectRes.rows[0];

    // Fetch phase task breakdown
    const taskBreakdown = await pool.query(
      `SELECT phase,
              COUNT(*) AS total_tasks,
              COUNT(*) FILTER (WHERE status = 'Completed') AS completed_tasks,
              COUNT(*) FILTER (WHERE status = 'In Progress') AS in_progress_tasks
       FROM tasks
       WHERE project_id = $1
       GROUP BY phase`,
      [project.id]
    );

    // Fetch progress logs history
    const logsRes = await pool.query(
      `SELECT pl.id, pl.phase, pl.progress_pct, pl.summary, pl.work_completed,
              pl.manpower, pl.weather, pl.created_at,
              u.full_name AS logged_by_name, u.role AS logged_by_role
       FROM project_progress_logs pl
       LEFT JOIN users u ON u.id = pl.logged_by
       WHERE pl.project_code = $1
       ORDER BY pl.created_at DESC`,
      [code]
    );

    res.json({
      success: true,
      data: {
        project,
        taskBreakdown: taskBreakdown.rows,
        logs: logsRes.rows,
      },
    });
  } catch (err) {
    console.error('getProjectProgress error:', err);
    res.status(500).json({ message: 'Failed to fetch project progress', error: err.message });
  }
};

const CONSTRUCTION_PHASES = [
  'Phase 1 - Foundation',
  'Phase 2 - Structural',
  'Phase 3 - Electrical & Utilities',
  'Phase 4 - Plumbing & MEP',
  'Phase 5 - Finishing',
];

function getNextPhase(currentPhase) {
  if (!currentPhase) return { nextPhase: CONSTRUCTION_PHASES[0], isAllCompleted: false };
  const curLower = currentPhase.toLowerCase();
  const idx = CONSTRUCTION_PHASES.findIndex(p => {
    const pLower = p.toLowerCase();
    return pLower.includes(curLower) || curLower.includes(pLower) ||
      (pLower.includes('phase 1') && curLower.includes('foundation')) ||
      (pLower.includes('phase 2') && (curLower.includes('structur') || curLower.includes('structure'))) ||
      (pLower.includes('phase 3') && (curLower.includes('utilit') || curLower.includes('electr'))) ||
      (pLower.includes('phase 4') && (curLower.includes('plumb') || curLower.includes('mep'))) ||
      (pLower.includes('phase 5') && curLower.includes('finish'));
  });

  if (idx !== -1 && idx < CONSTRUCTION_PHASES.length - 1) {
    return { nextPhase: CONSTRUCTION_PHASES[idx + 1], isAllCompleted: false };
  } else if (idx === CONSTRUCTION_PHASES.length - 1) {
    return { nextPhase: CONSTRUCTION_PHASES[idx], isAllCompleted: true };
  }
  return { nextPhase: currentPhase, isAllCompleted: false };
}

// POST /projects/:code/progress
const logProjectProgress = async (req, res) => {
  const { code } = req.params;
  const { phase, progress_pct, summary, work_completed, manpower, weather } = req.body;
  const userId = req.user?.id || null;

  if (!phase || progress_pct === undefined || !summary) {
    return res.status(400).json({ message: 'phase, progress_pct, and summary are required.' });
  }

  try {
    const pct = Math.min(100, Math.max(0, parseInt(progress_pct) || 0));

    // Determine if phase should advance to the next phase upon 100% completion
    let targetPhase = phase;
    let targetStatus = 'Ongoing';
    if (pct === 100) {
      const advancement = getNextPhase(phase);
      targetPhase = advancement.nextPhase;
      if (advancement.isAllCompleted) targetStatus = 'Completed';
    }

    // Update current project phase and progress percentage
    await pool.query(
      `UPDATE projects
       SET phase = $1, status = $2, progress_pct = $3, updated_at = NOW()
       WHERE code = $4`,
      [targetPhase, targetStatus, pct, code]
    );

    // Insert progress log
    const { rows } = await pool.query(
      `INSERT INTO project_progress_logs (project_code, phase, progress_pct, summary, work_completed, manpower, weather, logged_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [code, phase, pct, summary.trim(), work_completed || null, parseInt(manpower) || 0, weather || 'Sunny', userId]
    );

    // Cascade Phase Milestone progress to tasks belonging to this project and phase
    const projRes = await pool.query('SELECT id FROM projects WHERE code = $1', [code]);
    if (projRes.rows.length > 0) {
      const projId = projRes.rows[0].id;
      const phaseKeyword = phase.includes(' - ') ? phase.split(' - ')[1].trim() : phase.trim();
      let autoStatus = null;
      if (pct === 100) autoStatus = 'Completed';
      else if (pct > 0) autoStatus = 'In Progress';

      await pool.query(
        `UPDATE tasks
         SET progress_pct = $1,
             status = COALESCE($2, status),
             updated_at = NOW()
         WHERE project_id = $3
           AND (phase ILIKE '%' || $4 || '%' OR phase ILIKE $5)`,
        [pct, autoStatus, projId, phaseKeyword, phase]
      );
      console.log(`[CASCADE] Synced tasks for project ${code} (${phase}) to ${pct}% progress (Active Phase advanced to: ${targetPhase})`);
    }

    res.status(201).json({
      success: true,
      message: pct === 100
        ? `Phase completed! Project automatically advanced to ${targetPhase}.`
        : 'Progress update logged successfully and synced with task milestones.',
      data: {
        ...rows[0],
        nextPhase: targetPhase,
        projectStatus: targetStatus,
      },
    });
  } catch (err) {
    console.error('logProjectProgress error:', err);
    res.status(500).json({ message: 'Failed to log progress update', error: err.message });
  }
};

// ─── ACTION 2: PROJECT ISSUES ───────────────────────────────────────────────

// GET /projects/:code/issues
const getProjectIssues = async (req, res) => {
  const { code } = req.params;
  const { status, category, priority, search } = req.query;

  try {
    let query = `
      SELECT i.id, i.project_code, i.title, i.category, i.priority, i.location,
             i.description, i.status, i.resolution_notes, i.resolved_at, i.created_at, i.updated_at,
             ru.full_name AS reporter_name, ru.role AS reporter_role,
             au.full_name AS assignee_name, au.role AS assignee_role,
             i.reported_by, i.assigned_to
      FROM project_issues i
      LEFT JOIN users ru ON ru.id = i.reported_by
      LEFT JOIN users au ON au.id = i.assigned_to
      WHERE i.project_code = $1
    `;
    const params = [code];

    if (status && status !== 'All') {
      params.push(status);
      query += ` AND i.status = $${params.length}`;
    }
    if (category && category !== 'All') {
      params.push(category);
      query += ` AND i.category = $${params.length}`;
    }
    if (priority && priority !== 'All') {
      params.push(priority);
      query += ` AND i.priority = $${params.length}`;
    }
    if (search) {
      params.push(`%${search.trim().toLowerCase()}%`);
      query += ` AND (LOWER(i.title) LIKE $${params.length} OR LOWER(i.description) LIKE $${params.length} OR LOWER(i.location) LIKE $${params.length})`;
    }

    query += ` ORDER BY CASE WHEN i.status = 'Open' THEN 1 WHEN i.status = 'In Progress' THEN 2 ELSE 3 END, i.created_at DESC`;

    const { rows } = await pool.query(query, params);
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('getProjectIssues error:', err);
    res.status(500).json({ message: 'Failed to fetch project issues', error: err.message });
  }
};

// POST /projects/:code/issues
const createProjectIssue = async (req, res) => {
  const { code } = req.params;
  const { title, category, priority, location, description, assigned_to } = req.body;
  const userId = req.user?.id || null;

  if (!title || !category || !description) {
    return res.status(400).json({ message: 'title, category, and description are required.' });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO project_issues (project_code, title, category, priority, location, description, status, reported_by, assigned_to)
       VALUES ($1, $2, $3, $4, $5, $6, 'Open', $7, $8)
       RETURNING *`,
      [code, title.trim(), category, priority || 'Medium', location || null, description.trim(), userId, assigned_to || null]
    );

    res.status(201).json({
      success: true,
      message: 'Issue reported successfully.',
      data: rows[0],
    });
  } catch (err) {
    console.error('createProjectIssue error:', err);
    res.status(500).json({ message: 'Failed to report issue', error: err.message });
  }
};

// PATCH /projects/:code/issues/:issueId
const updateProjectIssue = async (req, res) => {
  const { code, issueId } = req.params;
  const { status, resolution_notes, assigned_to, priority } = req.body;

  try {
    const existing = await pool.query(
      'SELECT id, status FROM project_issues WHERE id = $1 AND project_code = $2',
      [issueId, code]
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ message: 'Issue not found.' });
    }

    const updates = [];
    const params = [issueId, code];

    if (status) {
      params.push(status);
      updates.push(`status = $${params.length}`);
      if (status === 'Resolved') {
        updates.push(`resolved_at = NOW()`);
      } else {
        updates.push(`resolved_at = NULL`);
      }
    }
    if (resolution_notes !== undefined) {
      params.push(resolution_notes);
      updates.push(`resolution_notes = $${params.length}`);
    }
    if (assigned_to !== undefined) {
      params.push(assigned_to);
      updates.push(`assigned_to = $${params.length}`);
    }
    if (priority) {
      params.push(priority);
      updates.push(`priority = $${params.length}`);
    }

    updates.push(`updated_at = NOW()`);

    const { rows } = await pool.query(
      `UPDATE project_issues
       SET ${updates.join(', ')}
       WHERE id = $1 AND project_code = $2
       RETURNING *`,
      params
    );

    res.json({
      success: true,
      message: 'Issue updated successfully.',
      data: rows[0],
    });
  } catch (err) {
    console.error('updateProjectIssue error:', err);
    res.status(500).json({ message: 'Failed to update issue', error: err.message });
  }
};

// ─── ACTION 3: PROJECT REPORTS ──────────────────────────────────────────────

// GET /projects/:code/reports
const getProjectReports = async (req, res) => {
  const { code } = req.params;
  const { type, search } = req.query;

  try {
    let query = `
      SELECT r.id, r.project_code, r.title, r.report_type, r.report_date, r.summary,
             r.key_activities, r.issues_highlighted, r.manpower_count, r.equipment_on_site,
             r.weather, r.status, r.created_at,
             u.full_name AS prepared_by_name, u.role AS prepared_by_role
      FROM project_reports r
      LEFT JOIN users u ON u.id = r.prepared_by
      WHERE r.project_code = $1
    `;
    const params = [code];

    if (type && type !== 'All') {
      params.push(type);
      query += ` AND r.report_type = $${params.length}`;
    }
    if (search) {
      params.push(`%${search.trim().toLowerCase()}%`);
      query += ` AND (LOWER(r.title) LIKE $${params.length} OR LOWER(r.summary) LIKE $${params.length})`;
    }

    query += ` ORDER BY r.report_date DESC, r.created_at DESC`;

    const { rows } = await pool.query(query, params);
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('getProjectReports error:', err);
    res.status(500).json({ message: 'Failed to fetch project reports', error: err.message });
  }
};

// POST /projects/:code/reports
const createProjectReport = async (req, res) => {
  const { code } = req.params;
  const {
    title,
    report_type,
    report_date,
    summary,
    key_activities,
    issues_highlighted,
    manpower_count,
    equipment_on_site,
    weather,
  } = req.body;
  const userId = req.user?.id || null;

  if (!title || !summary) {
    return res.status(400).json({ message: 'title and summary are required.' });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO project_reports (
         project_code, title, report_type, report_date, prepared_by,
         summary, key_activities, issues_highlighted, manpower_count,
         equipment_on_site, weather, status
       )
       VALUES ($1, $2, $3, COALESCE($4::DATE, CURRENT_DATE), $5, $6, $7, $8, $9, $10, $11, 'Final')
       RETURNING *`,
      [
        code,
        title.trim(),
        report_type || 'Daily Site Log',
        report_date || null,
        userId,
        summary.trim(),
        key_activities || null,
        issues_highlighted || null,
        parseInt(manpower_count) || 0,
        equipment_on_site || null,
        weather || 'Clear',
      ]
    );

    res.status(201).json({
      success: true,
      message: 'Project report created successfully.',
      data: rows[0],
    });
  } catch (err) {
    console.error('createProjectReport error:', err);
    res.status(500).json({ message: 'Failed to create project report', error: err.message });
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
  removeMember,
  getProjectStats,
  getProjectActiveTask,
  getDocuments,
  uploadDocument,
  deleteDocument,
  deleteProject,
  // Project Actions
  getProjectProgress,
  logProjectProgress,
  getProjectIssues,
  createProjectIssue,
  updateProjectIssue,
  getProjectReports,
  createProjectReport,
};