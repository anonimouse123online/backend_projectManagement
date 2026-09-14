const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  console.error('❌ FATAL: JWT_SECRET is not set in .env');
  process.exit(1);
}

/**
 * Middleware that verifies the JWT token from the Authorization header.
 * Attaches the decoded user payload to req.user.
 */
const verifyToken = (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Access denied. No token provided.' });
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded; // { id, email, role, iat, exp }
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired. Please log in again.' });
    }
    return res.status(403).json({ error: 'Invalid token.' });
  }
};

/**
 * Middleware that restricts access to admin users only.
 * Must be used AFTER verifyToken.
 */
const requireAdmin = async (req, res, next) => {
  const role = req.user?.role?.trim().toLowerCase();

  // 1. Direct check from decoded JWT token
  if (role === 'admin' || role === 'owner') {
    return next();
  }

  // 2. Fallback check from database in case role capitalization differs or user owns projects
  const userId = req.user?.id || req.user?.user_id;
  if (userId) {
    try {
      const pool = require('../db');
      const userRes = await pool.query(
        'SELECT role FROM users WHERE id = $1 AND is_active = TRUE',
        [userId]
      );
      if (userRes.rows.length > 0) {
        const dbRole = userRes.rows[0].role?.trim().toLowerCase();
        if (dbRole === 'admin' || dbRole === 'owner') {
          return next();
        }
      }

      // Check if user is owner of any project
      const ownerRes = await pool.query(
        'SELECT id FROM projects WHERE owner_id = $1 LIMIT 1',
        [userId]
      );
      if (ownerRes.rows.length > 0) {
        return next();
      }
    } catch (err) {
      console.error('requireAdmin fallback check error:', err);
    }
  }

  return res.status(403).json({ error: 'Admin access required.' });
};

module.exports = { verifyToken, requireAdmin };

