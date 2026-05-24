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
exports.getTasks = async function(req, res) {
  console.log('[ROUTE] GET /tasks  project_id:', req.query.project_id || 'none');
  try {
    const project_id = req.query.project_id;
    const result = await pool.query(
      `SELECT
         t.id, t.task_name, t.phase, t.project_id,
         p.name AS project_name, p.code AS project_code,
         u.full_name AS assignee, u.id AS assignee_id,
         TO_CHAR(t.due_date, 'Mon DD, YYYY') AS due_date,
         t.priority, t.status, t.manpower_needed,
         t.materials_required, t.site_instructions
       FROM tasks t
       LEFT JOIN users u ON u.id = t.assignee_id
       LEFT JOIN projects p ON p.id = t.project_id
       WHERE ($1::uuid IS NULL OR t.project_id = $1::uuid)
       ORDER BY t.phase, t.created_at DESC`,
      [project_id || null]
    );
    console.log('[ROUTE] GET /tasks → returned', result.rows.length, 'task(s)');
    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error('[ROUTE] GET /tasks ERROR:', err);
    res.status(500).json({ error: 'Failed to fetch tasks.' });
  }
};

// ─── GET TASK BY ID ───────────────────────────────────────────────────────────
exports.getTaskById = async function(req, res) {
  console.log('[ROUTE] GET /tasks/' + req.params.id);
  try {
    const id = req.params.id;
    const result = await pool.query(
      `SELECT
         t.id, t.task_name, t.phase,
         u.full_name AS assignee,
         TO_CHAR(t.due_date, 'Mon DD, YYYY') AS due_date,
         t.priority, t.status, t.manpower_needed,
         t.materials_required, t.site_instructions
       FROM tasks t
       LEFT JOIN users u ON u.id = t.assignee_id
       WHERE t.id = $1`,
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
  console.log('[ROUTE] PATCH /tasks/' + req.params.id + '/status → ', req.body.status);
  try {
    const id = req.params.id;
    const status = req.body.status;
    const allowed = ['Pending', 'In Progress', 'Completed'];
    if (!allowed.includes(status)) {
      return res.status(400).json({ error: 'Invalid status value.' });
    }
    const result = await pool.query(
      `UPDATE tasks SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
      [status, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Task not found.' });
    }
    console.log('[ROUTE] PATCH /tasks/' + id + '/status → updated to:', status);
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    console.error('[ROUTE] PATCH /tasks/:id/status ERROR:', err);
    res.status(500).json({ error: 'Failed to update task status.' });
  }
};

// ─── CREATE TASK ──────────────────────────────────────────────────────────────
exports.createTask = async function(req, res) {
  console.log('[ROUTE] POST /tasks → creating task:', req.body.taskName);
  try {
    const taskName = req.body.taskName;
    const phase = req.body.phase;
    const assigneeId = req.body.assigneeId;
    const dueDate = req.body.dueDate;
    const priority = req.body.priority;
    const manpowerNeeded = req.body.manpowerNeeded;
    const materialsRequired = req.body.materialsRequired;
    const siteInstructions = req.body.siteInstructions;
    const projectId = req.body.projectId;

    const result = await pool.query(
      `INSERT INTO tasks
         (task_name, phase, assignee_id, due_date, priority,
          manpower_needed, materials_required, site_instructions,
          project_id, status)
       VALUES ($1, $2, $3::uuid, $4, $5, $6, $7, $8, $9, 'Pending')
       RETURNING *`,
      [taskName, phase, assigneeId, dueDate, priority,
       manpowerNeeded, materialsRequired, siteInstructions, projectId || null]
    );
    console.log('[ROUTE] POST /tasks → created task id:', result.rows[0].id);
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (err) {
    console.error('[ROUTE] POST /tasks ERROR:', err);
    res.status(500).json({ error: 'Failed to create task.' });
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

    _callAIAndSave({ task: task, taskId: taskId, date: date, imagePaths: imagePaths });

  } catch (err) {
    console.error('[ROUTE] POST generate-report ERROR:', err);
    res.status(500).json({ error: 'Failed to trigger report generation.' });
  }
};

// ─── INTERNAL: Call Python AI service and save result ────────────────────────
function _callAIAndSave(opts) {
  var task      = opts.task;
  var taskId    = opts.taskId;
  var date      = opts.date;
  var imagePaths = opts.imagePaths;

  console.log('════════════════════════════════════════');
  console.log('[AI] _callAIAndSave started');
  console.log('  task_id   :', taskId);
  console.log('  task_name :', task.task_name);
  console.log('  date      :', date);
  console.log('  paths     :', imagePaths.length, 'image(s) to load from disk');

  // Convert images to base64
  var base64Images = [];
  for (var i = 0; i < imagePaths.length; i++) {
    var imgPath = imagePaths[i];
    if (fs.existsSync(imgPath)) {
      var buffer = fs.readFileSync(imgPath);
      base64Images.push(buffer.toString('base64'));
      console.log('  [' + i + '] ✅ Loaded:', path.basename(imgPath), '(' + Math.round(buffer.length / 1024) + ' KB)');
    } else {
      console.warn('  [' + i + '] ❌ NOT FOUND on disk:', imgPath);
    }
  }

  if (base64Images.length === 0) {
    console.error('[AI] ❌ No valid images found on disk — aborting AI call.');
    console.error('[AI] Check that the upload paths in DB match actual disk paths.');
    return;
  }

  console.log('[AI] Sending', base64Images.length, 'image(s) to Python →', AI_SERVICE_URL + '/generate-report');
  console.log('════════════════════════════════════════');

  var payload = JSON.stringify({
    task_id:     taskId,
    task_name:   task.task_name,
    location:    task.project_name || 'N/A',
    assigned_to: task.assignee     || 'N/A',
    date:        date,
    images:      base64Images,
  });

  fetch(AI_SERVICE_URL + '/generate-report', {
    method:  'POST',
    body:    payload,
    headers: { 'Content-Type': 'application/json' },
    signal:  AbortSignal.timeout(600000) // 10 min timeout for CPU
  })
  .then(function(response) {
    console.log('[AI] Python responded with HTTP', response.status);
    if (!response.ok) {
      return response.text().then(function(txt) {
        throw new Error('AI service HTTP ' + response.status + ': ' + txt);
      });
    }
    return response.json();
  })
  .then(function(result) {
    console.log('════════════════════════════════════════');
    console.log('[AI] ✅ Python response received:');
    console.log('  images_analyzed :', result.images_analyzed);
    console.log('  report length   :', result.report ? result.report.length : 0, 'chars');
    console.log('  observations    :', JSON.stringify(
      (result.observations || []).map(function(o) {
        return { work_progress: (o.work_progress || '').substring(0, 60) };
      })
    ));

    if (!result.report || result.report.trim().length === 0) {
      throw new Error('Python returned empty report text');
    }

    return pool.query(
      `INSERT INTO reports (task_id, report_date, observations, report_text, status)
       VALUES ($1, $2, $3::jsonb, $4, 'completed')
       ON CONFLICT (task_id, report_date)
       DO UPDATE SET
         observations = $3::jsonb,
         report_text  = $4,
         status       = 'completed'`,
      [taskId, date, JSON.stringify(result.observations), result.report]
    ).then(function() {
      return pool.query(
        'UPDATE task_images SET status = $1 WHERE task_id = $2 AND upload_date = $3',
        ['processed', taskId, date]
      );
    }).then(function() {
      console.log('[AI] ✅ Report saved to DB — task:', task.task_name, '| date:', date);
      console.log('════════════════════════════════════════');
    });
  })
  .catch(function(err) {
    console.error('════════════════════════════════════════');
    console.error('[AI] ❌ Report generation FAILED for task:', taskId);
    console.error('[AI] Error:', err.message);
    console.error('════════════════════════════════════════');
    pool.query(
      'UPDATE task_images SET status = $1 WHERE task_id = $2 AND upload_date = $3',
      ['failed', taskId, date]
    ).catch(function(e) { console.error('[AI] Failed to update image status:', e); });
  });
}