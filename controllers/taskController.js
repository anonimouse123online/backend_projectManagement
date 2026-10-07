const pool = require('../db');
const taskPhases = require('../services/taskPhaseService');
const workStatuses = require('../services/taskWorkStatusService');
const taskResources = require('../services/taskResourceService');
const money = require('../services/moneyService');
const { createTaskDiagnostics } = require('../services/taskCreationDiagnostics');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const FormData = require('form-data');

const AI_SERVICE_URL = process.env.AI_SERVICE_URL || 'http://localhost:8000';

// ============================================================
// AUTH + PROJECT/TASK ACCESS HELPERS
// ============================================================

const requireAuth = (req, res) => {
  if (req.user?.id) {
    return true;
  }

  res.status(401).json({
    success: false,
    message: 'Authentication required.'
  });

  return false;
};


// ============================================================
// CHECK PROJECT ACCESS
//
// Access allowed when:
// 1. User owns project
// 2. User joined project
//
// project_members.project_id -> projects.code
// ============================================================

const getAccessibleProject = async (
  projectIdentifier,
  userId,
  db = pool
) => {

  if (!userId || !projectIdentifier) {
    return null;
  }

  const { rows } = await db.query(
    `
    SELECT
      p.id,
      p.code,
      p.name,
      p.owner_id,
      TO_CHAR(p.start_date, 'YYYY-MM-DD') AS start_date,
      TO_CHAR(p.end_date, 'YYYY-MM-DD') AS end_date

    FROM projects p

    WHERE
      (
        p.id::text = $1::text
        OR p.code = $1
        OR p.name ILIKE $1
      )

      AND (
        p.owner_id = $2::uuid

        OR EXISTS (
          SELECT 1

          FROM project_members pm

          WHERE pm.project_id = p.code
            AND pm.user_id = $2::uuid
        )
      )

    LIMIT 1
    `,
    [
      projectIdentifier,
      userId
    ]
  );

  return rows[0] || null;
};


// ============================================================
// CHECK TASK ACCESS
//
// User can access a task when:
// 1. They own its project
// 2. They joined its project
// 3. They are the assigned engineer
// ============================================================

const getAccessibleTask = async (
  taskId,
  userId,
  db = pool
) => {

  if (!taskId || !userId) {
    return null;
  }

  const { rows } = await db.query(
    `
    SELECT
      t.id,
      t.task_name,
      t.project_id,
      t.assignee_id,

      p.code AS project_code,
      p.name AS project_name,
      p.location AS project_location,
      p.status AS project_status,
      p.owner_id

    FROM tasks t

    INNER JOIN projects p
      ON p.id = t.project_id

    WHERE t.id::text = $1::text

      AND (
        p.owner_id = $2::uuid

        OR t.assignee_id = $2::uuid

        OR EXISTS (
          SELECT 1

          FROM project_members pm

          WHERE pm.project_id = p.code
            AND pm.user_id = $2::uuid
        )
      )

    LIMIT 1
    `,
    [
      taskId,
      userId
    ]
  );

  return rows[0] || null;
};

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
// ============================================================
// GET ALL TASKS
// GET /tasks
// ============================================================

// ============================================================
// GET ALL ACCESSIBLE TASKS
// GET /tasks
//
// Admin:
// - tasks from owned projects
// - tasks from joined projects
//
// Engineer:
// - tasks assigned directly to them
// - tasks from projects they joined
// ============================================================

