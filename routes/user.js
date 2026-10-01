const express = require('express');
const router = express.Router();

const taskController = require('../controllers/taskController');
const pool = require('../db');

const {
  requireAdmin
} = require('../middlewares/authMiddleware');


// ============================================================
// GET ALL USERS
// GET /users
// ============================================================

router.get(
  '/',
  taskController.getUsers
);


// ============================================================
// SEARCH USERS FOR MESSAGING
//
// GET /users/search?q=kurt
//
// Returns users except the currently logged-in user.
// ============================================================

router.get(
  '/search',
  async (req, res) => {

    try {

      const currentUserId =
        req.user?.id ||
        req.user?.user_id ||
        req.user?.userId;

      const search =
        String(
          req.query.q || ''
        ).trim();

      if (!currentUserId) {

        return res.status(401).json({
          success: false,
          message: 'Unauthorized'
        });
      }

      let result;

      if (!search) {
        result = await pool.query(
          `
          SELECT
            u.id,
            u.full_name,
            u.email,
            u.role,
            ARRAY_AGG(DISTINCT rel.name) FILTER (WHERE rel.name IS NOT NULL) AS shared_projects
          FROM users u
          JOIN (
            -- 1. Members of projects owned by current user
            SELECT pm.user_id, p.name
            FROM project_members pm
            JOIN projects p ON (pm.project_id = p.code OR pm.project_id = p.id::text)
            WHERE p.owner_id = $1::uuid
            
            UNION
            
            -- 2. Owner of projects where current user is a member
            SELECT p.owner_id AS user_id, p.name
            FROM projects p
            JOIN project_members pm ON (pm.project_id = p.code OR pm.project_id = p.id::text)
            WHERE pm.user_id = $1::uuid
            
            UNION
            
            -- 3. Co-members in projects where current user is a member
            SELECT pm1.user_id, p.name
            FROM project_members pm1
            JOIN projects p ON (pm1.project_id = p.code OR pm1.project_id = p.id::text)
            WHERE pm1.project_id IN (
              SELECT pm2.project_id
              FROM project_members pm2
              WHERE pm2.user_id = $1::uuid
            )
          ) rel ON rel.user_id = u.id
          WHERE u.is_active = TRUE
            AND u.id != $1::uuid
          GROUP BY u.id, u.full_name, u.email, u.role
          ORDER BY u.full_name ASC
          LIMIT 50
          `,
          [currentUserId]
        );
      } else {
        result = await pool.query(
          `
          SELECT
            u.id,
            u.full_name,
            u.email,
            u.role,
            ARRAY_AGG(DISTINCT rel.name) FILTER (WHERE rel.name IS NOT NULL) AS shared_projects
          FROM users u
          JOIN (
            -- 1. Members of projects owned by current user
            SELECT pm.user_id, p.name
            FROM project_members pm
            JOIN projects p ON (pm.project_id = p.code OR pm.project_id = p.id::text)
            WHERE p.owner_id = $1::uuid
            
            UNION
            
            -- 2. Owner of projects where current user is a member
            SELECT p.owner_id AS user_id, p.name
            FROM projects p
            JOIN project_members pm ON (pm.project_id = p.code OR pm.project_id = p.id::text)
            WHERE pm.user_id = $1::uuid
            
            UNION
            
            -- 3. Co-members in projects where current user is a member
            SELECT pm1.user_id, p.name
            FROM project_members pm1
            JOIN projects p ON (pm1.project_id = p.code OR pm1.project_id = p.id::text)
            WHERE pm1.project_id IN (
              SELECT pm2.project_id
              FROM project_members pm2
              WHERE pm2.user_id = $1::uuid
            )
          ) rel ON rel.user_id = u.id
          WHERE u.is_active = TRUE
            AND u.id != $1::uuid
            AND (
              u.full_name ILIKE $2
              OR u.email ILIKE $2
              OR rel.name ILIKE $2
            )
          GROUP BY u.id, u.full_name, u.email, u.role
          ORDER BY u.full_name ASC
          LIMIT 50
          `,
          [
            currentUserId,
            `%${search}%`
          ]
        );
      }

      return res.status(200).json({
        success: true,
        users: result.rows
      });

    } catch (error) {

      console.error(
        'SEARCH USERS ERROR:',
        error
      );

      return res.status(500).json({
        success: false,
        message:
          'Failed to search users'
      });
    }
  }
);


