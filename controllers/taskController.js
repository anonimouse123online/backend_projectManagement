const pool = require('../db');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const FormData = require('form-data');

const AI_SERVICE_URL = process.env.AI_SERVICE_URL || 'http://localhost:8000';

// ─── Multer Storage ───────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: function(req, file, cb) {
    const taskId = req.params.id;
    const date = new Date().toISOString().split('T')[0];
    const dir = path.join(__dirname, '../uploads/tasks/' + taskId + '/' + date);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: function(req, file, cb) {
    cb(null, Date.now() + '_' + file.originalname);
  }
});

const fileFilter = function(req, file, cb) {
  const allowed = ['image/jpeg', 'image/png', 'image/jpg'];
  if (allowed.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Images only (jpeg, jpg, png)'));
  }
};

exports.upload = multer({
  storage: storage,
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: fileFilter
});

// ─── GET ALL TASKS ────────────────────────────────────────────────────────────
// ─── GET ALL TASKS ────────────────────────────────────────────────────────────
exports.getTasks = async function(req, res) {
  const {
    project_id,
    status,
    phase,
    priority,
    assignee_id,
    search
  } = req.query;

  console.log('[ROUTE] GET /tasks filters:', {
    project_id,
    status,
    phase,
    priority,
    assignee_id,
    search
  });

  try {
    const conditions = [];
    const params = [];

    // PROJECT FILTER
    if (project_id) {
      params.push(project_id);

      conditions.push(
        `(t.project_id::text = $${params.length}
          OR p.code = $${params.length})`
      );
    }

    // STATUS FILTER
    if (
      status &&
      status !== 'All' &&
      status !== 'All Statuses'
    ) {
      params.push(`%${status.replace('-', '%')}%`);

      conditions.push(
        `t.status ILIKE $${params.length}`
      );
    }

    // PHASE FILTER
    if (
      phase &&
      phase !== 'All'
    ) {
      params.push(`%${phase}%`);

      conditions.push(
        `t.phase ILIKE $${params.length}`
      );
    }

    // PRIORITY FILTER
    if (
      priority &&
      priority !== 'All'
    ) {
      params.push(priority);

      conditions.push(
        `t.priority ILIKE $${params.length}`
      );
    }

    // ASSIGNEE FILTER
    if (assignee_id) {
      params.push(assignee_id);

      conditions.push(
        `(t.assignee_id::text = $${params.length}
          OR u.full_name ILIKE $${params.length})`
      );
    }

    // SEARCH
    if (search) {
      params.push(`%${search}%`);

      conditions.push(
        `(t.task_name ILIKE $${params.length}
          OR t.site_instructions ILIKE $${params.length}
          OR p.name ILIKE $${params.length}
          OR p.code ILIKE $${params.length})`
      );
    }

    const where = conditions.length
      ? `WHERE ${conditions.join(' AND ')}`
      : '';

    const query = `
      SELECT
        t.id,
        COALESCE(t.task_name, t.title, 'Untitled Task') AS task_name,
        t.phase,
        t.project_id,

        p.name AS project_name,
        p.code AS project_code,

        u.full_name AS assignee,
        u.id AS assignee_id,

        TO_CHAR(
          t.due_date::date,
          'Mon DD, YYYY'
        ) AS due_date,

        t.priority,
        t.status,
        t.manpower_needed,
        t.materials_required,
        t.site_instructions,

        '[]'::jsonb AS subtasks,

        CASE
          WHEN t.status ILIKE 'completed'
            THEN 100

          WHEN t.status ILIKE 'in progress'
            OR t.status ILIKE 'in-progress'
            OR t.status ILIKE 'ongoing'
            THEN 50

          ELSE 0
        END AS progress_pct

      FROM tasks t

      LEFT JOIN users u
        ON u.id = t.assignee_id

      LEFT JOIN projects p
        ON p.id::text = t.project_id::text OR p.code = t.project_id::text

      ${where}

      ORDER BY
        t.phase,
        t.created_at DESC
    `;

    console.log('[ROUTE] Executing GET /tasks query...');

    const result = await pool.query(
      query,
      params
    );

    console.log(
      '[ROUTE] GET /tasks → returned',
      result.rows.length,
      'task(s)'
    );

    return res.status(200).json({
      success: true,
      data: result.rows
    });

  } catch (err) {
    console.error(
      '[ROUTE] GET /tasks ERROR:',
      err
    );

    return res.status(500).json({
      success: false,
      error: 'Failed to fetch tasks.',
      details: err.message
    });
  }
};