exports.getTasks = async function (req, res) {

  if (!requireAuth(req, res)) {
    return;
  }

  const {
    project_id,
    status,
    phase,
    priority,
    assignee_id,
    search
  } = req.query;


  const userId =
    req.user.id;


  console.log('======================================');
  console.log('[GET TASKS]');
  console.log('USER:', req.user?.email);
  console.log('USER ID:', userId);
  console.log('PROJECT:', project_id || 'ALL');
  console.log('======================================');


  try {

    // ============================================================
    // ACCESS CONDITION
    // ============================================================

    const conditions = [
      `
      (
        p.owner_id = $1::uuid

        OR t.assignee_id = $1::uuid

        OR EXISTS (
          SELECT 1

          FROM project_members pm

          WHERE pm.project_id = p.code
            AND pm.user_id = $1::uuid
        )
      )
      `
    ];


    const params = [
      userId
    ];


    // ============================================================
    // PROJECT FILTER
    //
    // Frontend may send:
    // PRJ-2026-824
    // OR actual UUID
    // ============================================================

    if (
      project_id &&
      project_id !== 'All'
    ) {

      params.push(
        project_id
      );


      conditions.push(`
        (
          p.id::text = $${params.length}::text
          OR p.code = $${params.length}
          OR p.name ILIKE $${params.length}
        )
      `);
    }


    // ============================================================
    // STATUS FILTER
    // ============================================================

    if (
      status &&
      status !== 'All' &&
      status !== 'All Statuses'
    ) {

      const normalized = workStatuses.displayStatus(status);
      if (['pending', 'ongoing'].includes(normalized)) {
        params.push(normalized === 'ongoing' ? ['ongoing', 'in progress', 'in-progress'] : ['pending']);
        conditions.push(`LOWER(TRIM(t.status)) = ANY($${params.length}::text[])`);
      } else {
        params.push(`%${status.replace('-', '%')}%`);
        conditions.push(`t.status ILIKE $${params.length}`);
      }
    }


    // ============================================================
    // PHASE FILTER
    // ============================================================

    if (
      phase &&
      phase !== 'All'
    ) {

      params.push(
        taskPhases.filterValue(phase)
      );


      conditions.push(
        taskPhases.filterPhases(params.length)
      );
    }


    // ============================================================
    // PRIORITY FILTER
    // ============================================================

    if (
      priority &&
      priority !== 'All'
    ) {

      params.push(
        priority
      );


      conditions.push(
        `t.priority ILIKE $${params.length}`
      );
    }


    // ============================================================
    // ASSIGNEE FILTER
    // ============================================================

    if (assignee_id) {

      params.push(
        assignee_id
      );


      conditions.push(`
        (
          t.assignee_id::text =
            $${params.length}::text

          OR u.full_name
            ILIKE $${params.length}

          OR u.email
            ILIKE $${params.length}
        )
      `);
    }


    // ============================================================
    // SEARCH
    // ============================================================

    if (
      search &&
      search.trim()
    ) {

      params.push(
        `%${search.trim()}%`
      );


      conditions.push(`
        (
          t.task_name
            ILIKE $${params.length}

          OR COALESCE(
            t.site_instructions,
            ''
          ) ILIKE $${params.length}

          OR p.name
            ILIKE $${params.length}

          OR p.code
            ILIKE $${params.length}

          OR COALESCE(
            u.full_name,
            ''
          ) ILIKE $${params.length}
        )
      `);
    }


    // ============================================================
    // QUERY
    // ============================================================

    const query = `
      SELECT

        t.id,

        COALESCE(
          t.task_name,
          'Untitled Task'
        ) AS task_name,

        t.phase,
        ${taskPhases.selectPhases()},

        t.project_id,

        p.name
          AS project_name,

        p.code
          AS project_code,

        p.location
          AS project_location,

        p.status
          AS project_status,

        p.owner_id,

        CASE
          WHEN p.owner_id = $1::uuid
            THEN 'owner'

          WHEN t.assignee_id = $1::uuid
            THEN 'assignee'

          ELSE 'member'
        END AS access_type,

        u.full_name
          AS assignee,

        u.id
          AS assignee_id,

        /*
         * IMPORTANT:
         * Do not force ::date here.
         *
         * Some older rows may contain legacy due_date values.
         * Returning text prevents one bad old row from crashing
         * GET /tasks.
         */
        t.due_date::text
          AS due_date,

        t.priority,

        t.status,

        

        t.materials_required,

        t.site_instructions,

        COALESCE(
          t.subtasks,
          '[]'::jsonb
        ) AS subtasks,

        COALESCE(t.progress_pct, 0) AS progress_pct


      FROM tasks t


      INNER JOIN projects p
        ON p.id = t.project_id


      LEFT JOIN users u
        ON u.id = t.assignee_id


      WHERE
        ${conditions.join(' AND ')}


      ORDER BY

        t.phase NULLS LAST,

        t.created_at DESC
    `;


    const result =
      await pool.query(
        query,
        params
      );

    const tasks = await taskResources.withResources(result.rows, pool);


    console.log(
      '[GET TASKS] returned',
      result.rows.length,
      'task(s)'
    );


    return res.status(200).json({

      success: true,

      data:
        tasks.map(workStatuses.taskFields)

    });


  } catch (err) {

    console.error('======================================');
    console.error('❌ GET TASKS ERROR');
    console.error('MESSAGE:', err.message);
    console.error('CODE:', err.code);
    console.error('USER:', req.user);
    console.error('======================================');


    return res.status(500).json({

      success: false,

      error:
        'Failed to fetch tasks.',

      details:
        err.message

    });
  }
};

// ─── GET TASK BY ID ───────────────────────────────────────────────────────────
// ============================================================
// GET TASK BY ID
// GET /tasks/:id
// ============================================================

// ============================================================
// GET TASK BY ID
// GET /tasks/:id
// ============================================================

exports.getTaskById = async function (req, res) {

  if (!requireAuth(req, res)) {
    return;
  }


  const id =
    req.params.id;


  try {

    const access =
      await getAccessibleTask(
        id,
        req.user.id
      );


    if (!access) {

      return res.status(404).json({
        success: false,
        error:
          'Task not found or you do not have access.'
      });
    }


    const result =
      await pool.query(
        `
        SELECT

          t.id,

          COALESCE(
            t.task_name,
            'Untitled Task'
          ) AS task_name,

          t.phase,
          ${taskPhases.selectPhases()},

          t.project_id,

          u.full_name
            AS assignee,

          u.id
            AS assignee_id,

          t.due_date::text
            AS due_date,

          t.priority,

          t.status,

          

          t.materials_required,

          t.site_instructions,

          p.name
            AS project_name,

          p.code
            AS project_code,

          p.location
            AS project_location,

          p.status
            AS project_status,

          COALESCE(t.progress_pct, 0) AS progress_pct,

          COALESCE(
            t.subtasks,
            '[]'::jsonb
          ) AS subtasks,


          CASE

            WHEN p.owner_id = $2::uuid
              THEN 'owner'

            WHEN t.assignee_id = $2::uuid
              THEN 'assignee'

            ELSE 'member'

          END AS access_type


        FROM tasks t


        INNER JOIN projects p
          ON p.id = t.project_id


        LEFT JOIN users u
          ON u.id = t.assignee_id


        WHERE t.id::text =
          $1::text


          AND (

            p.owner_id =
              $2::uuid


            OR t.assignee_id =
              $2::uuid


            OR EXISTS (

              SELECT 1

              FROM project_members pm

              WHERE pm.project_id =
                p.code

                AND pm.user_id =
                  $2::uuid

            )

          )


        LIMIT 1
        `,
        [
          id,
          req.user.id
        ]
      );


    if (
      result.rows.length === 0
    ) {

      return res.status(404).json({
        success: false,
        error:
          'Task not found or you do not have access.'
      });
    }


    const [task] = await taskResources.withResources(result.rows, pool);

    return res.status(200).json({

      success: true,

      data:
        workStatuses.taskFields(task)

    });


  } catch (err) {

    console.error(
      'GET /tasks/:id error:',
      err
    );


    return res.status(500).json({

      success: false,

      error:
        'Failed to fetch task.',

      details:
        err.message

    });
  }
};  