// ============================================================
// UPDATE USER ROLE
//
// PATCH /users/:id/role
// Admin only
// ============================================================

router.patch(
  '/:id/role',
  requireAdmin,
  async (req, res) => {

    const { id } =
      req.params;

    const { role } =
      req.body;

    if (!role) {

      return res.status(400).json({
        error:
          'role is required.'
      });
    }

    const allowedRoles = [
      'Admin',
      'Site Engineer',
      'Project Manager',
      'Supervisor'
    ];

    if (
      !allowedRoles.includes(role)
    ) {

      return res.status(400).json({
        error:
          `Invalid role. Must be one of: ${allowedRoles.join(', ')}`
      });
    }

    try {

      const { rows } =
        await pool.query(
          `
          UPDATE users
          SET
            role = $1,
            updated_at = NOW()
          WHERE
            id = $2
            AND is_active = TRUE
          RETURNING
            id,
            full_name,
            email,
            role
          `,
          [
            role,
            id
          ]
        );

      if (
        rows.length === 0
      ) {

        return res.status(404).json({
          error:
            'User not found.'
        });
      }

      res.json({
        success: true,
        data: rows[0]
      });

    } catch (err) {

      console.error(
        'updateUserRole error:',
        err
      );

      res.status(500).json({
        error:
          'Failed to update user role.'
      });
    }
  }
);


// ============================================================
// REMOVE USER FROM MY PROJECT TEAMS
//
// DELETE /users/:id
// Project Owner only — removes the user from project_members
// ONLY for projects owned by the currently logged-in user.
// Does NOT delete the user account or affect projects owned by others.
// ============================================================

router.delete(
  '/:id',
  async (req, res) => {
    const currentUserId = req.user?.id || req.user?.user_id || req.user?.userId;
    const { id } = req.params;

    if (!currentUserId) {
      return res.status(401).json({
        error: 'Unauthorized'
      });
    }

    if (id === currentUserId) {
      return res.status(400).json({
        error: 'You cannot remove your own account from your projects.'
      });
    }

    try {
      // 1. Make sure user exists
      const userCheck = await pool.query(
        `SELECT id, full_name FROM users WHERE id = $1 AND is_active = TRUE`,
        [id]
      );

      if (userCheck.rows.length === 0) {
        return res.status(404).json({
          error: 'User not found.'
        });
      }

      // 2. Check if the current user actually owns any projects that this user is a member of
      const ownedProjectsWithTarget = await pool.query(
        `SELECT pm.id, pm.project_id, p.name AS project_name
         FROM project_members pm
         JOIN projects p ON p.code = pm.project_id
         WHERE pm.user_id = $1::uuid
           AND p.owner_id = $2::uuid`,
        [id, currentUserId]
      );

      if (ownedProjectsWithTarget.rows.length === 0) {
        return res.status(403).json({
          error: 'Permission denied. You can only remove members from projects you own.'
        });
      }

      // 3. Remove from ONLY the projects owned by the current user
      const result = await pool.query(
        `DELETE FROM project_members
         WHERE user_id = $1::uuid
           AND project_id IN (
             SELECT code FROM projects WHERE owner_id = $2::uuid
           )
         RETURNING *`,
        [id, currentUserId]
      );

      console.log(
        `[ROUTE] DELETE /users/${id} by owner ${currentUserId} → removed from ${result.rowCount} project(s)`
      );

      return res.json({
        success: true,
        message: `User removed from your project team(s).`,
        removedFrom: result.rowCount
      });

    } catch (err) {
      console.error(
        'removeUserFromProjects error:',
        err
      );

      return res.status(500).json({
        error:
          'Failed to remove user from your project team.'
      });
    }
  }
);


module.exports = router;