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

      if (!search) {

        return res.status(200).json({
          success: true,
          users: []
        });
      }

      const result =
        await pool.query(
          `
          SELECT
            id,
            full_name,
            email,
            role
          FROM users
          WHERE
            is_active = TRUE
            AND id != $1
            AND (
              full_name ILIKE $2
              OR email ILIKE $2
            )
          ORDER BY
            full_name ASC
          LIMIT 20
          `,
          [
            currentUserId,
            `%${search}%`
          ]
        );

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


module.exports = router;