// ============================================================
// SYNC PROJECT PROGRESS FROM TASKS & SUBTASKS
// ============================================================
const syncProjectProgress = async (projectId, db = pool) => {
  if (!projectId) return 0;

  try {
    const tasksRes = await db.query(
      `SELECT id, status, progress_pct, subtasks
       FROM tasks
       WHERE project_id = $1::uuid`,
      [projectId]
    );

    const tasks = tasksRes.rows;
    if (tasks.length === 0) return 0;

    let totalTaskScore = 0;
    for (const t of tasks) {
      const isCompleted = (t.status || '').toLowerCase().includes('completed');
      const isOngoing = (t.status || '').toLowerCase().includes('progress') || (t.status || '').toLowerCase().includes('ongoing');
      const subs = Array.isArray(t.subtasks) ? t.subtasks : [];

      if (subs.length > 0) {
        const done = subs.filter((s) => s && s.completed).length;
        totalTaskScore += done / subs.length;
      } else {
        if (isCompleted) {
          totalTaskScore += 1;
        } else if (isOngoing) {
          const pPct = Number(t.progress_pct);
          totalTaskScore += !isNaN(pPct) && pPct > 0 ? pPct / 100 : 0.5;
        } else {
          totalTaskScore += 0;
        }
      }
    }

    const overallPct = Math.min(100, Math.max(0, Math.round((totalTaskScore / tasks.length) * 100)));

    const targetStatus = overallPct === 100 ? 'Completed' : overallPct > 0 ? 'Ongoing' : 'Pending';

    await db.query(
      `UPDATE projects
       SET progress = $1,
           progress_pct = $1,
           status = COALESCE($2, status),
           updated_at = NOW()
       WHERE id = $3::uuid`,
      [overallPct, targetStatus, projectId]
    );

    return overallPct;
  } catch (err) {
    console.error('syncProjectProgress error:', err.message);
    if (db !== pool) throw err;
    return 0;
  }
};

exports.syncProjectProgress = syncProjectProgress;

// ─── UPDATE TASK STATUS ───────────────────────────────────────────────────────
function statusFailure(res, error) {
  if (error instanceof workStatuses.WorkStatusError) return res.status(error.status).json({ success: false, error: error.message });
  if (['23514', '22P02', '22003'].includes(error.code)) return res.status(400).json({ success: false, error: 'Invalid task status or progress.' });
  console.error('Task work-status error:', error);
  return res.status(500).json({ success: false, error: 'Failed to update task status.' });
}

function requestProgress(body) {
  if (Object.hasOwn(body, 'progress_pct') && Object.hasOwn(body, 'progress') &&
      workStatuses.progressValue(body.progress_pct) !== workStatuses.progressValue(body.progress)) {
    throw new workStatuses.WorkStatusError(400, 'progress and progress_pct must agree.');
  }
  return Object.hasOwn(body, 'progress_pct') ? body.progress_pct : body.progress;
}

exports.updateTaskStatus = async function (req, res) {
  if (!requireAuth(req, res)) return;
  try {
    const body = req.body || {};
    const progress = requestProgress(body);
    const data = await workStatuses.saveWorkStatus({ taskId: req.params.id, userId: req.user.id,
      user: req.user, status: body.status, progress }, pool, getAccessibleTask);
    if (progress !== undefined || ['completed', 'done'].includes(workStatuses.displayStatus(body.status))) {
      await syncProjectProgress(data.project_id);
    }
    return res.status(200).json({ success: true, data });
  } catch (error) { return statusFailure(res, error); }
};

// ============================================================
// COMPLETE TASK
// PATCH /tasks/:id/complete
// ============================================================

// ============================================================
// COMPLETE TASK
// PATCH /tasks/:id/complete
// ============================================================

exports.completeTask = async function (req, res) {
  if (!requireAuth(req, res)) return;
  try {
    const data = await workStatuses.saveWorkStatus({ taskId: req.params.id || req.params.taskId,
      userId: req.user.id, user: req.user, status: 'completed' }, pool, getAccessibleTask);
    await syncProjectProgress(data.project_id);
    return res.status(200).json({ success: true, message: 'Task marked as completed successfully.', data });
  } catch (error) { return statusFailure(res, error); }
};

// Existing route handles both individual status updates and legacy checkbox arrays.

