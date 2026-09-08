const pool = require('../db');


// ============================================================
// AUTH HELPER
// ============================================================

const requireUser = (req, res) => {

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
// PROJECT ACCESS SQL
//
// User can access project when:
//
// 1. p.owner_id = logged-in user
// OR
// 2. user exists in project_members
//
// project_members.project_id -> projects.code
// ============================================================

const PROJECT_ACCESS_SQL = `
(
  p.owner_id = $1

  OR EXISTS (
    SELECT 1

    FROM project_members pm

    WHERE pm.project_id = p.code
      AND pm.user_id = $1
  )
)
`;


// ============================================================
// DASHBOARD STATS
//
// Everything here is scoped to projects the user:
// - owns
// - joined
// ============================================================

exports.getStats = async (req, res) => {

  if (!requireUser(req, res)) {
    return;
  }

  try {

    const { range } = req.query;

    const userId =
      req.user.id;


    // ============================================================
    // PROJECT COUNT
    // ============================================================

    const projectQuery = `
      SELECT

        COUNT(*) AS total,

        COUNT(*) FILTER (
          WHERE
            status = 'Ongoing'
            OR status = 'Planning'
        ) AS active

      FROM projects p

      WHERE ${PROJECT_ACCESS_SQL}
    `;


    // ============================================================
    // TASK COUNT
    //
    // tasks.project_id -> projects.id
    // ============================================================

    const taskQuery = `
      SELECT
        COUNT(*) AS total

      FROM tasks t

      INNER JOIN projects p
        ON p.id = t.project_id

      WHERE ${PROJECT_ACCESS_SQL}
    `;


    // ============================================================
    // ISSUES COUNT
    //
    // project_issues.project_code -> projects.code
    // ============================================================

    const issueQuery = `
      SELECT
        COUNT(*) AS total

      FROM project_issues i

      INNER JOIN projects p
        ON p.code = i.project_code

      WHERE ${PROJECT_ACCESS_SQL}

        AND i.status != 'Resolved'
    `;


    // ============================================================
    // TEAM MEMBER COUNT
    //
    // Counts:
    // - project owners
    // - project members
    //
    // But only for projects accessible by current user.
    // ============================================================

    const teamQuery = `
      WITH accessible_projects AS (

        SELECT
          p.code,
          p.owner_id

        FROM projects p

        WHERE ${PROJECT_ACCESS_SQL}
      ),

      project_users AS (

        SELECT
          owner_id AS user_id

        FROM accessible_projects

        WHERE owner_id IS NOT NULL


        UNION


        SELECT
          pm.user_id

        FROM project_members pm

        INNER JOIN accessible_projects ap
          ON ap.code = pm.project_id

        WHERE pm.user_id IS NOT NULL
      )

      SELECT
        COUNT(DISTINCT user_id) AS total

      FROM project_users
    `;


    const [
      projRes,
      taskRes,
      teamRes,
      issueRes
    ] = await Promise.all([

      pool.query(
        projectQuery,
        [userId]
      ),

      pool.query(
        taskQuery,
        [userId]
      ),

      pool.query(
        teamQuery,
        [userId]
      ),

      pool.query(
        issueQuery,
        [userId]
      )

    ]);


    const activeProjects =
      parseInt(
        projRes.rows[0]?.active ??
        projRes.rows[0]?.total ??
        0
      ) || 0;


    const totalTasks =
      parseInt(
        taskRes.rows[0]?.total ??
        0
      ) || 0;


    const teamMembers =
      parseInt(
        teamRes.rows[0]?.total ??
        0
      ) || 0;


    const issuesReported =
      parseInt(
        issueRes.rows[0]?.total ??
        0
      ) || 0;


    const stats = [

      {
        label: 'Active Projects',
        value: String(activeProjects),
        trend:
          activeProjects > 0
            ? '+100%'
            : '0%',
        up:
          activeProjects > 0,
        bg: '#EFF6FF',
        clr: '#3B82F6',
        icon: '📋'
      },

      {
        label: 'Total Tasks',
        value: String(totalTasks),
        trend:
          totalTasks > 0
            ? '+100%'
            : '0%',
        up:
          totalTasks > 0,
        bg: '#F0FDF4',
        clr: '#22C55E',
        icon: '✅'
      },

      {
        label: 'Team Members',
        value: String(teamMembers),
        trend:
          teamMembers > 0
            ? '+100%'
            : '0%',
        up:
          teamMembers > 0,
        bg: '#FFFBEB',
        clr: '#F59E0B',
        icon: '👥'
      },

      {
        label: 'Issues Reported',
        value: String(issuesReported),
        trend:
          issuesReported > 0
            ? '+100%'
            : '0%',
        up: false,
        bg: '#FEF2F2',
        clr: '#EF4444',
        icon: '⚠️'
      }

    ];


    return res.status(200).json({

      success: true,

      data: stats,

      range:
        range ||
        'Last 30 days'

    });


  } catch (err) {

    console.error(
      'getStats error:',
      err
    );


    return res.status(500).json({
      success: false,
      error:
        'Failed to fetch stats.'
    });
  }
};


// ============================================================
// DASHBOARD PROJECTS
//
// Returns only:
// - owned projects
// - joined projects
// ============================================================

exports.getProjects = async (req, res) => {

  if (!requireUser(req, res)) {
    return;
  }

  try {

    const {
      project,
      pm,
      status,
      search
    } = req.query;


    const userId =
      req.user.id;


    const conditions = [
      PROJECT_ACCESS_SQL
    ];


    const params = [
      userId
    ];


    // ============================================================
    // PROJECT FILTER
    // ============================================================

    if (
      project &&
      project !== 'All'
    ) {

      params.push(
        project
      );

      conditions.push(
        `p.name ILIKE $${params.length}`
      );
    }


    // ============================================================
    // CLIENT / PM FILTER
    // ============================================================

    if (
      pm &&
      pm !== 'All'
    ) {

      params.push(
        pm
      );

      conditions.push(
        `p.client ILIKE $${params.length}`
      );
    }


    // ============================================================
    // STATUS FILTER
    // ============================================================

    if (
      status &&
      status !== 'All'
    ) {

      params.push(
        status
      );

      conditions.push(
        `p.status ILIKE $${params.length}`
      );
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
          p.name ILIKE $${params.length}

          OR p.client ILIKE $${params.length}

          OR p.phase ILIKE $${params.length}

          OR p.code ILIKE $${params.length}
        )
      `);
    }


    const where = `
      WHERE ${conditions.join(' AND ')}
    `;


    const { rows } =
      await pool.query(
        `
        SELECT

          p.id,

          p.code,

          p.name,

          p.client
            AS pm,

          TO_CHAR(
            p.end_date,
            'Mon DD, YYYY'
          ) AS date,

          p.status,

          COALESCE(
            p.phase,
            '—'
          ) AS prog,

          COALESCE(
            p.progress,
            0
          ) AS progress,

          p.owner_id,

          CASE

            WHEN p.owner_id = $1
              THEN 'owner'

            ELSE 'member'

          END AS access_type

        FROM projects p

        ${where}

        ORDER BY
          p.created_at DESC
        `,
        params
      );


    return res.status(200).json({
      success: true,
      data: rows
    });


  } catch (err) {

    console.error(
      'getProjects error:',
      err
    );


    return res.status(500).json({
      success: false,
      error:
        'Failed to fetch projects.'
    });
  }
};


// ============================================================
// MONITOR ITEMS
//
// Currently global.
//
// Your monitor_items table is not currently linked to a project
// in this controller, so we leave this unchanged for now.
// ============================================================

exports.getMonitorItems = async (req, res) => {

  if (!requireUser(req, res)) {
    return;
  }

  try {

    const { search } =
      req.query;


    let query = `
      SELECT
        label,
        checked

      FROM monitor_items
    `;


    const params = [];


    if (
      search &&
      search.trim()
    ) {

      params.push(
        `%${search.trim()}%`
      );


      query += `
        WHERE label ILIKE $1
      `;
    }


    query += `
      ORDER BY sort_order
    `;


    const { rows } =
      await pool.query(
        query,
        params
      );


    return res.status(200).json({
      success: true,
      data: rows
    });


  } catch (err) {

    console.error(
      'getMonitorItems error:',
      err
    );


    return res.status(500).json({
      success: false,
      error:
        'Failed to fetch monitor items.'
    });
  }
};


// ============================================================
// URGENT RFIs
//
// Currently global because rfis are not being connected
// to a project in the current query/schema.
// ============================================================

exports.getRFIs = async (req, res) => {

  if (!requireUser(req, res)) {
    return;
  }

  try {

    const { search } =
      req.query;


    let query = `
      SELECT
        label

      FROM rfis

      WHERE is_urgent = TRUE
    `;


    const params = [];


    if (
      search &&
      search.trim()
    ) {

      params.push(
        `%${search.trim()}%`
      );


      query += `
        AND label ILIKE $1
      `;
    }


    query += `
      ORDER BY sort_order
    `;


    const { rows } =
      await pool.query(
        query,
        params
      );


    return res.status(200).json({

      success: true,

      data:
        rows.map(
          row => row.label
        )

    });


  } catch (err) {

    console.error(
      'getRFIs error:',
      err
    );


    return res.status(500).json({
      success: false,
      error:
        'Failed to fetch RFIs.'
    });
  }
};


// ============================================================
// NOTES
//
// Currently global for same reason as monitor/RFI.
// ============================================================

exports.getNotes = async (req, res) => {

  if (!requireUser(req, res)) {
    return;
  }

  try {

    const { search } =
      req.query;


    let query = `
      SELECT
        label,
        status,
        cls

      FROM notes
    `;


    const params = [];


    if (
      search &&
      search.trim()
    ) {

      params.push(
        `%${search.trim()}%`
      );


      query += `
        WHERE label ILIKE $1
      `;
    }


    query += `
      ORDER BY sort_order
    `;


    const { rows } =
      await pool.query(
        query,
        params
      );


    return res.status(200).json({
      success: true,
      data: rows
    });


  } catch (err) {

    console.error(
      'getNotes error:',
      err
    );


    return res.status(500).json({
      success: false,
      error:
        'Failed to fetch notes.'
    });
  }
};


// ============================================================
// GAUGE STATS
//
// IMPORTANT:
// Only tasks belonging to accessible projects are counted.
// ============================================================

exports.getGaugeStats = async (req, res) => {

  if (!requireUser(req, res)) {
    return;
  }

  try {

    const { category } =
      req.query;


    const userId =
      req.user.id;


    const conditions = [
      PROJECT_ACCESS_SQL
    ];


    const params = [
      userId
    ];


    if (
      category &&
      category !== 'All'
    ) {

      params.push(
        `%${category}%`
      );


      conditions.push(
        `t.phase ILIKE $${params.length}`
      );
    }


    const { rows } =
      await pool.query(
        `
        SELECT

          COUNT(*)
            AS total,


          COUNT(*) FILTER (
            WHERE
              t.status ILIKE 'in%progress'
              OR t.status ILIKE 'ongoing'
          ) AS active_count,


          COUNT(*) FILTER (
            WHERE t.status ILIKE 'completed'
          ) AS done_count,


          COUNT(*) FILTER (
            WHERE
              t.status ILIKE 'delayed'
              OR t.status ILIKE 'blocked'
          ) AS delayed_count,


          COUNT(*) FILTER (
            WHERE t.status ILIKE 'pending'
          ) AS pending_count


        FROM tasks t


        INNER JOIN projects p
          ON p.id = t.project_id


        WHERE
          ${conditions.join(' AND ')}
        `,
        params
      );


    const {
      active_count,
      done_count,
      delayed_count,
      pending_count
    } = rows[0];


    const data = [

      {
        v:
          String(
            active_count || 0
          ),
        l: 'Active',
        c: '#2563eb'
      },

      {
        v:
          String(
            done_count || 0
          ),
        l: 'Done',
        c: '#16a34a'
      },

      {
        v:
          String(
            delayed_count || 0
          ),
        l: 'Delayed',
        c: '#ef4444'
      },

      {
        v:
          String(
            pending_count || 0
          ),
        l: 'Pending',
        c: '#f59e0b'
      }

    ];


    return res.status(200).json({
      success: true,
      data
    });


  } catch (err) {

    console.error(
      'getGaugeStats error:',
      err
    );


    return res.status(500).json({
      success: false,
      error:
        'Failed to fetch gauge stats.'
    });
  }
};


// ============================================================
// OVERALL PROGRESS
//
// FIXES:
// - projects.progress_pct DOES NOT exist
// - use projects.progress instead
//
// Also isolates data per logged-in user's projects.
// ============================================================

exports.getOverallProgress = async (req, res) => {

  if (!requireUser(req, res)) {
    return;
  }

  try {

    const { category } =
      req.query;


    const userId =
      req.user.id;


    // ============================================================
    // TASK STATISTICS
    // ============================================================

    const taskConditions = [
      PROJECT_ACCESS_SQL
    ];


    const taskParams = [
      userId
    ];


    if (
      category &&
      category !== 'All'
    ) {

      taskParams.push(
        `%${category}%`
      );


      taskConditions.push(
        `t.phase ILIKE $${taskParams.length}`
      );
    }


    const taskStats =
      await pool.query(
        `
        SELECT

          COUNT(*)
            AS total,


          COUNT(*) FILTER (
            WHERE t.status ILIKE 'completed'
          ) AS completed,


          COUNT(*) FILTER (
            WHERE
              t.status ILIKE 'in%progress'
              OR t.status ILIKE 'ongoing'
          ) AS in_progress,


          COUNT(*) FILTER (
            WHERE t.status ILIKE 'pending'
          ) AS pending


        FROM tasks t


        INNER JOIN projects p
          ON p.id = t.project_id


        WHERE
          ${taskConditions.join(' AND ')}
        `,
        taskParams
      );


    const {

      total,

      completed,

      in_progress,

      pending

    } = taskStats.rows[0];


    // ============================================================
    // PROJECT STATISTICS
    //
    // IMPORTANT:
    // Your projects table uses:
    //
    // progress
    //
    // NOT:
    //
    // progress_pct
    // ============================================================

    const projectConditions = [
      PROJECT_ACCESS_SQL
    ];


    const projectParams = [
      userId
    ];


    if (
      category &&
      category !== 'All'
    ) {

      projectParams.push(
        `%${category}%`
      );


      // Only projects containing a task
      // in the selected phase/category.
      projectConditions.push(`
        EXISTS (

          SELECT 1

          FROM tasks category_task

          WHERE category_task.project_id = p.id

            AND category_task.phase
              ILIKE $${projectParams.length}

        )
      `);
    }


    const projectStats =
      await pool.query(
        `
        SELECT

          COUNT(*)
            AS total,


          COUNT(*) FILTER (
            WHERE p.status = 'Ongoing'
          ) AS active,


          COUNT(*) FILTER (
            WHERE p.status = 'Completed'
          ) AS completed,


          COUNT(*) FILTER (
            WHERE p.status = 'Planning'
          ) AS planning,


          COALESCE(
            ROUND(
              AVG(
                COALESCE(
                  p.progress,
                  0
                )
              )
            ),
            0
          ) AS avg_proj_progress


        FROM projects p


        WHERE
          ${projectConditions.join(' AND ')}
        `,
        projectParams
      );


    const projects =
      projectStats.rows[0];


    // ============================================================
    // OVERALL PROGRESS
    //
    // We now use the manually stored project progress.
    // ============================================================

    const percentage =
      parseInt(
        projects.avg_proj_progress
      ) || 0;


    return res.status(200).json({

      success: true,

      data: {

        overallProgress:
          percentage,


        category:
          category ||
          'All',


        tasks: {

          total:
            parseInt(total) || 0,

          completed:
            parseInt(completed) || 0,

          in_progress:
            parseInt(in_progress) || 0,

          pending:
            parseInt(pending) || 0

        },


        projects: {

          total:
            parseInt(
              projects.total
            ) || 0,

          active:
            parseInt(
              projects.active
            ) || 0,

          completed:
            parseInt(
              projects.completed
            ) || 0,

          planning:
            parseInt(
              projects.planning
            ) || 0,

          avgProgress:
            parseInt(
              projects.avg_proj_progress
            ) || 0

        }

      }

    });


  } catch (err) {

    console.error(
      '======================================'
    );

    console.error(
      '❌ getOverallProgress ERROR'
    );

    console.error(
      'MESSAGE:',
      err.message
    );

    console.error(
      'CODE:',
      err.code
    );

    console.error(
      'USER:',
      req.user
    );

    console.error(
      '======================================'
    );


    return res.status(500).json({
      success: false,
      error:
        'Failed to compute progress.',
      message:
        err.message
    });
  }
};