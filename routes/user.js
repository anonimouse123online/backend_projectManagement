const express = require('express');
const router = express.Router();
const taskController = require('../controllers/taskController');
const pool = require('../db');
const { requireAdmin } = require('../middlewares/authMiddleware');

router.get('/', taskController.getUsers); // GET /users

// PATCH /users/:id/role  — Admin only
router.patch('/:id/role', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { role } = req.body;

  if (!role) {
    return res.status(400).json({ error: 'role is required.' });
  }

  const allowedRoles = ['Admin', 'Site Engineer', 'Project Manager', 'Supervisor'];
  if (!allowedRoles.includes(role)) {
    return res.status(400).json({ error: `Invalid role. Must be one of: ${allowedRoles.join(', ')}` });
  }

  try {
    const { rows } = await pool.query(
      `UPDATE users SET role = $1, updated_at = NOW() WHERE id = $2 AND is_active = TRUE
       RETURNING id, full_name, email, role`,
      [role, id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('updateUserRole error:', err);
    res.status(500).json({ error: 'Failed to update user role.' });
  }
});

module.exports = router;