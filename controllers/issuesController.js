const pool = require('../db');


// ============================================================
// GET PROJECT ISSUES
// GET /projects/:projectId/issues
// ============================================================
exports.getProjectIssues = async (req, res) => {
  try {
    const { projectId } = req.params;

    const {
      status,
      category,
      priority,
      search
    } = req.query;

    let query = `
      SELECT
        i.id,
        p.project_code,
        i.title,
        i.category,
        i.priority,
        i.location,
        i.description,
        i.status,
        i.resolution_notes,
        i.assigned_to,
        i.created_at,
        i.updated_at,
        i.resolved_at,

        creator.full_name AS reporter_name,
        assignee.full_name AS assignee_name

      FROM issues i

      JOIN projects p
        ON p.id = i.project_id

      LEFT JOIN users creator
        ON creator.id = i.created_by

      LEFT JOIN users assignee
        ON assignee.id = i.assigned_to

      WHERE p.project_code = $1
    `;

    const values = [projectId];
    let index = 2;


    if (status) {
      query += ` AND i.status = $${index}`;
      values.push(status);
      index++;
    }


    if (category) {
      query += ` AND i.category = $${index}`;
      values.push(category);
      index++;
    }


    if (priority) {
      query += ` AND i.priority = $${index}`;
      values.push(priority);
      index++;
    }


    if (search) {
      query += `
        AND (
          i.title ILIKE $${index}
          OR i.description ILIKE $${index}
          OR COALESCE(i.location, '') ILIKE $${index}
        )
      `;

      values.push(`%${search}%`);
      index++;
    }


    query += `
      ORDER BY i.created_at DESC
    `;


    const { rows } =
      await pool.query(
        query,
        values
      );


    return res.json({
      success: true,
      data: rows
    });

  } catch (err) {

    console.error(
      'getProjectIssues error:',
      err
    );

    return res.status(500).json({
      success: false,
      message: err.message,
      code: err.code
    });
  }
};



