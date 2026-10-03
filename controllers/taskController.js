const pool = require('../db');
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
  userId
) => {

  if (!userId || !projectIdentifier) {
    return null;
  }

  const { rows } = await pool.query(
    `
    SELECT
      p.id,
      p.code,
      p.name,
      p.owner_id

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
  userId
) => {

  if (!taskId || !userId) {
    return null;
  }

  const { rows } = await pool.query(
    `
    SELECT
      t.id,
      t.task_name,
      t.project_id,
      t.assignee_id,

      p.code AS project_code,
      p.name AS project_name,
      p.location AS project_location,
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

      params.push(
        `%${status.replace('-', '%')}%`
      );


      conditions.push(
        `t.status ILIKE $${params.length}`
      );
    }


    // ============================================================
    // PHASE FILTER
    // ============================================================

    if (
      phase &&
      phase !== 'All'
    ) {

      params.push(
        `%${phase}%`
      );


      conditions.push(
        `t.phase ILIKE $${params.length}`
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

        t.project_id,

        p.name
          AS project_name,

        p.code
          AS project_code,

        p.location
          AS project_location,

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

        COALESCE(
          t.progress_pct,

          CASE

            WHEN t.status
              ILIKE 'completed'
              THEN 100

            WHEN
              t.status ILIKE 'in progress'

              OR t.status
                ILIKE 'in-progress'

              OR t.status
                ILIKE 'ongoing'

              THEN 50

            ELSE 0

          END
        ) AS progress_pct


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


    console.log(
      '[GET TASKS] returned',
      result.rows.length,
      'task(s)'
    );


    return res.status(200).json({

      success: true,

      data:
        result.rows

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

          COALESCE(
            t.progress_pct,

            CASE

              WHEN t.status
                ILIKE 'completed'
                THEN 100

              WHEN
                t.status ILIKE 'in progress'

                OR t.status ILIKE 'in-progress'

                OR t.status ILIKE 'ongoing'

                THEN 50

              ELSE 0

            END
          ) AS progress_pct,

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


    return res.status(200).json({

      success: true,

      data:
        result.rows[0]

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
const syncProjectProgress = async (projectId) => {
  if (!projectId) return 0;

  try {
    const tasksRes = await pool.query(
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

    await pool.query(
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
    return 0;
  }
};

exports.syncProjectProgress = syncProjectProgress;

// ─── UPDATE TASK STATUS ───────────────────────────────────────────────────────
exports.updateTaskStatus = async function (
  req,
  res
) {

  if (!requireAuth(req, res)) {
    return;
  }


  const id =
    req.params.id;


  const status =
    req.body.status;


  let progress_pct =
    req.body.progress_pct;


  try {

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


    if (
      progress_pct === undefined &&
      status
    ) {

      const st =
        status.toLowerCase();


      if (
        st.includes(
          'completed'
        )
      ) {

        progress_pct = 100;


      } else if (
        st.includes(
          'pending'
        )
      ) {

        progress_pct = 0;


      } else if (
        st.includes(
          'in-progress'
        ) ||

        st.includes(
          'ongoing'
        ) ||

        st.includes(
          'in progress'
        )
      ) {

        const current =
          await pool.query(
            `
            SELECT
              progress_pct

            FROM tasks

            WHERE id = $1::uuid
            `,
            [
              id
            ]
          );


        const currentValue =
          current.rows[0]
            ?.progress_pct || 0;


        progress_pct =
          currentValue > 0
            ? currentValue
            : 50;
      }
    }


    const result =
      await pool.query(
        `
        UPDATE tasks

        SET
          status =
            COALESCE(
              $1,
              status
            ),

          progress_pct =
            COALESCE(
              $2,
              progress_pct
            ),

          updated_at =
            NOW()

        WHERE id =
          $3::uuid

        RETURNING *
        `,
        [
          status,
          progress_pct,
          id
        ]
      );

    if (result.rows.length > 0) {
      if (status && status.toLowerCase().includes('completed')) {
        const cur = await pool.query(`SELECT subtasks FROM tasks WHERE id = $1::uuid`, [id]);
        if (cur.rows.length && Array.isArray(cur.rows[0].subtasks)) {
          const completedSubs = cur.rows[0].subtasks.map((s) => ({ ...s, completed: true }));
          await pool.query(
            `UPDATE tasks SET subtasks = $1 WHERE id = $2::uuid`,
            [JSON.stringify(completedSubs), id]
          );
        }
      }
      await syncProjectProgress(result.rows[0].project_id);
    }

    return res.status(200).json({

      success: true,

      data:
        result.rows[0]

    });


  } catch (err) {

    console.error(
      'updateTaskStatus error:',
      err
    );


    return res.status(500).json({
      success: false,
      error:
        'Failed to update task status.',
      details:
        err.message
    });
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

exports.completeTask = async function (
  req,
  res
) {

  if (!requireAuth(req, res)) {
    return;
  }


  const taskId =
    req.params.id ||
    req.params.taskId;


  try {

    const task =
      await getAccessibleTask(
        taskId,
        req.user.id
      );


    if (!task) {

      return res.status(404).json({
        success: false,
        message:
          'Task not found or you do not have access.'
      });
    }


    const taskCurrent = await pool.query(
      `SELECT id, project_id, subtasks FROM tasks WHERE id = $1::uuid`,
      [taskId]
    );
    if (!taskCurrent.rows.length) {
      return res.status(404).json({ success: false, error: 'Task not found or you do not have access.' });
    }

    const currentSubs = Array.isArray(taskCurrent.rows[0].subtasks)
      ? taskCurrent.rows[0].subtasks.map((s) => ({ ...s, completed: true }))
      : [];

    const result =
      await pool.query(
        `
        UPDATE tasks

        SET
          status = 'Completed',
          progress_pct = 100,
          subtasks = $1,
          updated_at = NOW()

        WHERE id = $2::uuid

        RETURNING
          id,
          task_name,
          project_id,
          assignee_id,
          status,
          progress_pct,
          updated_at
        `,
        [
          JSON.stringify(currentSubs),
          taskId
        ]
      );

    if (result.rows.length > 0) {
      await syncProjectProgress(result.rows[0].project_id);
    }


    return res.status(200).json({

      success: true,

      message:
        'Task marked as completed successfully.',

      data:
        result.rows[0]

    });


  } catch (err) {

    console.error(
      'completeTask error:',
      err
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
    let autoStatus = 'Pending';
    if (pct === 100) autoStatus = 'Completed';
    else if (pct > 0) autoStatus = 'In Progress';

    const result = await pool.query(
      `UPDATE tasks
       SET subtasks = $1,
           progress_pct = $2,
           status = $3,
           updated_at = NOW()
       WHERE id = $4::uuid
       RETURNING *`,
      [JSON.stringify(subs), pct, autoStatus, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Task not found.' });
    }

    await syncProjectProgress(result.rows[0].project_id);

    console.log('[ROUTE] PATCH /tasks/' + id + '/subtasks → new progress:', pct + '%', 'status:', result.rows[0].status);
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    console.error('[ROUTE] PATCH /tasks/:id/subtasks ERROR:', err);
    res.status(500).json({ error: 'Failed to update subtasks.' });
  }
};

// ─── CREATE TASK ──────────────────────────────────────────────────────────────
// ============================================================
// CREATE TASK
// POST /tasks
// ============================================================

// ============================================================
// CREATE TASK
// POST /tasks
// ============================================================

// ============================================================
// CREATE TASK
// POST /tasks
// ============================================================

// ============================================================
// CREATE TASK
// POST /tasks
// ============================================================

// ============================================================
// CREATE TASK
// POST /tasks
// ============================================================

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

    receivedPhase = (
      req.body.phase ||
      ''
    ).trim();


    // Convert frontend short names to the EXACT values
    // required by tasks_phase_check in PostgreSQL
    const phaseMap = {
      'Foundation': 'Phase 1 - Foundation',
      'Structural': 'Phase 2 - Structural',
      'Electrical & Utilities': 'Phase 3 - Electrical & Utilities',
      'Plumbing & MEP': 'Phase 4 - Plumbing & MEP',
      'Finishing': 'Phase 5 - Finishing',

      // Also allow frontend to already send DB values
      'Phase 1 - Foundation': 'Phase 1 - Foundation',
      'Phase 2 - Structural': 'Phase 2 - Structural',
      'Phase 3 - Electrical & Utilities': 'Phase 3 - Electrical & Utilities',
      'Phase 4 - Plumbing & MEP': 'Phase 4 - Plumbing & MEP',
      'Phase 5 - Finishing': 'Phase 5 - Finishing'
    };


    phase = phaseMap[receivedPhase] || '';


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


    if (!receivedPhase) {
      return res.status(400).json({
        success: false,
        error: 'Phase is required.'
      });
    }


    // Reject phases that are not part of the DB constraint
    if (!phase) {
      return res.status(400).json({
        success: false,
        error: `Invalid construction phase: ${receivedPhase}`
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


    // ============================================================
    // RESOLVE + AUTHORIZE PROJECT
    // ============================================================

    const project =
      await getAccessibleProject(
        projectIdentifier,
        req.user.id
      );


    if (!project) {
      return res.status(403).json({
        success: false,
        error:
          'Project not found or you do not have access to it.'
      });
    }


    const resolvedProjectId = project.id;


    // ============================================================
    // RESOLVE ASSIGNEE
    // ============================================================

    const isAssigneeUuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
        .test(assigneeId);


    let userResult;


    if (isAssigneeUuid) {

      userResult = await pool.query(
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

      userResult = await pool.query(
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
      await pool.query(
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
            };
          }
          return null;
        })
        .filter((st) => st && st.title.length > 0);
    }

    const doneCount = initialSubtasks.filter((s) => s.completed).length;
    const initialProgressPct =
      initialSubtasks.length > 0
        ? Math.round((doneCount / initialSubtasks.length) * 100)
        : 0;

    let initialStatus = 'Pending';
    if (initialProgressPct === 100) {
      initialStatus = 'Completed';
    } else if (initialProgressPct > 0) {
      initialStatus = 'In Progress';
    }

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


    const result =
      await pool.query(
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


    // ============================================================
    // SYNC MATERIALS & RESOURCES TO INVENTORY (resources table)
    // ============================================================
    try {
      const rawAllocated = req.body.allocatedMaterials || req.body.allocated_materials;
      const projectName = project.name;

      if (Array.isArray(rawAllocated) && rawAllocated.length > 0) {
        for (const item of rawAllocated) {
          if (!item || !item.name || !item.name.trim()) continue;

          const itemName = item.name.trim();
          const category = item.category === 'Equipment' ? 'Equipment' : 'Material';
          const supplier = (item.supplier || 'General Supplier').trim();
          const quantity = parseInt(item.quantity) || 0;
          const unit = (item.unit || (category === 'Equipment' ? 'units' : 'bags')).trim();
          const minThreshold = parseInt(item.minThreshold || item.min_threshold) || 10;
          const unitPrice = parseFloat(item.unitPrice || item.unit_price) || 0;

          // Check if resource already exists for this project
          const existingRes = await pool.query(
            `SELECT id, quantity, min_threshold FROM resources
             WHERE LOWER(TRIM(name)) = LOWER(TRIM($1))
               AND LOWER(TRIM(project)) = LOWER(TRIM($2))
             LIMIT 1`,
            [itemName, projectName]
          );

          if (existingRes.rows.length > 0) {
            const current = existingRes.rows[0];
            const newQty = (current.quantity || 0) + quantity;
            const status = newQty <= (current.min_threshold || 10)
              ? 'Low stock'
              : (category === 'Equipment' ? 'Available' : 'In stock');

            await pool.query(
              `UPDATE resources
               SET quantity = $1,
                   status = $2,
                   updated_at = NOW()
               WHERE id = $3`,
              [newQty, status, current.id]
            );
          } else {
            const status = quantity <= minThreshold
              ? (quantity === 0 ? 'Out of stock' : 'Low stock')
              : (category === 'Equipment' ? 'Available' : 'In stock');

            await pool.query(
              `INSERT INTO resources
               (name, supplier, category, quantity, unit, min_threshold, unit_price, project, status, created_at, updated_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())`,
              [itemName, supplier, category, quantity, unit, minThreshold, unitPrice, projectName, status]
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
            qty = parseInt(match[1]) || 1;
            unit = match[2] || 'units';
            name = match[3].trim();
          }

          if (!name) continue;

          const existingRes = await pool.query(
            `SELECT id, quantity, min_threshold FROM resources
             WHERE LOWER(TRIM(name)) = LOWER(TRIM($1))
               AND LOWER(TRIM(project)) = LOWER(TRIM($2))
             LIMIT 1`,
            [name, projectName]
          );

          if (existingRes.rows.length > 0) {
            const current = existingRes.rows[0];
            const newQty = (current.quantity || 0) + qty;
            const status = newQty <= (current.min_threshold || 10) ? 'Low stock' : 'In stock';
            await pool.query(
              `UPDATE resources
               SET quantity = $1, status = $2, updated_at = NOW()
               WHERE id = $3`,
              [newQty, status, current.id]
            );
          } else {
            const status = qty <= 10 ? 'Low stock' : 'In stock';
            await pool.query(
              `INSERT INTO resources
               (name, supplier, category, quantity, unit, min_threshold, unit_price, project, status, created_at, updated_at)
               VALUES ($1, 'General Supplier', 'Material', $2, $3, 10, 0, $4, $5, NOW(), NOW())`,
              [name, qty, unit, projectName, status]
            );
          }
        }
      }
    } catch (resourceErr) {
      console.error('Failed to sync resources to inventory:', resourceErr.message);
    }

    await syncProjectProgress(resolvedProjectId);

    return res.status(201).json({

      success: true,

      message:
        'Task created successfully.',

      data:
        result.rows[0]

    });


  } catch (err) {

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

  }

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

        RETURNING *
        `,
        [
          assigneeId,
          id
        ]
      );


    return res.status(200).json({

      success: true,

      data:
        result.rows[0]

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

        finalReportText,

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