// ─── GET TASK BY ID ───────────────────────────────────────────────────────────
exports.getTaskById = async function(req, res) {
  console.log('[ROUTE] GET /tasks/' + req.params.id);
  try {
    const id = req.params.id;
    const result = await pool.query(
      `SELECT
         t.id,
         COALESCE(t.task_name, t.title, 'Untitled Task') AS task_name,
         t.phase,
         u.full_name AS assignee,
         TO_CHAR(t.due_date::date, 'Mon DD, YYYY') AS due_date,
         t.priority, t.status, t.manpower_needed,
         t.materials_required, t.site_instructions,
         p.name AS project_name, p.code AS project_code,
         COALESCE(
           NULLIF(t.progress_pct, 0),
           (
             SELECT pl.progress_pct
             FROM project_progress_logs pl
             WHERE pl.project_code = p.code
               AND (pl.phase ILIKE '%' || SPLIT_PART(t.phase, ' - ', 2) || '%' OR pl.phase ILIKE t.phase)
             ORDER BY pl.created_at DESC
             LIMIT 1
           ),
           CASE WHEN t.status ILIKE 'completed' THEN 100
                WHEN t.status ILIKE 'in%progress' OR t.status ILIKE 'ongoing' THEN COALESCE(p.progress_pct, 50)
                ELSE 0 END,
           0
         ) AS progress_pct,
       '[]'::jsonb AS subtasks,
         (
           SELECT pl.progress_pct
           FROM project_progress_logs pl
           WHERE pl.project_code = p.code
             AND (pl.phase ILIKE '%' || SPLIT_PART(t.phase, ' - ', 2) || '%' OR pl.phase ILIKE t.phase)
           ORDER BY pl.created_at DESC
           LIMIT 1
         ) AS phase_milestone_pct
       FROM tasks t
       LEFT JOIN users u ON u.id = t.assignee_id
       LEFT JOIN projects p ON p.id::text = t.project_id::text OR p.code = t.project_id::text
       WHERE t.id::text = $1::text`,
      [id]
    );
    if (result.rows.length === 0) {
      console.warn('[ROUTE] GET /tasks/' + id + ' → 404 not found');
      return res.status(404).json({ error: 'Task not found.' });
    }
    console.log('[ROUTE] GET /tasks/' + id + ' → found:', result.rows[0].task_name);
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    console.error('[ROUTE] GET /tasks/:id ERROR:', err);
    res.status(500).json({ error: 'Failed to fetch task.' });
  }
};

