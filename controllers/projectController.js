const pool = require('../db');
const projectService = require('../services/projectService');
const crypto = require('crypto');


// ============================================================
// INVITE CODE GENERATOR
// ============================================================

const generateInviteCode = () => {
  const part = () =>
    crypto.randomBytes(2).toString('hex').toUpperCase();

  return `${part()}-${part()}`;
};


// ============================================================
// AUTH REQUIRED HELPER
// ============================================================

const authRequired = (req, res) => {

  if (req.user?.id) {
    return false;
  }

  res.status(401).json({
    success: false,
    message: 'Authentication required.'
  });

  return true;
};


// ============================================================
// GET ACCESSIBLE PROJECT
//
// User can access project when:
//
// 1. User owns project
// OR
// 2. User joined project
//
// IMPORTANT:
// project_members.project_id references projects.code
// ============================================================

const getAccessibleProject = async (
  code,
  userId,
  userEmail
) => {

  if (!userId) {
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

    WHERE p.code = $1

      AND (
        p.owner_id = $2

        OR EXISTS (
          SELECT 1
          FROM project_members pm

          WHERE pm.project_id = p.code

            AND (
              pm.user_id = $2

              OR (
                $3::text IS NOT NULL
                AND LOWER(TRIM(pm.user_name))
                    = LOWER(TRIM($3))
              )
            )
        )
      )

    LIMIT 1
    `,
    [
      code,
      userId,
      userEmail || null
    ]
  );

  return rows[0] || null;
};


// ============================================================
// GET PROJECT OWNED BY USER
//
// Used for owner-only actions such as:
// - delete project
// - generate invite code
// - remove member
// - update project status
// ============================================================

const getOwnedProject = async (
  code,
  userId
) => {

  if (!userId) {
    return null;
  }

  const { rows } = await pool.query(
    `
    SELECT
      id,
      code,
      name,
      owner_id

    FROM projects

    WHERE code = $1
      AND owner_id = $2

    LIMIT 1
    `,
    [
      code,
      userId
    ]
  );

  return rows[0] || null;
};


// ============================================================
// GET ALL PROJECTS
//
// GET /projects
//
// Returns:
// - projects owned by current user
// - projects joined by current user
// ============================================================

const getAllProjects = async (req, res) => {

  if (authRequired(req, res)) {
    return;
  }

  try {

    const {
      status,
      search,
      code
    } = req.query;


    const projects =
      await projectService.getAll(
        status,
        search,
        code,
        req.user.id,
        req.user.email
      );


    return res.status(200).json({
      success: true,
      data: projects
    });


  } catch (error) {

    console.error(
      'getAllProjects error:',
      error
    );

    return res.status(500).json({
      success: false,
      message: 'Failed to fetch projects',
      error: error.message
    });
  }
};


// ============================================================
// GET PROJECT BY CODE
//
// GET /projects/:code
//
// User must:
// - own project
// OR
// - be project member
// ============================================================

const getProjectByCode = async (req, res) => {

  if (authRequired(req, res)) {
    return;
  }

  try {

    const { code } =
      req.params;


    const project =
      await projectService.getByCode(
        code,
        req.user.id,
        req.user.email
      );


    if (!project) {

      return res.status(404).json({
        success: false,
        message:
          `Project ${code} not found or you do not have access.`
      });
    }


    return res.status(200).json({
      success: true,
      data: project
    });


  } catch (error) {

    console.error(
      'getProjectByCode error:',
      error
    );

    return res.status(500).json({
      success: false,
      message: 'Failed to fetch project',
      error: error.message
    });
  }
};


// ============================================================
// UPDATE PROJECT STATUS
//
// OWNER ONLY
// ============================================================

const updateProjectStatus = async (req, res) => {

  if (authRequired(req, res)) {
    return;
  }

  try {

    const { code } =
      req.params;

    const { status } =
      req.body;


    const allowed = [
      'Planning',
      'Ongoing',
      'Completed'
    ];


    if (!allowed.includes(status)) {

      return res.status(400).json({
        success: false,
        message:
          `Invalid status. Must be one of: ${allowed.join(', ')}`
      });
    }


    const { rows } =
      await pool.query(
        `
        UPDATE projects

        SET
          status = $1,
          updated_at = NOW()

        WHERE code = $2
          AND owner_id = $3

        RETURNING
          id,
          code,
          name,
          status
        `,
        [
          status,
          code,
          req.user.id
        ]
      );


    if (rows.length === 0) {

      return res.status(403).json({
        success: false,
        message:
          'Only the project owner can update project status.'
      });
    }


    return res.status(200).json({
      success: true,
      data: rows[0]
    });


  } catch (err) {

    console.error(
      'updateProjectStatus error:',
      err
    );

    return res.status(500).json({
      success: false,
      message:
        'Failed to update project status',
      error: err.message
    });
  }
};


// ============================================================
// CREATE PROJECT
//
// IMPORTANT:
// owner_id comes from JWT.
//
// NEVER accept owner_id from frontend.
// ============================================================

// ============================================================
// CREATE PROJECT
//
// Logged-in user automatically becomes project owner.
// ============================================================

const createProject = async (req, res) => {

  if (authRequired(req, res)) {
    return;
  }

  try {

    const {
      code,
      name,
      location,
      scope,
      client,
      budget,
      start_date,
      end_date,
      phase
    } = req.body;


    // ============================================================
    // VALIDATION
    // ============================================================

    if (
      !code ||
      !name ||
      !location ||
      !scope ||
      !client ||
      !budget ||
      !start_date ||
      !end_date ||
      !phase
    ) {

      return res.status(400).json({
        success: false,
        message: 'All fields are required.'
      });
    }


    // ============================================================
    // CREATE PROJECT
    //
    // projects does NOT have project_code.
    // It uses "code".
    // ============================================================

    const { rows } = await pool.query(
      `
      INSERT INTO projects
      (
        code,
        name,
        location,
        scope,
        client,
        budget,
        start_date,
        end_date,
        phase,
        status,
        owner_id
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
        'Planning',
        $10
      )

      RETURNING
        id,
        code,
        name,
        location,
        scope,
        client,
        budget,
        phase,
        status,
        owner_id,

        TO_CHAR(
          start_date,
          'YYYY-MM-DD'
        ) AS start_date,

        TO_CHAR(
          end_date,
          'YYYY-MM-DD'
        ) AS end_date
      `,
      [
        code,
        name,
        location,
        scope,
        client,
        budget,
        start_date,
        end_date,
        phase,

        // Logged-in admin becomes owner
        req.user.id
      ]
    );


    return res.status(201).json({
      success: true,
      message: 'Project created successfully.',
      data: rows[0]
    });


  } catch (err) {

    console.error(
      'createProject error:',
      err
    );


    // Duplicate project code
    if (err.code === '23505') {

      return res.status(409).json({
        success: false,
        message:
          `Project code "${req.body.code}" already exists.`
      });
    }


    return res.status(500).json({
      success: false,
      message: 'Failed to create project',
      error: err.message
    });
  }
};


// ============================================================
// GENERATE PROJECT INVITE CODE
//
// POST /projects/:code/generate-code
//
// OWNER ONLY
// ============================================================

const generateProjectCode = async (req, res) => {

  if (authRequired(req, res)) {
    return;
  }


  const { code } =
    req.params;


  try {

    const project =
      await getOwnedProject(
        code,
        req.user.id
      );


    if (!project) {

      return res.status(403).json({
        success: false,
        message:
          'Only the project owner can generate an invite code.'
      });
    }


    let inviteCode;

    let isUnique =
      false;


    while (!isUnique) {

      inviteCode =
        generateInviteCode();


      const check =
        await pool.query(
          `
          SELECT id
          FROM project_invite_codes
          WHERE code = $1
          `,
          [
            inviteCode
          ]
        );


      isUnique =
        check.rows.length === 0;
    }


    await pool.query(
      `
      INSERT INTO project_invite_codes
      (
        project_id,
        code,
        expires_at
      )

      VALUES (
        $1,
        $2,
        NOW() + INTERVAL '7 days'
      )
      `,
      [
        code,
        inviteCode
      ]
    );


    return res.status(200).json({
      success: true,
      code: inviteCode
    });


  } catch (err) {

    console.error(
      'generateProjectCode error:',
      err
    );


    return res.status(500).json({
      success: false,
      message:
        'Failed to generate code',
      error: err.message
    });
  }
};


// ============================================================
// JOIN PROJECT
//
// POST /projects/join
//
// User enters project invite code.
// ============================================================

const joinProject = async (req, res) => {

  if (authRequired(req, res)) {
    return;
  }


  const {
    invite_code
  } = req.body;


  const userId =
    req.user.id;


  const userEmail =
    req.user.email;


  if (!invite_code) {

    return res.status(400).json({
      success: false,
      message:
        'invite_code is required.'
    });
  }


  try {

    // ============================================================
    // CHECK INVITE CODE
    // ============================================================

    const { rows } =
      await pool.query(
        `
        SELECT *

        FROM project_invite_codes

        WHERE code = $1
          AND used = FALSE
          AND expires_at > NOW()

        LIMIT 1
        `,
        [
          invite_code
        ]
      );


    if (rows.length === 0) {

      return res.status(400).json({
        success: false,
        message:
          'Invalid or expired invite code.'
      });
    }


    const invite =
      rows[0];


    // ============================================================
    // CHECK IF USER OWNS PROJECT
    // ============================================================

    const ownerCheck =
      await pool.query(
        `
        SELECT owner_id

        FROM projects

        WHERE code = $1

        LIMIT 1
        `,
        [
          invite.project_id
        ]
      );


    if (
      ownerCheck.rows[0]?.owner_id === userId
    ) {

      return res.status(409).json({
        success: false,
        message:
          'You already own this project.'
      });
    }


    // ============================================================
    // CHECK IF ALREADY MEMBER
    // ============================================================

    const already =
      await pool.query(
        `
        SELECT id

        FROM project_members

        WHERE project_id = $1

          AND (
            user_id = $2

            OR LOWER(TRIM(user_name))
              = LOWER(TRIM($3))
          )

        LIMIT 1
        `,
        [
          invite.project_id,
          userId,
          userEmail
        ]
      );


    if (already.rows.length > 0) {

      return res.status(409).json({
        success: false,
        message:
          'You are already a member of this project.'
      });
    }


    // ============================================================
    // ADD USER TO PROJECT
    //
    // We save BOTH:
    // user_id
    // user_name/email
    //
    // This keeps compatibility with your old data.
    // ============================================================

    await pool.query(
      `
      INSERT INTO project_members
      (
        project_id,
        user_id,
        user_name,
        role
      )

      VALUES (
        $1,
        $2,
        $3,
        'Member'
      )
      `,
      [
        invite.project_id,
        userId,
        userEmail
      ]
    );


    // ============================================================
    // MARK CODE USED
    // ============================================================

    await pool.query(
      `
      UPDATE project_invite_codes

      SET
        used = TRUE,
        used_at = NOW()

      WHERE id = $1
      `,
      [
        invite.id
      ]
    );


    return res.status(200).json({
      success: true,
      message:
        'Successfully joined the project.',
      project_id:
        invite.project_id
    });


  } catch (err) {

    console.error(
      'joinProject error:',
      err
    );


    return res.status(500).json({
      success: false,
      message:
        'Failed to join project',
      error:
        err.message
    });
  }
};


// ============================================================
// GET ACTIVE INVITE CODE
//
// OWNER ONLY
// ============================================================

const getActiveCode = async (req, res) => {

  if (authRequired(req, res)) {
    return;
  }


  const { code } =
    req.params;


  try {

    const project =
      await getOwnedProject(
        code,
        req.user.id
      );


    if (!project) {

      return res.status(403).json({
        success: false,
        message:
          'Only the project owner can view invite codes.'
      });
    }


    const { rows } =
      await pool.query(
        `
        SELECT
          code,
          expires_at

        FROM project_invite_codes

        WHERE project_id = $1
          AND used = FALSE
          AND expires_at > NOW()

        ORDER BY created_at DESC

        LIMIT 1
        `,
        [
          code
        ]
      );


    if (rows.length === 0) {

      return res.status(200).json({
        success: true,
        code: null
      });
    }


    return res.status(200).json({
      success: true,
      code:
        rows[0].code,
      expires_at:
        rows[0].expires_at
    });


  } catch (err) {

    return res.status(500).json({
      success: false,
      message:
        'Failed to fetch active code',
      error:
        err.message
    });
  }
};


// ============================================================
// GET JOINED PROJECTS
//
// GET /projects/joined
// ============================================================

const getJoinedProjects = async (req, res) => {

  if (authRequired(req, res)) {
    return;
  }


  const userId =
    req.user.id;


  const userEmail =
    req.user.email;


  try {

    const { rows } =
      await pool.query(
        `
        SELECT DISTINCT
          p.id,
          p.code,
          p.name,
          p.location,
          p.scope,
          p.client,
          p.budget,
          p.phase,
          p.status,
          p.owner_id,

          COALESCE(
            p.progress,
            0
          ) AS progress,

          TO_CHAR(
            p.start_date,
            'YYYY-MM-DD'
          ) AS start_date,

          TO_CHAR(
            p.end_date,
            'YYYY-MM-DD'
          ) AS due_date,

          pm.role
            AS member_role,

          'member'
            AS access_type,

          'Not assigned'
            AS manager

        FROM project_members pm

        INNER JOIN projects p
          ON p.code = pm.project_id

        WHERE
          pm.user_id = $1

          OR LOWER(
            TRIM(pm.user_name)
          ) = LOWER(
            TRIM($2)
          )

        ORDER BY
          p.name ASC
        `,
        [
          userId,
          userEmail
        ]
      );


    return res.status(200).json({
      success: true,
      data: rows
    });


  } catch (err) {

    console.error(
      'getJoinedProjects error:',
      err
    );


    return res.status(500).json({
      success: false,
      message:
        'Failed to fetch joined projects.',
      error:
        err.message
    });
  }
};


// ============================================================
// GET AVAILABLE MEMBERS
//
// OWNER ONLY
// ============================================================

const getAvailableMembers = async (req, res) => {

  if (authRequired(req, res)) {
    return;
  }


  const { code } =
    req.params;


  try {

    const project =
      await getOwnedProject(
        code,
        req.user.id
      );


    if (!project) {

      return res.status(403).json({
        success: false,
        message:
          'Only the project owner can manage members.'
      });
    }


    const { rows } =
      await pool.query(
        `
        SELECT
          u.id,
          u.full_name AS name,
          u.email,
          u.role

        FROM users u

        WHERE u.is_active = TRUE

          AND u.id <> $2

          AND NOT EXISTS (

            SELECT 1

            FROM project_members pm

            WHERE pm.project_id = $1

              AND (
                pm.user_id = u.id

                OR LOWER(
                  TRIM(pm.user_name)
                ) = LOWER(
                  TRIM(u.email)
                )
              )
          )

        ORDER BY
          u.full_name NULLS LAST,
          u.email
        `,
        [
          code,
          req.user.id
        ]
      );


    return res.status(200).json({
      success: true,
      data: rows
    });


  } catch (err) {

    return res.status(500).json({
      success: false,
      message:
        'Failed to fetch available members',
      error:
        err.message
    });
  }
};


// ============================================================
// ADD MEMBER MANUALLY
//
// OWNER ONLY
// ============================================================

const addMember = async (req, res) => {

  if (authRequired(req, res)) {
    return;
  }


  const { code } =
    req.params;


  const { userId } =
    req.body;


  if (!userId) {

    return res.status(400).json({
      success: false,
      message:
        'userId is required'
    });
  }


  try {

    const project =
      await getOwnedProject(
        code,
        req.user.id
      );


    if (!project) {

      return res.status(403).json({
        success: false,
        message:
          'Only the project owner can add members.'
      });
    }


    const userRes =
      await pool.query(
        `
        SELECT
          id,
          full_name,
          email

        FROM users

        WHERE id = $1
          AND is_active = TRUE
        `,
        [
          userId
        ]
      );


    if (userRes.rows.length === 0) {

      return res.status(404).json({
        success: false,
        message:
          'User not found.'
      });
    }


    const user =
      userRes.rows[0];


    const already =
      await pool.query(
        `
        SELECT id

        FROM project_members

        WHERE project_id = $1

          AND (
            user_id = $2

            OR LOWER(
              TRIM(user_name)
            ) = LOWER(
              TRIM($3)
            )
          )

        LIMIT 1
        `,
        [
          code,
          userId,
          user.email
        ]
      );


    if (already.rows.length > 0) {

      return res.status(409).json({
        success: false,
        message:
          'User is already a member of this project.'
      });
    }


    await pool.query(
      `
      INSERT INTO project_members
      (
        project_id,
        user_id,
        user_name,
        role
      )

      VALUES (
        $1,
        $2,
        $3,
        'Member'
      )
      `,
      [
        code,
        userId,
        user.email
      ]
    );


    return res.status(200).json({
      success: true,
      message:
        `${user.full_name || user.email} added to project ${code}.`
    });


  } catch (err) {

    return res.status(500).json({
      success: false,
      message:
        'Failed to add member',
      error:
        err.message
    });
  }
};


// ============================================================
// GET PROJECT MEMBERS
//
// Owner or project member can view.
// ============================================================

const getProjectMembers = async (req, res) => {

  if (authRequired(req, res)) {
    return;
  }


  const { code } =
    req.params;


  try {

    const project =
      await getAccessibleProject(
        code,
        req.user.id,
        req.user.email
      );


    if (!project) {

      return res.status(403).json({
        success: false,
        message:
          'You do not have access to this project.'
      });
    }


    const result =
      await pool.query(
        `
        SELECT
          u.id,

          COALESCE(
            NULLIF(
              TRIM(u.full_name),
              ''
            ),
            u.email
          ) AS name,

          u.email,

          COALESCE(
            NULLIF(
              TRIM(pm.role),
              ''
            ),
            u.role,
            'Member'
          ) AS role,

          pm.joined_at

        FROM project_members pm

        INNER JOIN users u

          ON u.id = pm.user_id

          OR (
            pm.user_id IS NULL

            AND LOWER(
              TRIM(u.email)
            ) = LOWER(
              TRIM(pm.user_name)
            )
          )

        WHERE pm.project_id = $1

        ORDER BY
          pm.joined_at ASC
        `,
        [
          code
        ]
      );


    return res.status(200).json({
      success: true,
      data:
        result.rows
    });


  } catch (err) {

    return res.status(500).json({
      success: false,
      message:
        'Failed to fetch project members',
      error:
        err.message
    });
  }
};


// ============================================================
// REMOVE PROJECT MEMBER
//
// OWNER ONLY
// ============================================================

const removeMember = async (req, res) => {

  if (authRequired(req, res)) {
    return;
  }


  const {
    code,
    memberId
  } = req.params;


  try {

    const project =
      await getOwnedProject(
        code,
        req.user.id
      );


    if (!project) {

      return res.status(403).json({
        success: false,
        message:
          'Only the project owner can remove members.'
      });
    }


    const userRes =
      await pool.query(
        `
        SELECT email

        FROM users

        WHERE id = $1

        LIMIT 1
        `,
        [
          memberId
        ]
      );


    const memberEmail =
      userRes.rows[0]?.email || null;


    const { rows } =
      await pool.query(
        `
        DELETE FROM project_members

        WHERE project_id = $1

          AND (
            user_id = $2

            OR (
              $3::text IS NOT NULL

              AND LOWER(
                TRIM(user_name)
              ) = LOWER(
                TRIM($3)
              )
            )
          )

        RETURNING id
        `,
        [
          code,
          memberId,
          memberEmail
        ]
      );


    if (rows.length === 0) {

      return res.status(404).json({
        success: false,
        message:
          'Member not found in this project.'
      });
    }


    return res.status(200).json({
      success: true,
      message:
        'Member removed from project.'
    });


  } catch (err) {

    return res.status(500).json({
      success: false,
      message:
        'Failed to remove member',
      error:
        err.message
    });
  }
};


// ============================================================
// PROJECT STATS
// ============================================================

const getProjectStats = async (req, res) => {

  if (authRequired(req, res)) {
    return;
  }


  const { code } =
    req.params;


  try {

    const accessProject =
      await getAccessibleProject(
        code,
        req.user.id,
        req.user.email
      );


    if (!accessProject) {

      return res.status(403).json({
        success: false,
        message:
          'You do not have access to this project.'
      });
    }


    const project =
      await pool.query(
        `
        SELECT id

        FROM projects

        WHERE code = $1
        `,
        [
          code
        ]
      );


    if (
      project.rows.length === 0
    ) {

      return res.status(404).json({
        success: false,
        message:
          `Project ${code} not found.`
      });
    }


    const projectId =
      project.rows[0].id;


    const [
      taskStats,
      memberStats,
      issueStats
    ] =
      await Promise.all([

        pool.query(
          `
          SELECT

            COUNT(*) FILTER (
              WHERE status != 'Completed'
            ) AS active_tasks,

            COUNT(*) FILTER (
              WHERE status = 'Pending'
            ) AS pending_task_issues

          FROM tasks

          WHERE project_id = $1
          `,
          [
            projectId
          ]
        ),


        pool.query(
          `
          SELECT
            COUNT(*) AS member_count

          FROM project_members

          WHERE project_id = $1
          `,
          [
            code
          ]
        ),


        pool.query(
          `
          SELECT
            COUNT(*) AS pending_issues

          FROM project_issues

          WHERE project_code = $1
            AND status != 'Resolved'
          `,
          [
            code
          ]
        )

      ]);


    const realIssues =
      parseInt(
        issueStats.rows[0]
          ?.pending_issues
      ) || 0;


    const taskPending =
      parseInt(
        taskStats.rows[0]
          ?.pending_task_issues
      ) || 0;


    return res.status(200).json({

      success: true,

      data: {

        activeTaskCount:
          parseInt(
            taskStats.rows[0]
              ?.active_tasks
          ) || 0,

        memberCount:
          parseInt(
            memberStats.rows[0]
              ?.member_count
          ) || 0,

        pendingIssueCount:
          realIssues > 0
            ? realIssues
            : taskPending

      }
    });


  } catch (err) {

    return res.status(500).json({
      success: false,
      message:
        'Failed to fetch project stats',
      error:
        err.message
    });
  }
};


// ============================================================
// GET ACTIVE TASK
// ============================================================

const getProjectActiveTask = async (req, res) => {

  if (authRequired(req, res)) {
    return;
  }


  const { code } =
    req.params;


  try {

    const accessProject =
      await getAccessibleProject(
        code,
        req.user.id,
        req.user.email
      );


    if (!accessProject) {

      return res.status(403).json({
        success: false,
        message:
          'You do not have access to this project.'
      });
    }


    const project =
      await pool.query(
        `
        SELECT id

        FROM projects

        WHERE code = $1
        `,
        [
          code
        ]
      );


    if (
      project.rows.length === 0
    ) {

      return res.status(404).json({
        success: false,
        message:
          `Project ${code} not found.`
      });
    }


    const projectId =
      project.rows[0].id;


    const { rows } =
      await pool.query(
        `
        SELECT
          t.id,
          t.task_name AS title,
          t.status,
          u.full_name AS assignee

        FROM tasks t

        LEFT JOIN users u
          ON u.id = t.assignee_id

        WHERE t.project_id = $1

          AND (
            t.status ILIKE '%progress%'
            OR t.status ILIKE '%ongoing%'
            OR t.status ILIKE '%pending%'
          )

        ORDER BY
          CASE
            WHEN t.status ILIKE '%progress%' THEN 1
            WHEN t.status ILIKE '%ongoing%' THEN 2
            ELSE 3
          END,

          t.updated_at DESC

        LIMIT 1
        `,
        [
          projectId
        ]
      );


    return res.status(200).json({

      success: true,

      data:
        rows[0] || null

    });


  } catch (err) {

    return res.status(500).json({
      success: false,
      message:
        'Failed to fetch active task',
      error:
        err.message
    });
  }
};


// ============================================================
// GET PROJECT DOCUMENTS
// ============================================================

const getDocuments = async (req, res) => {

  if (authRequired(req, res)) {
    return;
  }


  const { code } =
    req.params;


  const { category } =
    req.query;


  try {

    const accessProject =
      await getAccessibleProject(
        code,
        req.user.id,
        req.user.email
      );


    if (!accessProject) {

      return res.status(403).json({
        success: false,
        message:
          'You do not have access to this project.'
      });
    }


    let query = `
      SELECT
        id,
        name,
        type,
        category,
        uploaded_at

      FROM documents

      WHERE project_code = $1
    `;


    const params =
      [
        code
      ];


    if (category) {

      params.push(
        category
      );


      query += `
        AND category = $${params.length}
      `;
    }


    query += `
      ORDER BY uploaded_at DESC
    `;


    const { rows } =
      await pool.query(
        query,
        params
      );


    return res.status(200).json({
      success: true,
      data:
        rows
    });


  } catch (err) {

    console.error(
      'getDocuments error:',
      err
    );


    return res.status(500).json({
      success: false,
      message:
        'Failed to fetch documents',
      error:
        err.message
    });
  }
};


// ============================================================
// UPLOAD DOCUMENT
//
// Project owner or joined member.
// ============================================================

const uploadDocument = async (req, res) => {

  if (authRequired(req, res)) {
    return;
  }


  const { code } =
    req.params;


  try {

    const accessProject =
      await getAccessibleProject(
        code,
        req.user.id,
        req.user.email
      );


    if (!accessProject) {

      return res.status(403).json({
        success: false,
        message:
          'You do not have access to this project.'
      });
    }


    let docs = [];


    if (
      Array.isArray(
        req.body.documents
      ) &&
      req.body.documents.length > 0
    ) {

      docs =
        req.body.documents;


    } else if (
      Array.isArray(req.body) &&
      req.body.length > 0
    ) {

      docs =
        req.body;


    } else if (
      req.body &&
      (
        req.body.name ||
        req.body.category ||
        req.body.type
      )
    ) {

      docs =
        [
          req.body
        ];
    }


    if (docs.length === 0) {

      return res.status(400).json({
        success: false,
        message:
          'name, type, and category are required.'
      });
    }


    const allowedTypes = [
      'DWG',
      'PDF',
      'XLS',
      'DOC'
    ];


    const allowedCategories = [
      'Design & Engineering',
      'Project Management',
      'Site Reference'
    ];


    const validatedDocs =
      [];


    for (
      let i = 0;
      i < docs.length;
      i++
    ) {

      const doc =
        docs[i];


      let docName =
        (doc.name || '')
          .trim();


      let docType =
        (doc.type || 'PDF')
          .trim()
          .toUpperCase();


      let docCategory =
        (
          doc.category ||
          'Design & Engineering'
        ).trim();


      if (
        docType === 'DOCX'
      ) {

        docType =
          'DOC';
      }


      if (
        docType === 'XLSX' ||
        docType === 'CSV'
      ) {

        docType =
          'XLS';
      }


      if (
        [
          'JPG',
          'JPEG',
          'PNG',
          'WEBP'
        ].includes(docType)
      ) {

        docType =
          'PDF';
      }


      if (!docName) {

        return res.status(400).json({
          success: false,
          message:
            'name, type, and category are required.'
        });
      }


      if (
        !allowedTypes.includes(
          docType
        )
      ) {

        docType =
          'PDF';
      }


      if (
        !allowedCategories.includes(
          docCategory
        )
      ) {

        docCategory =
          'Design & Engineering';
      }


      validatedDocs.push({
        name:
          docName,
        type:
          docType,
        category:
          docCategory
      });
    }


    const inserted =
      [];


    for (
      const doc of validatedDocs
    ) {

      const { rows } =
        await pool.query(
          `
          INSERT INTO documents
          (
            project_code,
            name,
            type,
            category
          )

          VALUES (
            $1,
            $2,
            $3,
            $4
          )

          RETURNING
            id,
            name,
            type,
            category,
            uploaded_at
          `,
          [
            code,
            doc.name,
            doc.type,
            doc.category
          ]
        );


      inserted.push(
        rows[0]
      );
    }


    return res.status(201).json({

      success: true,

      data:
        inserted.length === 1
          ? inserted[0]
          : inserted,

      count:
        inserted.length

    });


  } catch (err) {

    console.error(
      'uploadDocument error:',
      err
    );


    return res.status(500).json({
      success: false,
      message:
        'Failed to upload document',
      error:
        err.message
    });
  }
};


// ============================================================
// DELETE DOCUMENT
//
// OWNER ONLY
// ============================================================

const deleteDocument = async (req, res) => {

  if (authRequired(req, res)) {
    return;
  }


  const {
    code,
    docId
  } = req.params;


  try {

    const project =
      await getOwnedProject(
        code,
        req.user.id
      );


    if (!project) {

      return res.status(403).json({
        success: false,
        message:
          'Only the project owner can delete documents.'
      });
    }


    const { rows } =
      await pool.query(
        `
        DELETE FROM documents

        WHERE id = $1
          AND project_code = $2

        RETURNING id
        `,
        [
          docId,
          code
        ]
      );


    if (rows.length === 0) {

      return res.status(404).json({
        success: false,
        message:
          'Document not found.'
      });
    }


    return res.status(200).json({
      success: true,
      message:
        'Document deleted.'
    });


  } catch (err) {

    return res.status(500).json({
      success: false,
      message:
        'Failed to delete document',
      error:
        err.message
    });
  }
};


// ============================================================
// DELETE PROJECT
//
// OWNER ONLY
// ============================================================

const deleteProject = async (req, res) => {

  if (authRequired(req, res)) {
    return;
  }


  const { code } =
    req.params;


  try {

    const { rows } =
      await pool.query(
        `
        DELETE FROM projects

        WHERE code = $1
          AND owner_id = $2

        RETURNING
          id,
          code,
          name
        `,
        [
          code,
          req.user.id
        ]
      );


    if (rows.length === 0) {

      return res.status(403).json({
        success: false,
        message:
          'Only the project owner can delete this project.'
      });
    }


    return res.status(200).json({
      success: true,
      message:
        `Project "${rows[0].name}" deleted.`
    });


  } catch (err) {

    return res.status(500).json({
      success: false,
      message:
        'Failed to delete project',
      error:
        err.message
    });
  }
};


// ============================================================
// PROJECT PROGRESS
// ============================================================

const getProjectProgress = async (req, res) => {

  if (authRequired(req, res)) {
    return;
  }


  const { code } =
    req.params;


  try {

    const accessProject =
      await getAccessibleProject(
        code,
        req.user.id,
        req.user.email
      );


    if (!accessProject) {

      return res.status(403).json({
        success: false,
        message:
          'You do not have access to this project.'
      });
    }


    const projectRes =
      await pool.query(
        `
        SELECT
          id,
          code,
          name,
          phase,
          status,

          COALESCE(
            progress,
            0
          ) AS progress,

          start_date,
          end_date

        FROM projects

        WHERE code = $1
        `,
        [
          code
        ]
      );


    if (
      projectRes.rows.length === 0
    ) {

      return res.status(404).json({
        success: false,
        message:
          `Project ${code} not found.`
      });
    }


    const project =
      projectRes.rows[0];


    const statsRes =
      await pool.query(
        `
        SELECT

          COUNT(*)
            AS total_tasks,

          COUNT(*) FILTER (
            WHERE LOWER(status) = 'completed'
          ) AS completed_tasks,

          COUNT(*) FILTER (
            WHERE LOWER(status) = 'in progress'
          ) AS in_progress_tasks

        FROM tasks

        WHERE project_id = $1
        `,
        [
          project.id
        ]
      );


    const stats =
      statsRes.rows[0];


    const totalTasks =
      parseInt(
        stats.total_tasks
      ) || 0;


    const completedTasks =
      parseInt(
        stats.completed_tasks
      ) || 0;


    const inProgressTasks =
      parseInt(
        stats.in_progress_tasks
      ) || 0;


    const progressPct =
      parseInt(
        project.progress
      ) || 0;


    const phaseRes =
      await pool.query(
        `
        SELECT
          phase,

          COUNT(*)
            AS total_tasks,

          COUNT(*) FILTER (
            WHERE LOWER(status) = 'completed'
          ) AS completed_tasks,

          COUNT(*) FILTER (
            WHERE LOWER(status) = 'in progress'
          ) AS in_progress_tasks

        FROM tasks

        WHERE project_id = $1

        GROUP BY phase

        ORDER BY phase
        `,
        [
          project.id
        ]
      );


    return res.status(200).json({

      success: true,

      data: {

        project: {
          ...project,

          progress:
            progressPct,

          progress_pct:
            progressPct
        },


        stats: {

          totalTasks,

          completedTasks,

          inProgressTasks,

          progressPct

        },


        taskBreakdown:
          phaseRes.rows,


        logs: []

      }
    });


  } catch (err) {

    console.error(
      'getProjectProgress error:',
      err
    );


    return res.status(500).json({
      success: false,
      message:
        'Failed to fetch project progress',
      error:
        err.message
    });
  }
};


// ============================================================
// CONSTRUCTION PHASES
// ============================================================

const CONSTRUCTION_PHASES = [

  'Phase 1 - Foundation',

  'Phase 2 - Structural',

  'Phase 3 - Electrical & Utilities',

  'Phase 4 - Plumbing & MEP',

  'Phase 5 - Finishing'

];


function getNextPhase(
  currentPhase
) {

  if (!currentPhase) {

    return {
      nextPhase:
        CONSTRUCTION_PHASES[0],

      isAllCompleted:
        false
    };
  }


  const curLower =
    currentPhase.toLowerCase();


  const idx =
    CONSTRUCTION_PHASES.findIndex(
      p => {

        const pLower =
          p.toLowerCase();


        return (

          pLower.includes(
            curLower
          )

          ||

          curLower.includes(
            pLower
          )

          ||

          (
            pLower.includes('phase 1')
            &&
            curLower.includes('foundation')
          )

          ||

          (
            pLower.includes('phase 2')
            &&
            (
              curLower.includes('structur')
              ||
              curLower.includes('structure')
            )
          )

          ||

          (
            pLower.includes('phase 3')
            &&
            (
              curLower.includes('utilit')
              ||
              curLower.includes('electr')
            )
          )

          ||

          (
            pLower.includes('phase 4')
            &&
            (
              curLower.includes('plumb')
              ||
              curLower.includes('mep')
            )
          )

          ||

          (
            pLower.includes('phase 5')
            &&
            curLower.includes('finish')
          )

        );
      }
    );


  if (
    idx !== -1
    &&
    idx <
      CONSTRUCTION_PHASES.length - 1
  ) {

    return {
      nextPhase:
        CONSTRUCTION_PHASES[
          idx + 1
        ],

      isAllCompleted:
        false
    };
  }


  if (
    idx ===
    CONSTRUCTION_PHASES.length - 1
  ) {

    return {
      nextPhase:
        CONSTRUCTION_PHASES[idx],

      isAllCompleted:
        true
    };
  }


  return {
    nextPhase:
      currentPhase,

    isAllCompleted:
      false
  };
}


// ============================================================
// UPDATE PROJECT PROGRESS
//
// OWNER ONLY
// ============================================================

const logProjectProgress = async (req, res) => {

  if (authRequired(req, res)) {
    return;
  }


  const { code } =
    req.params;


  const {

    phase,

    progress_pct,

    summary,

    work_completed,

    manpower,

    weather

  } = req.body;


  try {

    const accessProject =
      await getOwnedProject(
        code,
        req.user.id
      );


    if (!accessProject) {

      return res.status(403).json({
        success: false,
        message:
          'Only the project owner can update project progress.'
      });
    }


    const projectRes =
      await pool.query(
        `
        SELECT
          id,
          code,
          name,
          phase,
          status,

          COALESCE(
            progress,
            0
          ) AS progress

        FROM projects

        WHERE code = $1
        `,
        [
          code
        ]
      );


    if (
      projectRes.rows.length === 0
    ) {

      return res.status(404).json({
        success: false,
        message:
          `Project ${code} not found.`
      });
    }


    const project =
      projectRes.rows[0];


    const pct =
      Math.min(
        100,

        Math.max(
          0,
          parseInt(
            progress_pct
          ) || 0
        )
      );


    let targetPhase =
      phase ||
      project.phase;


    let targetStatus =
      project.status;


    if (pct === 100) {

      const advancement =
        getNextPhase(
          targetPhase
        );


      targetPhase =
        advancement.nextPhase;


      targetStatus =
        advancement.isAllCompleted
          ? 'Completed'
          : 'Ongoing';


    } else if (
      pct > 0
    ) {

      targetStatus =
        'Ongoing';
    }


    const updateResult =
      await pool.query(
        `
        UPDATE projects

        SET
          phase = $1,
          status = $2,
          progress = $3,
          updated_at = NOW()

        WHERE code = $4
          AND owner_id = $5

        RETURNING
          id,
          code,
          name,
          phase,
          status,
          progress,
          updated_at
        `,
        [
          targetPhase,
          targetStatus,
          pct,
          code,
          req.user.id
        ]
      );


    if (
      updateResult.rows.length === 0
    ) {

      return res.status(403).json({
        success: false,
        message:
          'Unable to update this project.'
      });
    }


    const updatedProject =
      updateResult.rows[0];


    return res.status(200).json({

      success: true,

      message:
        pct === 100
          ? `Project progress updated to ${pct}%.`
          : 'Project progress updated.',


      data: {

        project_code:
          updatedProject.code,

        phase:
          updatedProject.phase,

        status:
          updatedProject.status,

        progress:
          updatedProject.progress,

        progress_pct:
          updatedProject.progress,

        summary:
          summary || null,

        work_completed:
          work_completed || null,

        manpower:
          parseInt(manpower) || 0,

        weather:
          weather || null

      }
    });


  } catch (err) {

    console.error(
      'logProjectProgress error:',
      err
    );


    return res.status(500).json({
      success: false,
      message:
        'Failed to update project progress',
      error:
        err.message
    });
  }
};


// ============================================================
// GET PROJECT ISSUES
// ============================================================

const getProjectIssues = async (req, res) => {

  if (authRequired(req, res)) {
    return;
  }


  const { code } =
    req.params;


  const {
    status,
    category,
    priority,
    search
  } = req.query;


  try {

    const accessProject =
      await getAccessibleProject(
        code,
        req.user.id,
        req.user.email
      );


    if (!accessProject) {

      return res.status(403).json({
        success: false,
        message:
          'You do not have access to this project.'
      });
    }


    let query = `
      SELECT

        i.id,

        i.project_code,

        i.title,

        i.category,

        i.priority,

        i.location,

        i.description,

        i.status,

        i.resolution_notes,

        i.resolved_at,

        i.created_at,

        i.updated_at,

        ru.full_name
          AS reporter_name,

        ru.role
          AS reporter_role,

        au.full_name
          AS assignee_name,

        au.role
          AS assignee_role,

        i.reported_by,

        i.assigned_to

      FROM project_issues i

      LEFT JOIN users ru
        ON ru.id = i.reported_by

      LEFT JOIN users au
        ON au.id = i.assigned_to

      WHERE i.project_code = $1
    `;


    const params =
      [
        code
      ];


    if (
      status &&
      status !== 'All'
    ) {

      params.push(
        status
      );


      query +=
        ` AND i.status = $${params.length}`;
    }


    if (
      category &&
      category !== 'All'
    ) {

      params.push(
        category
      );


      query +=
        ` AND i.category = $${params.length}`;
    }


    if (
      priority &&
      priority !== 'All'
    ) {

      params.push(
        priority
      );


      query +=
        ` AND i.priority = $${params.length}`;
    }


    if (search) {

      params.push(
        `%${search
          .trim()
          .toLowerCase()}%`
      );


      query += `
        AND (
          LOWER(i.title)
            LIKE $${params.length}

          OR LOWER(i.description)
            LIKE $${params.length}

          OR LOWER(i.location)
            LIKE $${params.length}
        )
      `;
    }


    query += `
      ORDER BY

        CASE

          WHEN i.status = 'Open'
            THEN 1

          WHEN i.status = 'In Progress'
            THEN 2

          ELSE 3

        END,

        i.created_at DESC
    `;


    const { rows } =
      await pool.query(
        query,
        params
      );


    return res.status(200).json({
      success: true,
      data:
        rows
    });


  } catch (err) {

    console.error(
      'getProjectIssues error:',
      err
    );


    return res.status(500).json({
      success: false,
      message:
        'Failed to fetch project issues',
      error:
        err.message
    });
  }
};


// ============================================================
// CREATE PROJECT ISSUE
// ============================================================

const createProjectIssue = async (req, res) => {

  if (authRequired(req, res)) {
    return;
  }


  const { code } =
    req.params;


  const {

    title,

    category,

    priority,

    location,

    description,

    assigned_to

  } = req.body;


  const userId =
    req.user.id;


  if (
    !title ||
    !category ||
    !description
  ) {

    return res.status(400).json({
      success: false,
      message:
        'title, category, and description are required.'
    });
  }


  try {

    const accessProject =
      await getAccessibleProject(
        code,
        req.user.id,
        req.user.email
      );


    if (!accessProject) {

      return res.status(403).json({
        success: false,
        message:
          'You do not have access to this project.'
      });
    }


    const { rows } =
      await pool.query(
        `
        INSERT INTO project_issues
        (
          project_code,

          title,

          category,

          priority,

          location,

          description,

          status,

          reported_by,

          assigned_to
        )

        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          'Open',
          $7,
          $8
        )

        RETURNING *
        `,
        [
          code,

          title.trim(),

          category,

          priority ||
            'Medium',

          location ||
            null,

          description.trim(),

          userId,

          assigned_to ||
            null
        ]
      );


    return res.status(201).json({

      success: true,

      message:
        'Issue reported successfully.',

      data:
        rows[0]

    });


  } catch (err) {

    console.error(
      'createProjectIssue error:',
      err
    );


    return res.status(500).json({
      success: false,
      message:
        'Failed to report issue',
      error:
        err.message
    });
  }
};


// ============================================================
// UPDATE PROJECT ISSUE
// ============================================================

const updateProjectIssue = async (req, res) => {

  if (authRequired(req, res)) {
    return;
  }


  const {
    code,
    issueId
  } = req.params;


  const {

    status,

    resolution_notes,

    assigned_to,

    priority

  } = req.body;


  try {

    const accessProject =
      await getAccessibleProject(
        code,
        req.user.id,
        req.user.email
      );


    if (!accessProject) {

      return res.status(403).json({
        success: false,
        message:
          'You do not have access to this project.'
      });
    }


    const existing =
      await pool.query(
        `
        SELECT
          id,
          status

        FROM project_issues

        WHERE id = $1
          AND project_code = $2
        `,
        [
          issueId,
          code
        ]
      );


    if (
      existing.rows.length === 0
    ) {

      return res.status(404).json({
        success: false,
        message:
          'Issue not found.'
      });
    }


    const updates =
      [];


    const params =
      [
        issueId,
        code
      ];


    if (status) {

      params.push(
        status
      );


      updates.push(
        `status = $${params.length}`
      );


      if (
        status === 'Resolved'
      ) {

        updates.push(
          `resolved_at = NOW()`
        );


      } else {

        updates.push(
          `resolved_at = NULL`
        );
      }
    }


    if (
      resolution_notes !== undefined
    ) {

      params.push(
        resolution_notes
      );


      updates.push(
        `resolution_notes = $${params.length}`
      );
    }


    if (
      assigned_to !== undefined
    ) {

      params.push(
        assigned_to
      );


      updates.push(
        `assigned_to = $${params.length}`
      );
    }


    if (priority) {

      params.push(
        priority
      );


      updates.push(
        `priority = $${params.length}`
      );
    }


    if (
      updates.length === 0
    ) {

      return res.status(400).json({
        success: false,
        message:
          'No update fields provided.'
      });
    }


    updates.push(
      'updated_at = NOW()'
    );


    const { rows } =
      await pool.query(
        `
        UPDATE project_issues

        SET
          ${updates.join(', ')}

        WHERE id = $1
          AND project_code = $2

        RETURNING *
        `,
        params
      );


    return res.status(200).json({

      success: true,

      message:
        'Issue updated successfully.',

      data:
        rows[0]

    });


  } catch (err) {

    console.error(
      'updateProjectIssue error:',
      err
    );


    return res.status(500).json({
      success: false,
      message:
        'Failed to update issue',
      error:
        err.message
    });
  }
};


// ============================================================
// GET PROJECT REPORTS
// ============================================================

const getProjectReports = async (req, res) => {

  if (authRequired(req, res)) {
    return;
  }


  const { code } =
    req.params;


  const {
    type,
    search
  } = req.query;


  try {

    const accessProject =
      await getAccessibleProject(
        code,
        req.user.id,
        req.user.email
      );


    if (!accessProject) {

      return res.status(403).json({
        success: false,
        message:
          'You do not have access to this project.'
      });
    }


    let query = `
      SELECT

        r.id,

        r.project_code,

        r.title,

        r.report_type,

        r.report_date,

        r.summary,

        r.key_activities,

        r.issues_highlighted,

        r.manpower_count,

        r.equipment_on_site,

        r.weather,

        r.status,

        r.created_at,

        u.full_name
          AS prepared_by_name,

        u.role
          AS prepared_by_role

      FROM project_reports r

      LEFT JOIN users u
        ON u.id = r.prepared_by

      WHERE r.project_code = $1
    `;


    const params =
      [
        code
      ];


    if (
      type &&
      type !== 'All'
    ) {

      params.push(
        type
      );


      query += `
        AND r.report_type = $${params.length}
      `;
    }


    if (
      search &&
      search.trim()
    ) {

      params.push(
        `%${search
          .trim()
          .toLowerCase()}%`
      );


      query += `
        AND (
          LOWER(r.title)
            LIKE $${params.length}

          OR LOWER(r.summary)
            LIKE $${params.length}
        )
      `;
    }


    query += `
      ORDER BY
        r.created_at DESC
    `;


    const { rows } =
      await pool.query(
        query,
        params
      );


    return res.status(200).json({
      success: true,
      data:
        rows
    });


  } catch (err) {

    console.error(
      'getProjectReports error:',
      err
    );


    return res.status(500).json({
      success: false,
      message:
        'Failed to fetch project reports',
      error:
        err.message
    });
  }
};


// ============================================================
// CREATE PROJECT REPORT
// ============================================================

const createProjectReport = async (req, res) => {

  if (authRequired(req, res)) {
    return;
  }


  const { code } =
    req.params;


  const {

    title,

    report_type,

    report_date,

    summary,

    key_activities,

    issues_highlighted,

    manpower_count,

    equipment_on_site,

    weather

  } = req.body;


  const userId =
    req.user.id;


  if (
    !title ||
    !summary
  ) {

    return res.status(400).json({
      success: false,
      message:
        'title and summary are required.'
    });
  }


  try {

    const accessProject =
      await getAccessibleProject(
        code,
        req.user.id,
        req.user.email
      );


    if (!accessProject) {

      return res.status(403).json({
        success: false,
        message:
          'You do not have access to this project.'
      });
    }


    const { rows } =
      await pool.query(
        `
        INSERT INTO project_reports
        (
          project_code,

          title,

          report_type,

          report_date,

          prepared_by,

          summary,

          key_activities,

          issues_highlighted,

          manpower_count,

          equipment_on_site,

          weather,

          status
        )

        VALUES (
          $1,
          $2,
          $3,

          COALESCE(
            $4::DATE,
            CURRENT_DATE
          ),

          $5,
          $6,
          $7,
          $8,
          $9,
          $10,
          $11,
          'Final'
        )

        RETURNING *
        `,
        [

          code,

          title.trim(),

          report_type ||
            'Daily Site Log',

          report_date ||
            null,

          userId,

          summary.trim(),

          key_activities ||
            null,

          issues_highlighted ||
            null,

          parseInt(
            manpower_count
          ) || 0,

          equipment_on_site ||
            null,

          weather ||
            'Clear'

        ]
      );


    return res.status(201).json({

      success: true,

      message:
        'Project report created successfully.',

      data:
        rows[0]

    });


  } catch (err) {

    console.error(
      'createProjectReport error:',
      err
    );


    return res.status(500).json({
      success: false,
      message:
        'Failed to create project report',
      error:
        err.message
    });
  }
};


// ============================================================
// EXPORTS
// ============================================================

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

  getProjectProgress,

  logProjectProgress,

  getProjectIssues,

  createProjectIssue,

  updateProjectIssue,

  getProjectReports,

  createProjectReport

};