exports.updateTaskSubtasks = async function (req, res) {
  if (!requireAuth(req, res)) return;
  try {
    const body = req.body || {};
    let data;
    if (Object.hasOwn(body, 'subtask_id')) {
      data = await workStatuses.saveWorkStatus({ taskId: req.params.id, userId: req.user.id,
        user: req.user, subtaskId: body.subtask_id, status: body.status, progress: requestProgress(body) }, pool, getAccessibleTask);
    } else {
      const saved = await workStatuses.saveSubtasks({ taskId: req.params.id, user: req.user, subtasks: body.subtasks }, pool, getAccessibleTask);
      data = saved.data;
      if (saved.completionChanged) await syncProjectProgress(data.project_id);
    }
    return res.status(200).json({ success: true, data });
  } catch (error) { return statusFailure(res, error); }
};

// POST /tasks: existing metadata, category, resource and project-progress workflow.

exports.createTask = async function (req, res) {

  if (!requireAuth(req, res)) {
    return;
  }

  console.log(
    '[POST /tasks]',
    req.body.taskName ||
    req.body.task_name
  );

  // Keep these outside try{} so catch{} can access them
  let receivedPhase = '';
  let phase = '';
  let client;
  let transaction = false;
  let db;
  const diagnostics = createTaskDiagnostics();

  try {

    // ============================================================
    // REQUEST DATA
    // ============================================================

    const taskName = (
      req.body.taskName ||
      req.body.task_name ||
      ''
    ).trim();


    // ============================================================
    // PHASE
    // ============================================================

    const phases = taskPhases.phasesOf(req.body, true);
    receivedPhase = req.body.construction_phase_categories || req.body.phases || req.body.phase;
    phase = phases[0]; // Deprecated scalar compatibility value only.


    console.log('======================================');
    console.log('CREATE TASK PHASE');
    console.log('FRONTEND PHASE:', receivedPhase);
    console.log('DATABASE PHASE:', phase);
    console.log('======================================');


    let assigneeId = (
      req.body.assigneeId ||
      req.body.assignee_id ||
      ''
    ).trim();


    const startDate = (
      req.body.startDate ||
      req.body.start_date ||
      ''
    ).trim();

    const dueDate = (
      req.body.dueDate ||
      req.body.due_date ||
      ''
    ).trim();


    const priority = (
      req.body.priority ||
      ''
    ).trim();


    // manpowerNeeded field removed as it is no longer used


    const materialsRequired =
      (
        req.body.materialsRequired ||
        req.body.materials_required ||
        ''
      ).trim();


    const siteInstructions = (
      req.body.siteInstructions ||
      req.body.site_instructions ||
      ''
    ).trim();


    const projectIdentifier = (
      req.body.projectId ||
      req.body.project_id ||
      ''
    ).trim();


    // ============================================================
    // VALIDATION
    // ============================================================

    if (!taskName) {
      return res.status(400).json({
        success: false,
        error: 'Task name is required.'
      });
    }


    if (!projectIdentifier) {
      return res.status(400).json({
        success: false,
        error: 'Project is required.'
      });
    }


    if (!assigneeId) {
      return res.status(400).json({
        success: false,
        error: 'Assignee engineer is required.'
      });
    }


    if (!dueDate) {
      return res.status(400).json({
        success: false,
        error: 'Due date is required.'
      });
    }


    if (!priority) {
      return res.status(400).json({
        success: false,
        error:
          'Priority is required.'
      });
    }


    if (!materialsRequired) {
      return res.status(400).json({
        success: false,
        error: 'Materials required is required.'
      });
    }


    if (!siteInstructions) {
      return res.status(400).json({
        success: false,
        error: 'Site instructions are required.'
      });
    }

    const rawAllocated = req.body.allocatedMaterials || req.body.allocated_materials;
    const allocatedMaterials = Array.isArray(rawAllocated) ? rawAllocated.map(item => {
      if (!item || !item.name || !item.name.trim()) return item;
      return {
        ...item,
        quantity: money.quantityValue(item.quantity ?? 0, 'allocated material quantity'),
        unitPrice: money.moneyValue(item.unitPrice ?? item.unit_price ?? 0, 'allocated material unitPrice'),
      };
    }) : rawAllocated;


    // ============================================================
    // RESOLVE + AUTHORIZE PROJECT
    // ============================================================

    console.log('[CREATE TASK] acquiring database connection', { request_id: diagnostics.requestId });
    client = await pool.connect();
    db = diagnostics.wrap(client);
    const connection = await db.query("SELECT current_database(), current_schema(), current_setting('search_path') AS search_path");
    console.log('[CREATE TASK] database connection', { request_id: diagnostics.requestId, ...connection.rows[0] });

    const project =
      await getAccessibleProject(
        projectIdentifier,
        req.user.id,
        db
      );


    if (!project) {
      return res.status(403).json({
        success: false,
        error:
          'Project not found or you do not have access to it.'
      });
    }


    const resolvedProjectId = project.id;

    const todayStr = new Date().toISOString().split('T')[0];
    if (startDate && startDate < todayStr) {
      return res.status(400).json({
        success: false,
        error: 'Task start date cannot be a past date.'
      });
    }
    if (dueDate && dueDate < todayStr) {
      return res.status(400).json({
        success: false,
        error: 'Task due date cannot be a past date.'
      });
    }

    if (project.start_date) {
      const projStart = project.start_date;
      if (startDate && startDate < projStart) {
        return res.status(400).json({
          success: false,
          error: `Task start date cannot be earlier than project start date (${projStart}).`
        });
      }
      if (dueDate && dueDate < projStart) {
        return res.status(400).json({
          success: false,
          error: `Task due date cannot be earlier than project start date (${projStart}).`
        });
      }
    }

    if (project.end_date) {
      const projEnd = project.end_date;
      if (startDate && startDate > projEnd) {
        return res.status(400).json({
          success: false,
          error: `Task start date cannot exceed project end date (${projEnd}).`
        });
      }
      if (dueDate && dueDate > projEnd) {
        return res.status(400).json({
          success: false,
          error: `Task due date cannot exceed project end date (${projEnd}).`
        });
      }
    }


    // ============================================================
    // RESOLVE ASSIGNEE
    // ============================================================

    const isAssigneeUuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
        .test(assigneeId);


    let userResult;


    if (isAssigneeUuid) {

      userResult = await db.query(
        `
          SELECT
            id,
            full_name,
            email,
            role
          FROM users
          WHERE id = $1::uuid
            AND is_active = TRUE
          LIMIT 1
        `,
        [assigneeId]
      );

    } else {

      userResult = await db.query(
        `
          SELECT
            id,
            full_name,
            email,
            role
          FROM users
          WHERE
            (
              full_name ILIKE $1
              OR email ILIKE $1
            )
            AND is_active = TRUE
          LIMIT 1
        `,
        [assigneeId]
      );

    }


    if (userResult.rows.length === 0) {
      return res.status(400).json({
        success: false,
        error:
          'Selected assignee engineer was not found.'
      });
    }


    const assignee = userResult.rows[0];


    // ============================================================
    // ASSIGNEE MUST BELONG TO PROJECT
    // ============================================================

    const membership =
      await db.query(
        `
          SELECT id
          FROM project_members
          WHERE project_id = $1
            AND user_id = $2::uuid
          LIMIT 1
        `,
        [
          project.code,
          assignee.id
        ]
      );


    if (membership.rows.length === 0) {
      return res.status(400).json({
        success: false,
        error:
          `${assignee.full_name || assignee.email} is not a member of this project.`
      });
    }


    // ============================================================
    // ============================================================
    // PARSE SUBTASKS
    // ============================================================

    const rawSubtasks = req.body.subtasks;
    let initialSubtasks = [];
    if (Array.isArray(rawSubtasks)) {
      initialSubtasks = rawSubtasks
        .map((st, idx) => {
          if (typeof st === 'string') {
            return {
              id: `${Date.now()}_${idx}`,
              title: st.trim(),
              completed: false,
            };
          }
          if (st && typeof st === 'object') {
            return {
              id: String(st.id || `${Date.now()}_${idx}`),
              title: String(st.title || st.name || '').trim(),
              completed: Boolean(st.completed),
              ...(st.status === undefined ? {} : { status: st.status }),
              ...(st.progress === undefined ? {} : { progress: st.progress }),
              ...(st.progress_pct === undefined ? {} : { progress_pct: st.progress_pct }),
            };
          }
          return null;
        })
        .filter((st) => st && st.title.length > 0);
      initialSubtasks = workStatuses.mergeSubtasks([], initialSubtasks);
    }

    const doneCount = initialSubtasks.filter((s) => s.completed).length;
    const initialProgressPct =
      initialSubtasks.length > 0
        ? Math.round((doneCount / initialSubtasks.length) * 100)
        : 0;

    const initialStatus = workStatuses.databaseStatus(
      initialProgressPct === 100 ? 'completed' : initialProgressPct > 0 ? 'ongoing' : 'pending'
    );

    // ============================================================
    // CREATE TASK
    // ============================================================

    console.log('======================================');
    console.log('CREATING TASK');
    console.log('TASK:', taskName);
    console.log('PHASE:', phase);
    console.log('PROJECT:', resolvedProjectId);
    console.log('ASSIGNEE:', assignee.id);
    console.log('======================================');


    await db.query('BEGIN');
    transaction = true;

    const result =
      await db.query(
        `
        INSERT INTO tasks
        (
          task_name,
          phase,
          assignee_id,
          due_date,
          priority,

          materials_required,
          site_instructions,
          project_id,
          status,
          subtasks,
          progress_pct
        )
        VALUES
        (
          $1,
          $2,
          $3,
          $4,
          $5,

          $6,
          $7,
          $8,
          $9,
          $10,
          $11
        )
        RETURNING *
        `,
        [
          taskName,
          phase,
          assignee.id,
          dueDate,
          priority,

          materialsRequired,
          siteInstructions,
          resolvedProjectId,
          initialStatus,
          JSON.stringify(initialSubtasks),
          initialProgressPct,
        ]
      );

    await taskPhases.replacePhases(result.rows[0].id, phases, db);

    // Inspect the relation resolved by this connection's search_path, preserving older
    // databases whose resource status is an ordinary column rather than a generated one.
    const resourceColumn = await db.query(`SELECT n.nspname AS schema, c.relname AS table,
      a.attgenerated <> '' AS is_generated FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE a.attrelid = 'resources'::regclass AND a.attname = 'status' AND NOT a.attisdropped`);
    const generatedResourceStatus = resourceColumn.rows[0]?.is_generated === true;
    console.log('[CREATE TASK] resource status column', { request_id: diagnostics.requestId, ...resourceColumn.rows[0] });

    // ============================================================
    // SYNC MATERIALS & RESOURCES TO INVENTORY (resources table)
    // ============================================================
    try {
      const projectName = project.name;

      if (Array.isArray(allocatedMaterials) && allocatedMaterials.length > 0) {
        for (const item of allocatedMaterials) {
          if (!item || !item.name || !item.name.trim()) continue;

          const itemName = item.name.trim();
          const category = item.category === 'Equipment' ? 'Equipment' : 'Material';
          const supplier = (item.supplier || 'General Supplier').trim();
          const quantity = item.quantity;
          const unit = (item.unit || (category === 'Equipment' ? 'units' : 'bags')).trim();
          const minThreshold = parseInt(item.minThreshold || item.min_threshold) || 10;
          const unitPrice = item.unitPrice;

          // Check if resource already exists for this project
          const existingRes = await db.query(
            `SELECT id, COALESCE(quantity, 0)::numeric + $3::numeric AS new_quantity, min_threshold FROM resources
             WHERE LOWER(TRIM(name)) = LOWER(TRIM($1))
               AND LOWER(TRIM(project)) = LOWER(TRIM($2))
             LIMIT 1`,
            [itemName, projectName, quantity]
          );

          if (existingRes.rows.length > 0) {
            const current = existingRes.rows[0];
            const newQty = current.new_quantity;
            const status = Number(newQty) <= Number(current.min_threshold || 10)
              ? 'Low stock'
              : (category === 'Equipment' ? 'Available' : 'In stock');

            await db.query(
              `UPDATE resources
               SET quantity = $1${generatedResourceStatus ? '' : ', status = $2'},
                   updated_at = NOW()
               WHERE id = $${generatedResourceStatus ? 2 : 3}`,
              generatedResourceStatus ? [newQty, current.id] : [newQty, status, current.id]
            );
          } else {
            const status = quantity <= minThreshold
              ? (Number(quantity) === 0 ? 'Out of stock' : 'Low stock')
              : (category === 'Equipment' ? 'Available' : 'In stock');

            await db.query(
              `INSERT INTO resources
               (name, supplier, category, quantity, unit, min_threshold, unit_price, project${generatedResourceStatus ? '' : ', status'}, created_at, updated_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8${generatedResourceStatus ? '' : ', $9'}, NOW(), NOW())`,
              [itemName, supplier, category, quantity, unit, minThreshold, unitPrice, projectName, ...(generatedResourceStatus ? [] : [status])]
            );
          }
        }
      } else if (materialsRequired) {
        const parts = materialsRequired.split(',').map((p) => p.trim()).filter(Boolean);
        for (const part of parts) {
          const match = part.match(/^(\d+(?:\.\d+)?)\s*([a-zA-Z.]+)?\s+(.+)$/);
          let qty = 1;
          let unit = 'units';
          let name = part;
          if (match) {
            qty = money.quantityValue(match[1], 'material quantity');
            unit = match[2] || 'units';
            name = match[3].trim();
          }

          if (!name) continue;

          const existingRes = await db.query(
            `SELECT id, COALESCE(quantity, 0)::numeric + $3::numeric AS new_quantity, min_threshold FROM resources
             WHERE LOWER(TRIM(name)) = LOWER(TRIM($1))
               AND LOWER(TRIM(project)) = LOWER(TRIM($2))
             LIMIT 1`,
            [name, projectName, qty]
          );

          if (existingRes.rows.length > 0) {
            const current = existingRes.rows[0];
            const newQty = current.new_quantity;
            const status = Number(newQty) <= Number(current.min_threshold || 10) ? 'Low stock' : 'In stock';
            await db.query(
              `UPDATE resources
               SET quantity = $1${generatedResourceStatus ? '' : ', status = $2'}, updated_at = NOW()
               WHERE id = $${generatedResourceStatus ? 2 : 3}`,
              generatedResourceStatus ? [newQty, current.id] : [newQty, status, current.id]
            );
          } else {
            const status = qty <= 10 ? 'Low stock' : 'In stock';
            await db.query(
              `INSERT INTO resources
               (name, supplier, category, quantity, unit, min_threshold, unit_price, project${generatedResourceStatus ? '' : ', status'}, created_at, updated_at)
               VALUES ($1, 'General Supplier', 'Material', $2, $3, 10, 0, $4${generatedResourceStatus ? '' : ', $5'}, NOW(), NOW())`,
              [name, qty, unit, projectName, ...(generatedResourceStatus ? [] : [status])]
            );
          }
        }
      }
    } catch (resourceErr) {
      console.error('Failed to sync resources to inventory:', resourceErr.message);
      throw resourceErr;
    }

    await syncProjectProgress(resolvedProjectId, db);
    const createdTask = await taskPhases.withPhases(result.rows[0], db);
    await db.query('COMMIT');
    transaction = false;

    return res.status(201).json({

      success: true,

      message:
        'Task created successfully.',

      data:
        workStatuses.taskFields(createdTask)

    });


  } catch (err) {

    if (transaction) {
      try { await db.query('ROLLBACK'); }
      catch (rollbackError) { console.error('Task creation rollback failed:', rollbackError.message); }
    }
    if (err instanceof taskPhases.PhaseError || err instanceof workStatuses.WorkStatusError || err instanceof money.MoneyError) {
      return res.status(400).json({ success: false, message: err.message });
    }

    diagnostics.logError(err);

    console.error('======================================');
    console.error('❌ CREATE TASK ERROR');
    console.error('MESSAGE:', err.message);
    console.error('CODE:', err.code);

    console.error(
      'FRONTEND PHASE:',
      receivedPhase || req.body?.phase || 'NOT PROVIDED'
    );

    console.error(
      'DATABASE PHASE:',
      phase || 'NOT RESOLVED'
    );

    console.error('USER:', req.user);
    console.error('======================================');


    return res.status(500).json({

      success: false,

      error:
        'Failed to create task.',

      details:
        err.message

    });

  } finally { client?.release(); }

};
// Edit task metadata and category selections; status/assignment/subtasks retain their action routes.
exports.updateTask = async function (req, res) {
  if (!requireAuth(req, res)) return;
  let client;
  let transaction = false;
  try {
    const body = req.body || {};
    const phases = taskPhases.phasesOf(body);
    const changes = [];
    const values = [];
    const add = (column, value) => { values.push(value); changes.push(`${column} = $${values.length}`); };
    for (const [column, alias, max] of [
      ['task_name', 'taskName', 255], ['materials_required', 'materialsRequired', Infinity],
      ['site_instructions', 'siteInstructions', Infinity], ['priority', 'priority', 20],
    ]) {
      if (!Object.hasOwn(body, column) && !Object.hasOwn(body, alias)) continue;
      const value = Object.hasOwn(body, column) ? body[column] : body[alias];
      if (typeof value !== 'string' || !value.trim() || value.length > max) throw new taskPhases.PhaseError(`Invalid ${column}.`);
      if (column === 'priority' && !['High', 'Medium', 'Low'].includes(value.trim())) throw new taskPhases.PhaseError('Invalid priority.');
      add(column, value.trim());
    }
    if (phases) add('phase', phases[0]);
    if (!changes.length) throw new taskPhases.PhaseError('No update fields provided.');
    client = await pool.connect();
    await client.query('BEGIN'); transaction = true;
    const task = await getAccessibleTask(req.params.id, req.user.id, client);
    if (!task) {
      await client.query('ROLLBACK'); transaction = false;
      return res.status(404).json({ success: false, error: 'Task not found or you do not have access.' });
    }
    const locked = await client.query('SELECT id FROM tasks WHERE id = $1 FOR UPDATE', [task.id]);
    if (!locked.rows.length) {
      await client.query('ROLLBACK'); transaction = false;
      return res.status(404).json({ success: false, error: 'Task not found or you do not have access.' });
    }
    if (Object.hasOwn(body, 'phase') && !Object.hasOwn(body, 'phases') && !Object.hasOwn(body, 'construction_phase_categories')) {
      const current = await client.query('SELECT COUNT(*)::int AS count FROM task_phases WHERE task_id = $1', [task.id]);
      if (current.rows[0].count > 1) throw new taskPhases.PhaseError('Use phases to edit a task with multiple construction phase categories.');
    }
    values.push(task.id);
    const result = await client.query(`UPDATE tasks SET ${changes.join(', ')}, updated_at = NOW()
      WHERE id = $${values.length} RETURNING *`, values);
    if (phases) await taskPhases.replacePhases(task.id, phases, client);
    const updated = await taskPhases.withPhases(result.rows[0], client);
    await client.query('COMMIT'); transaction = false;
    return res.status(200).json({ success: true, message: 'Task updated successfully.', data: workStatuses.taskFields(updated) });
  } catch (error) {
    if (transaction) {
      try { await client.query('ROLLBACK'); }
      catch (rollbackError) { console.error('Task update rollback failed:', rollbackError.message); }
    }
    if (error instanceof taskPhases.PhaseError) return res.status(400).json({ success: false, message: error.message });
    console.error('updateTask error:', error);
    return res.status(500).json({ success: false, error: 'Failed to update task.' });
  } finally { client?.release(); }
};