// ─── UPDATE TASK STATUS ───────────────────────────────────────────────────────
exports.updateTaskStatus = async function(req, res) {
  const id = req.params.id;
  const status = req.body.status;
  let progress_pct = req.body.progress_pct;

  console.log('[ROUTE] PATCH /tasks/' + req.params.id + '/status → ', status);
  try {
    if (progress_pct === undefined && status) {
      const st = status.toLowerCase();
      if (st.includes('completed')) {
        progress_pct = 100;
      } else if (st.includes('pending')) {
        progress_pct = 0;
      } else if (st.includes('in-progress') || st.includes('ongoing') || st.includes('in progress')) {
        const cur = await pool.query('SELECT progress_pct FROM tasks WHERE id = $1::uuid', [id]);
        const curVal = cur.rows[0]?.progress_pct || 0;
        progress_pct = curVal > 0 ? curVal : 50;
      }
    }

    const result = await pool.query(
      `UPDATE tasks
       SET status = COALESCE($1, status),
           progress_pct = COALESCE($2, progress_pct),
           updated_at = NOW()
       WHERE id = $3::uuid
       RETURNING *`,
      [status, progress_pct, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Task not found.' });
    }

    console.log('[ROUTE] PATCH /tasks/' + id + '/status → updated:', result.rows[0].status, 'progress:', result.rows[0].progress_pct + '%');
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    console.error('[ROUTE] PATCH /tasks/:id/status ERROR:', err);
    res.status(500).json({ error: 'Failed to update task status.' });
  }
};

// ============================================================
// COMPLETE TASK
// PATCH /tasks/:id/complete
// ============================================================

// ============================================================
// COMPLETE TASK
// PATCH /tasks/:id/complete
// ============================================================

exports.completeTask = async function(req, res) {

  const taskId =
    req.params.id || req.params.taskId;

  console.log(
    '════════════════════════════════════════'
  );

  console.log(
    '[COMPLETE TASK] TASK ID:',
    taskId
  );

  try {

    // --------------------------------------------------------
    // FIND TASK
    // --------------------------------------------------------

    const taskResult =
      await pool.query(
        `
        SELECT
          t.id,
          t.task_name,
          t.status,
          t.project_id,

          p.code AS project_code,
          p.name AS project_name

        FROM tasks t

        LEFT JOIN projects p
          ON p.id = t.project_id

        WHERE t.id = $1::uuid

        LIMIT 1
        `,
        [taskId]
      );


    if (taskResult.rows.length === 0) {

      return res.status(404).json({
        success: false,
        message: 'Task not found.'
      });
    }


    const task =
      taskResult.rows[0];


    console.log(
      '[COMPLETE TASK] TASK:',
      task.task_name
    );

    console.log(
      '[COMPLETE TASK] PROJECT:',
      task.project_code || 'N/A'
    );


    // --------------------------------------------------------
    // UPDATE TASK
    // --------------------------------------------------------

    const result =
      await pool.query(
        `
        UPDATE tasks

        SET
          status = 'Completed',
          updated_at = NOW()

        WHERE id = $1::uuid

        RETURNING
          id,
          task_name,
          project_id,
          status,
          updated_at
        `,
        [taskId]
      );


    const completedTask =
      result.rows[0];


    console.log(
      '✅ TASK COMPLETED'
    );

    console.log(
      'TASK:',
      completedTask.task_name
    );

    console.log(
      'STATUS:',
      completedTask.status
    );

    console.log(
      '════════════════════════════════════════'
    );


    return res.status(200).json({

      success: true,

      message:
        'Task marked as completed successfully.',

      data: {
        ...completedTask,

        // Android can still receive 100%
        progress_pct: 100
      }

    });


  } catch (err) {

    console.error(
      '════════════════════════════════════════'
    );

    console.error(
      '❌ COMPLETE TASK ERROR'
    );

    console.error(
      'MESSAGE:',
      err.message
    );

    console.error(
      'CODE:',
      err.code
    );

    console.error(err);

    console.error(
      '════════════════════════════════════════'
    );


    return res.status(500).json({

      success: false,

      message:
        'Failed to complete task.',

      error:
        err.message

    });
  }
};
// ─── UPDATE SUBTASKS & PROGRESS ───────────────────────────────────────────────
exports.updateTaskSubtasks = async function(req, res) {
  const id = req.params.id;
  const { subtasks } = req.body;
  console.log('[ROUTE] PATCH /tasks/' + id + '/subtasks');
  try {
    const subs = Array.isArray(subtasks) ? subtasks : [];
    let pct = 0;
    if (subs.length > 0) {
      const doneCount = subs.filter(s => s.completed).length;
      pct = Math.round((doneCount / subs.length) * 100);
    }
    let autoStatus = null;
    if (pct === 100) autoStatus = 'Completed';
    else if (pct > 0) autoStatus = 'In Progress';

    const result = await pool.query(
      `UPDATE tasks
       SET subtasks = $1,
           progress_pct = $2,
           status = COALESCE($3, status),
           updated_at = NOW()
       WHERE id = $4::uuid
       RETURNING *`,
      [JSON.stringify(subs), pct, autoStatus, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Task not found.' });
    }

    console.log('[ROUTE] PATCH /tasks/' + id + '/subtasks → new progress:', pct + '%', 'status:', result.rows[0].status);
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    console.error('[ROUTE] PATCH /tasks/:id/subtasks ERROR:', err);
    res.status(500).json({ error: 'Failed to update subtasks.' });
  }
};

// ─── CREATE TASK ──────────────────────────────────────────────────────────────
exports.createTask = async function(req, res) {
  console.log('[ROUTE] POST /tasks → creating task:', req.body.taskName || req.body.task_name);
  try {
    const taskName          = (req.body.taskName || req.body.task_name || '').trim();
    const phase             = (req.body.phase || '').trim();
    let assigneeId          = (req.body.assigneeId || req.body.assignee_id || '').trim();
    const dueDate           = (req.body.dueDate || req.body.due_date || '').trim();
    const priority          = (req.body.priority || '').trim();
    const manpowerNeeded    = (req.body.manpowerNeeded || req.body.manpower_needed || '').trim();
    const materialsRequired = (req.body.materialsRequired || req.body.materials_required || '').trim();
    const siteInstructions  = (req.body.siteInstructions || req.body.site_instructions || '').trim();
    let projectId           = (req.body.projectId || req.body.project_id || '').trim();

    // Check all fields are provided
    if (!taskName) {
      return res.status(400).json({ error: 'Task name is required.' });
    }
    if (!phase) {
      return res.status(400).json({ error: 'Phase is required.' });
    }
    if (!projectId) {
      return res.status(400).json({ error: 'Project is required.' });
    }
    if (!assigneeId) {
      return res.status(400).json({ error: 'Assignee engineer is required.' });
    }
    if (!dueDate) {
      return res.status(400).json({ error: 'Due date is required.' });
    }
    if (!priority) {
      return res.status(400).json({ error: 'Priority is required.' });
    }
    if (!manpowerNeeded) {
      return res.status(400).json({ error: 'Manpower needed is required.' });
    }
    if (!materialsRequired) {
      return res.status(400).json({ error: 'Materials required is required.' });
    }
    if (!siteInstructions) {
      return res.status(400).json({ error: 'Site instructions are required.' });
    }

    // Resolve projectId if passed as project code or UUID
    let resolvedProjectId = null;
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(projectId);
    if (isUuid) {
      resolvedProjectId = projectId;
    } else {
      const pRes = await pool.query('SELECT id FROM projects WHERE code = $1 OR name ILIKE $1 LIMIT 1', [projectId]);
      if (pRes.rows.length > 0) resolvedProjectId = pRes.rows[0].id;
      else return res.status(400).json({ error: 'Selected project was not found.' });
    }

    // Resolve assigneeId if passed as user name or email
    let resolvedAssigneeId = null;
    const isUserUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(assigneeId);
    if (isUserUuid) {
      resolvedAssigneeId = assigneeId;
    } else {
      const uRes = await pool.query('SELECT id FROM users WHERE full_name ILIKE $1 OR email ILIKE $1 LIMIT 1', [assigneeId]);
      if (uRes.rows.length > 0) resolvedAssigneeId = uRes.rows[0].id;
      else return res.status(400).json({ error: 'Selected assignee engineer was not found.' });
    }

    const result = await pool.query(
      `INSERT INTO tasks
         (title, task_name, description, phase, assignee_id, due_date, priority,
          manpower_needed, materials_required, site_instructions,
          project_id, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'Pending')
       RETURNING *`,
      [taskName, taskName, siteInstructions, phase, resolvedAssigneeId, dueDate, priority,
       manpowerNeeded, materialsRequired, siteInstructions, resolvedProjectId]
    );
    console.log('[ROUTE] POST /tasks → created task id:', result.rows[0].id);
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (err) {
    console.error('[ROUTE] POST /tasks ERROR:', err);
    res.status(500).json({ error: 'Failed to create task.' });
  }
};

// ─── ASSIGN TASK ──────────────────────────────────────────────────────────────
exports.assignTask = async function(req, res) {
  const id = req.params.id;
  const { assigneeId } = req.body;
  console.log('[ROUTE] PATCH /tasks/' + id + '/assign → assigneeId:', assigneeId);

  if (!assigneeId) {
    return res.status(400).json({ error: 'assigneeId is required.' });
  }

  try {
    // Verify user exists
    const userResult = await pool.query(
      'SELECT id, full_name FROM users WHERE id = $1 AND is_active = TRUE',
      [assigneeId]
    );
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }

    const result = await pool.query(
      `UPDATE tasks SET assignee_id = $1, updated_at = NOW() WHERE id = $2
       RETURNING *`,
      [assigneeId, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Task not found.' });
    }

    console.log('[ROUTE] PATCH /tasks/' + id + '/assign → assigned to:', userResult.rows[0].full_name);
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    console.error('[ROUTE] PATCH /tasks/:id/assign ERROR:', err);
    res.status(500).json({ error: 'Failed to assign task.' });
  }
};

// ─── GET USERS ────────────────────────────────────────────────────────────────
exports.getUsers = async function(req, res) {
  console.log('[ROUTE] GET /users');
  try {
    const result = await pool.query(
      `SELECT
         u.id, u.full_name, u.email, u.role,
         COUNT(t.id) FILTER (WHERE t.status != 'Completed') AS current_tasks
       FROM users u
       LEFT JOIN tasks t ON t.assignee_id = u.id
       WHERE u.is_active = TRUE
       GROUP BY u.id
       ORDER BY u.full_name ASC`
    );
    console.log('[ROUTE] GET /users → returned', result.rows.length, 'user(s)');
    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error('[ROUTE] GET /users ERROR:', err);
    res.status(500).json({ error: 'Failed to fetch users.' });
  }
};

// ─── UPLOAD TASK IMAGES ───────────────────────────────────────────────────────
exports.uploadTaskImages = async function(req, res) {
  const taskId = req.params.id;
  console.log('════════════════════════════════════════');
  console.log('[ROUTE] POST /tasks/' + taskId + '/images');
  console.log('  req.files:', req.files ? req.files.length + ' file(s)' : 'none');
  console.log('  req.file :', req.file ? req.file.originalname : 'none');

  try {
    const date = new Date().toISOString().split('T')[0];

    var files = [];
    if (req.files && req.files.length > 0) {
      files = req.files;
    } else if (req.file) {
      files = [req.file];
    }

    if (files.length === 0) {
      console.warn('[ROUTE] POST /tasks/' + taskId + '/images → 400 no files');
      return res.status(400).json({ error: 'No images provided.' });
    }

    const taskResult = await pool.query(
      'SELECT id, task_name FROM tasks WHERE id = $1',
      [taskId]
    );
    if (taskResult.rows.length === 0) {
      console.warn('[ROUTE] POST /tasks/' + taskId + '/images → 404 task not found');
      return res.status(404).json({ error: 'Task not found.' });
    }

    var imagePaths = [];
    for (var i = 0; i < files.length; i++) {
      imagePaths.push(files[i].path);
      console.log('  Saved file:', files[i].path);
    }

    await pool.query(
      `INSERT INTO task_images (task_id, image_paths, upload_date, status)
       VALUES ($1, $2::jsonb, $3, 'pending')
       ON CONFLICT (task_id, upload_date)
       DO UPDATE SET
         image_paths = (
           SELECT jsonb_agg(elem)
           FROM (
             SELECT jsonb_array_elements(task_images.image_paths) AS elem
             UNION ALL
             SELECT jsonb_array_elements($2::jsonb) AS elem
           ) combined
         ),
         status = 'pending'`,
      [taskId, JSON.stringify(imagePaths), date]
    );

    console.log('[ROUTE] POST /tasks/' + taskId + '/images → ✅ saved', imagePaths.length, 'image(s) to DB');
    console.log('════════════════════════════════════════');

    res.json({
      success: true,
      message: imagePaths.length + ' image(s) uploaded successfully.',
      images_saved: imagePaths.length,
      task: taskResult.rows[0].task_name,
      date: date
    });
  } catch (err) {
    console.error('[ROUTE] POST /tasks/' + taskId + '/images ERROR:', err);
    res.status(500).json({ error: 'Failed to save images.' });
  }
};

// ─── GET IMAGES FOR A TASK ────────────────────────────────────────────────────
exports.getTaskImages = async function(req, res) {
  const taskId = req.params.id;
  const date = req.query.date || new Date().toISOString().split('T')[0];
  console.log('[ROUTE] GET /tasks/' + taskId + '/images?date=' + date);
  try {
    const result = await pool.query(
      'SELECT image_paths, upload_date, status FROM task_images WHERE task_id = $1 AND upload_date = $2',
      [taskId, date]
    );
    if (result.rows.length === 0) {
      console.log('[ROUTE] GET /tasks/' + taskId + '/images → no uploads for', date);
      return res.json({ success: true, images: [], status: 'no uploads yet', date: date });
    }
    const images = result.rows[0].image_paths;
    console.log('[ROUTE] GET /tasks/' + taskId + '/images → found', images.length, 'image(s), status:', result.rows[0].status);
    res.json({
      success: true,
      date: date,
      status: result.rows[0].status,
      images: images
    });
  } catch (err) {
    console.error('[ROUTE] GET /tasks/' + taskId + '/images ERROR:', err);
    res.status(500).json({ error: 'Failed to fetch images.' });
  }
};

// ─── GET REPORT FOR A TASK ────────────────────────────────────────────────────
exports.getTaskReport = async function(req, res) {
  const taskId = req.params.id;
  const date = req.query.date || new Date().toISOString().split('T')[0];
  console.log('[ROUTE] GET /tasks/' + taskId + '/report?date=' + date);
  try {
    const result = await pool.query(
      `SELECT r.id, r.report_date, r.observations, r.report_text,
              r.status, r.created_at,
              t.task_name, u.full_name AS assignee
       FROM reports r
       JOIN tasks t ON t.id = r.task_id
       LEFT JOIN users u ON u.id = t.assignee_id
       WHERE r.task_id = $1 AND r.report_date = $2`,
      [taskId, date]
    );
    if (result.rows.length === 0) {
      console.log('[ROUTE] GET /tasks/' + taskId + '/report → no report yet for', date);
      return res.json({ success: true, message: 'No report yet for this date.', report: null });
    }
    const report = result.rows[0];
    console.log('[ROUTE] GET /tasks/' + taskId + '/report → ✅ found report, status:', report.status, '| report_text length:', report.report_text?.length || 0);
    res.json({ success: true, report: report });
  } catch (err) {
    console.error('[ROUTE] GET /tasks/' + taskId + '/report ERROR:', err);
    res.status(500).json({ error: 'Failed to fetch report.' });
  }
};

// ─── GENERATE REPORT NOW ──────────────────────────────────────────────────────
exports.generateReportNow = async function(req, res) {
  const taskId = req.params.id;
  const date = new Date().toISOString().split('T')[0];

  console.log('════════════════════════════════════════');
  console.log('[ROUTE] POST /tasks/' + taskId + '/generate-report');
  console.log('  date:', date);

  try {
    const taskResult = await pool.query(
      `SELECT t.id, t.task_name, t.site_instructions,
              p.name AS project_name,
              u.full_name AS assignee
       FROM tasks t
       LEFT JOIN projects p ON p.id = t.project_id
       LEFT JOIN users u ON u.id = t.assignee_id
       WHERE t.id = $1`,
      [taskId]
    );
    if (taskResult.rows.length === 0) {
      console.warn('[ROUTE] POST generate-report → 404 task not found:', taskId);
      return res.status(404).json({ error: 'Task not found.' });
    }

    const task = taskResult.rows[0];
    console.log('  task_name  :', task.task_name);
    console.log('  project    :', task.project_name || 'N/A');
    console.log('  assignee   :', task.assignee || 'N/A');

    // ✅ Delete old report for today so poll won't pick up stale data
    await pool.query(
      'DELETE FROM reports WHERE task_id = $1 AND report_date = $2',
      [taskId, date]
    );
    console.log('  🗑️  Cleared old report for today (if any)');

    const imgResult = await pool.query(
      `SELECT image_paths FROM task_images
       WHERE task_id = $1 AND upload_date = $2 AND status = 'pending'`,
      [taskId, date]
    );
    if (imgResult.rows.length === 0) {
      console.warn('[ROUTE] POST generate-report → 400 no pending images for', date);
      return res.status(400).json({ error: 'No pending images for today. Upload photos first.' });
    }

    const imagePaths = imgResult.rows[0].image_paths;
    console.log('  image_paths from DB:', imagePaths.length, 'path(s)');
    imagePaths.forEach((p, i) => console.log('    [' + i + ']', p));
    console.log('════════════════════════════════════════');

    // Respond immediately — AI runs in background
    res.json({
      success: true,
      message: 'Report generation started. Check back in a few minutes.',
      task: task.task_name,
      images: imagePaths.length
    });

    // Run AI in background using the shared aiService (no more duplicated code)
    _processReportInBackground({ task, taskId, date, imagePaths });

  } catch (err) {
    console.error('[ROUTE] POST generate-report ERROR:', err);
    res.status(500).json({ error: 'Failed to trigger report generation.' });
  }
};

// ─── INTERNAL: Background AI processing (uses shared aiService) ──────────────
const { generateAIReport } = require('../services/aiService');

async function _processReportInBackground({ task, taskId, date, imagePaths }) {
  try {
    console.log('[AI] Background report generation started for task:', task.task_name);

    const { report, observations } = await generateAIReport({
      task:       { task_name: task.task_name, project_name: task.project_name, assignee: task.assignee },
      taskId,
      date,
      imagePaths,
    });

    if (!report || report.trim().length === 0) {
      throw new Error('AI returned empty report text');
    }

    // Save report to DB
    await pool.query(
      `INSERT INTO reports (task_id, report_date, observations, report_text, status)
       VALUES ($1, $2, $3::jsonb, $4, 'completed')
       ON CONFLICT (task_id, report_date)
       DO UPDATE SET
         observations = $3::jsonb,
         report_text  = $4,
         status       = 'completed'`,
      [taskId, date, JSON.stringify(observations), report]
    );

    // Mark images as processed
    await pool.query(
      'UPDATE task_images SET status = $1 WHERE task_id = $2 AND upload_date = $3',
      ['processed', taskId, date]
    );

    console.log('[AI] ✅ Report saved to DB — task:', task.task_name, '| date:', date);
  } catch (err) {
    console.error('[AI] ❌ Report generation FAILED for task:', taskId, '—', err.message);
    await pool.query(
      'UPDATE task_images SET status = $1 WHERE task_id = $2 AND upload_date = $3',
      ['failed', taskId, date]
    ).catch(e => console.error('[AI] Failed to update image status:', e));
  }
}
// ============================================================
// UPLOAD ENGINEER REPORT TO ADMIN
// POST /tasks/:id/reports
// ============================================================

exports.uploadTaskReport = async function(req, res) {

  const taskId =
    req.params.id || req.params.taskId;

  const {
    title,
    report_text,
    report_type
  } = req.body;

  console.log('════════════════════════════════════════');
  console.log('[UPLOAD ENGINEER REPORT]');
  console.log('TASK ID:', taskId);
  console.log('USER:', req.user?.email || 'Unknown');
  console.log('TITLE:', title);
  console.log('REPORT TYPE:', report_type);
  console.log(
    'REPORT LENGTH:',
    report_text?.length || 0
  );
  console.log('════════════════════════════════════════');

  try {

    // --------------------------------------------------------
    // VALIDATION
    // --------------------------------------------------------

    if (!taskId) {
      return res.status(400).json({
        success: false,
        message: 'Task ID is required.'
      });
    }

    if (!report_text || !report_text.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Report text is required.'
      });
    }


    // --------------------------------------------------------
    // FIND TASK + PROJECT
    // --------------------------------------------------------

    const taskResult = await pool.query(
      `
      SELECT
        t.id,
        t.task_name,
        t.project_id,
        t.assignee_id,

        p.code AS project_code,
        p.name AS project_name,

        u.full_name AS engineer_name,
        u.email AS engineer_email

      FROM tasks t

      LEFT JOIN projects p
        ON p.id = t.project_id

      LEFT JOIN users u
        ON u.id = t.assignee_id

      WHERE t.id = $1::uuid

      LIMIT 1
      `,
      [taskId]
    );


    if (taskResult.rows.length === 0) {

      console.log(
        '[UPLOAD ENGINEER REPORT] Task not found.'
      );

      return res.status(404).json({
        success: false,
        message: 'Task not found.'
      });
    }


    const task =
      taskResult.rows[0];


    if (!task.project_code) {

      return res.status(400).json({
        success: false,
        message:
          'The task is not connected to a project.'
      });
    }


    console.log(
      '[UPLOAD ENGINEER REPORT] PROJECT:',
      task.project_code
    );

    console.log(
      '[UPLOAD ENGINEER REPORT] TASK:',
      task.task_name
    );


    // --------------------------------------------------------
    // WHO SUBMITTED THE REPORT?
    // --------------------------------------------------------

    // Prefer authenticated mobile user.
    // Fall back to task assignee.
    const preparedBy =
      req.user?.id ||
      task.assignee_id ||
      null;


    // --------------------------------------------------------
    // INSERT INTO ADMIN PROJECT REPORTS
    // --------------------------------------------------------

    const result = await pool.query(
      `
      INSERT INTO project_reports (

        project_code,
        task_id,

        title,
        report_type,
        report_date,

        summary,

        key_activities,
        issues_highlighted,

        manpower_count,
        equipment_on_site,
        weather,

        status,

        prepared_by,
        source,

        created_at

      )

      VALUES (

        $1,
        $2,

        $3,
        $4,
        CURRENT_DATE,

        $5,

        NULL,
        NULL,

        0,
        NULL,
        NULL,

        'Submitted',

        $6,
        'Mobile Engineer',

        NOW()

      )

      RETURNING
        id,
        project_code,
        task_id,
        title,
        report_type,
        report_date,
        summary,
        status,
        prepared_by,
        source,
        created_at
      `,
      [
        task.project_code,

        taskId,

        title ||
          `AI Field Report - ${task.task_name}`,

        report_type ||
          'AI Field Report',

        report_text.trim(),

        preparedBy
      ]
    );


    const uploadedReport =
      result.rows[0];


    console.log('════════════════════════════════════════');
    console.log('✅ ENGINEER REPORT UPLOADED');
    console.log(
      'REPORT ID:',
      uploadedReport.id
    );
    console.log(
      'PROJECT:',
      uploadedReport.project_code
    );
    console.log(
      'TASK:',
      task.task_name
    );
    console.log(
      'ENGINEER:',
      task.engineer_name ||
      req.user?.email ||
      'Unknown'
    );
    console.log('════════════════════════════════════════');


    return res.status(201).json({

      success: true,

      message:
        'Report uploaded to admin successfully.',

      data: uploadedReport

    });


  } catch (err) {

    console.error('════════════════════════════════════════');
    console.error('❌ UPLOAD ENGINEER REPORT ERROR');
    console.error('MESSAGE:', err.message);
    console.error('CODE:', err.code);
    console.error(err);
    console.error('════════════════════════════════════════');


    return res.status(500).json({

      success: false,

      message:
        'Failed to upload report.',

      error:
        err.message

    });
  }
};