// ============================================================
// CREATE ISSUE
// POST /projects/:projectId/issues
// ============================================================
exports.createIssue = async (req, res) => {
  try {

    const { projectId } =
      req.params;


    const {
      title,
      category,
      priority,
      location,
      description,
      assigned_to
    } = req.body;


    if (
      !title?.trim() ||
      !description?.trim()
    ) {

      return res.status(400).json({
        success: false,
        message:
          'Title and description are required.'
      });
    }


    // ========================================================
    // FIND PROJECT UUID USING PROJECT CODE
    // ========================================================

    const projectResult =
      await pool.query(
        `
        SELECT id
        FROM projects
        WHERE project_code = $1
        `,
        [projectId]
      );


    if (
      projectResult.rows.length === 0
    ) {

      return res.status(404).json({
        success: false,
        message:
          'Project not found.'
      });
    }


    const projectUuid =
      projectResult.rows[0].id;


    const createdBy =
      req.user?.id || null;


    const { rows } =
      await pool.query(
        `
        INSERT INTO issues (
          project_id,
          title,
          category,
          priority,
          location,
          description,
          status,
          created_by,
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
          projectUuid,
          title.trim(),
          category || null,
          priority || 'Medium',
          location?.trim() || null,
          description.trim(),
          createdBy,
          assigned_to || null
        ]
      );


    return res
      .status(201)
      .json({
        success: true,
        data: rows[0]
      });

  } catch (err) {

    console.error(
      'createIssue error:',
      err
    );


    return res
      .status(500)
      .json({
        success: false,
        message: err.message,
        code: err.code
      });
  }
};



// ============================================================
// GET SINGLE ISSUE
// GET /issues/:id
// ============================================================
exports.getIssueById = async (req, res) => {
  try {

    const { id } =
      req.params;


    const { rows } =
      await pool.query(
        `
        SELECT
          i.*,

          creator.full_name
            AS reporter_name,

          assignee.full_name
            AS assignee_name

        FROM issues i

        LEFT JOIN users creator
          ON creator.id = i.created_by

        LEFT JOIN users assignee
          ON assignee.id = i.assigned_to

        WHERE i.id = $1
        `,
        [id]
      );


    if (
      rows.length === 0
    ) {

      return res
        .status(404)
        .json({
          success: false,
          message:
            'Issue not found.'
        });
    }


    return res.json({
      success: true,
      data: rows[0]
    });

  } catch (err) {

    console.error(
      'getIssueById error:',
      err
    );


    return res
      .status(500)
      .json({
        success: false,
        message: err.message
      });
  }
};



// ============================================================
// UPDATE ISSUE
// PATCH /projects/:projectId/issues/:id
// ============================================================
exports.updateIssue = async (req, res) => {
  try {

    const {
      projectId,
      id
    } = req.params;


    const {
      title,
      category,
      description,
      status,
      priority,
      location,
      assigned_to,
      resolution_notes
    } = req.body;


    // Verify project
    const projectResult =
      await pool.query(
        `
        SELECT id
        FROM projects
        WHERE project_code = $1
        `,
        [projectId]
      );


    if (
      projectResult.rows.length === 0
    ) {

      return res
        .status(404)
        .json({
          success: false,
          message:
            'Project not found.'
        });
    }


    const projectUuid =
      projectResult.rows[0].id;


    const { rows } =
      await pool.query(
        `
        UPDATE issues

        SET
          title =
            COALESCE($1, title),

          category =
            COALESCE($2, category),

          description =
            COALESCE($3, description),

          status =
            COALESCE($4, status),

          priority =
            COALESCE($5, priority),

          location =
            COALESCE($6, location),

          assigned_to =
            COALESCE($7, assigned_to),

          resolution_notes =
            COALESCE(
              $8,
              resolution_notes
            ),

          resolved_at =
            CASE
              WHEN $4 = 'Resolved'
              THEN COALESCE(
                resolved_at,
                NOW()
              )

              WHEN $4 IS NOT NULL
                AND $4 <> 'Resolved'
              THEN NULL

              ELSE resolved_at
            END,

          updated_at = NOW()

        WHERE id = $9
          AND project_id = $10

        RETURNING *
        `,
        [
          title ?? null,
          category ?? null,
          description ?? null,
          status ?? null,
          priority ?? null,
          location ?? null,
          assigned_to ?? null,
          resolution_notes ?? null,
          id,
          projectUuid
        ]
      );


    if (
      rows.length === 0
    ) {

      return res
        .status(404)
        .json({
          success: false,
          message:
            'Issue not found.'
        });
    }


    return res.json({
      success: true,
      data: rows[0]
    });

  } catch (err) {

    console.error(
      'updateIssue error:',
      err
    );


    return res
      .status(500)
      .json({
        success: false,
        message: err.message,
        code: err.code
      });
  }
};



// ============================================================
// DELETE ISSUE
// DELETE /projects/:projectId/issues/:id
// ============================================================
exports.deleteIssue = async (req, res) => {
  try {

    const {
      projectId,
      id
    } = req.params;


    const projectResult =
      await pool.query(
        `
        SELECT id
        FROM projects
        WHERE project_code = $1
        `,
        [projectId]
      );


    if (
      projectResult.rows.length === 0
    ) {

      return res
        .status(404)
        .json({
          success: false,
          message:
            'Project not found.'
        });
    }


    const projectUuid =
      projectResult.rows[0].id;


    const { rowCount } =
      await pool.query(
        `
        DELETE FROM issues

        WHERE id = $1
          AND project_id = $2
        `,
        [
          id,
          projectUuid
        ]
      );


    if (
      rowCount === 0
    ) {

      return res
        .status(404)
        .json({
          success: false,
          message:
            'Issue not found.'
        });
    }


    return res.json({
      success: true,
      message:
        'Issue deleted successfully.'
    });

  } catch (err) {

    console.error(
      'deleteIssue error:',
      err
    );


    return res
      .status(500)
      .json({
        success: false,
        message: err.message
      });
  }
};