// ─── ASSIGN TASK ──────────────────────────────────────────────────────────────
exports.assignTask = async function (
  req,
  res
) {

  if (!requireAuth(req, res)) {
    return;
  }


  const id =
    req.params.id;


  const {
    assigneeId
  } = req.body;


  if (!assigneeId) {

    return res.status(400).json({
      success: false,
      error:
        'assigneeId is required.'
    });
  }


  try {

    // ============================================================
    // CHECK TASK ACCESS
    // ============================================================

    const task =
      await getAccessibleTask(
        id,
        req.user.id
      );


    if (!task) {

      return res.status(404).json({
        success: false,
        error:
          'Task not found or you do not have access.'
      });
    }


    // ============================================================
    // CHECK USER
    // ============================================================

    const userResult =
      await pool.query(
        `
        SELECT
          id,
          full_name,
          email

        FROM users

        WHERE id = $1::uuid
          AND is_active = TRUE

        LIMIT 1
        `,
        [
          assigneeId
        ]
      );


    if (
      userResult.rows.length === 0
    ) {

      return res.status(404).json({
        success: false,
        error:
          'User not found.'
      });
    }


    // ============================================================
    // USER MUST BELONG TO TASK PROJECT
    // ============================================================

    const membership =
      await pool.query(
        `
        SELECT id

        FROM project_members

        WHERE project_id = $1
          AND user_id = $2::uuid

        LIMIT 1
        `,
        [
          task.project_code,
          assigneeId
        ]
      );


    if (
      membership.rows.length === 0
    ) {

      return res.status(400).json({
        success: false,
        error:
          'Selected user is not a member of this project.'
      });
    }


    // ============================================================
    // ASSIGN
    // ============================================================

    const result =
      await pool.query(
        `
        UPDATE tasks

        SET
          assignee_id = $1::uuid,
          updated_at = NOW()

        WHERE id = $2::uuid

        RETURNING *, ${taskPhases.selectPhases('tasks')}
        `,
        [
          assigneeId,
          id
        ]
      );


    return res.status(200).json({

      success: true,

      data:
        workStatuses.taskFields(result.rows[0])

    });


  } catch (err) {

    console.error(
      'assignTask error:',
      err
    );


    return res.status(500).json({
      success: false,
      error:
        'Failed to assign task.',
      details:
        err.message
    });
  }
};

// ─── GET USERS ────────────────────────────────────────────────────────────────
// Only returns users who share at least one project with the currently
// logged-in user. Active Tasks count is scoped to shared projects only.
exports.getUsers = async function(req, res) {
  const currentUserId = req.user?.id || req.user?.user_id || req.user?.userId;
  console.log('[ROUTE] GET /users — currentUser:', currentUserId);

  if (!currentUserId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const result = await pool.query(
      `WITH my_projects AS (
         -- All project UUIDs the current user has access to
         SELECT p.id AS project_uuid
         FROM projects p
         WHERE p.owner_id = $1::uuid
         UNION
         SELECT p.id AS project_uuid
         FROM projects p
         JOIN project_members pm ON pm.project_id = p.code
         WHERE pm.user_id = $1::uuid
       )
       SELECT
         u.id, u.full_name, u.email, u.role,
         COUNT(t.id) FILTER (WHERE t.status != 'Completed') AS current_tasks,
         CASE
           WHEN u.id = $1::uuid THEN 'self'
           WHEN EXISTS (
             SELECT 1 FROM project_members pm 
             JOIN projects p ON p.code = pm.project_id 
             WHERE pm.user_id = u.id AND p.owner_id = $1::uuid
           ) THEN 'my_member'
           WHEN EXISTS (
             SELECT 1 FROM projects p 
             JOIN project_members pm ON pm.project_id = p.code 
             WHERE p.owner_id = u.id AND pm.user_id = $1::uuid
           ) THEN 'project_owner'
           ELSE 'co_member'
         END AS relationship,
         (
           u.id != $1::uuid AND EXISTS (
             SELECT 1 FROM project_members pm 
             JOIN projects p ON p.code = pm.project_id 
             WHERE pm.user_id = u.id AND p.owner_id = $1::uuid
           )
         ) AS can_remove
       FROM users u
       LEFT JOIN tasks t
         ON t.assignee_id = u.id
         AND t.project_id IN (SELECT project_uuid FROM my_projects)
       WHERE u.is_active = TRUE
         AND (
           -- Users who share a project with the current user via project_members
           EXISTS (
             SELECT 1 FROM project_members pm
             WHERE pm.user_id = u.id
               AND pm.project_id IN (
                 SELECT pm2.project_id FROM project_members pm2
                 WHERE pm2.user_id = $1::uuid
               )
           )
           -- Or users who own a project that the current user is a member of
           OR EXISTS (
             SELECT 1 FROM projects p
             WHERE p.owner_id = u.id
               AND p.code IN (
                 SELECT pm3.project_id FROM project_members pm3
                 WHERE pm3.user_id = $1::uuid
               )
           )
           -- Or the current user owns a project that this user is a member of
           OR EXISTS (
             SELECT 1 FROM project_members pm4
             WHERE pm4.user_id = u.id
               AND pm4.project_id IN (
                 SELECT p2.code FROM projects p2
                 WHERE p2.owner_id = $1::uuid
               )
           )
           -- Include current user themselves if they have any project
           OR (
             u.id = $1::uuid
             AND EXISTS (
               SELECT 1 FROM project_members pm5 WHERE pm5.user_id = $1::uuid
               UNION
               SELECT 1 FROM projects p3 WHERE p3.owner_id = $1::uuid
             )
           )
         )
       GROUP BY u.id
       ORDER BY u.full_name ASC`,
      [currentUserId]
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
    const taskAccess =
  await getAccessibleTask(
    taskId,
    req.user.id
  );

if (!taskAccess) {

  return res.status(404).json({
    success: false,
    message:
      'Task not found or you do not have access.'
  });
}
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
              p.location AS project_location,
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
      task:       { task_name: task.task_name, project_name: task.project_name, location: task.project_location, assignee: task.assignee },
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
        p.location AS project_location,
        p.status AS project_status,

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

    // Normalize Location in reportText to actual project location if task.project_location is present
    let finalReportText = report_text.trim();
    if (task.project_location) {
      finalReportText = finalReportText.replace(/Location:\s*(Foundation|Project Site|Phase\b[^\n]*)/i, `Location: ${task.project_location}`);
    }

    // Strip any trailing prompt artifacts like "Generate the report now."
    finalReportText = finalReportText.replace(/Generate the report now\.?/gi, '').trim();

    // Extract manpower_count from report text (e.g., "Total: 5" or "Total: 1") or request body
    let extractedManpower = Number(req.body.manpower_count || req.body.manpowerCount) || 0;
    if (!extractedManpower && finalReportText) {
      const match = finalReportText.match(/Total:\s*(\d+)/i);
      if (match) {
        extractedManpower = parseInt(match[1], 10);
      }
    }

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

        $7,
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

        finalReportText,

        preparedBy,

        extractedManpower
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
