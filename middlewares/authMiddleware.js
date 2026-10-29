const jwt = require('jsonwebtoken');
const pool = require('../db');
const authenticated = Symbol('verifiedSession');

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  console.error('❌ FATAL: JWT_SECRET is not set in .env');
  process.exit(1);
}

/**
 * Middleware that verifies the JWT token from the Authorization header.
 * Attaches the decoded user payload to req.user.
 */
const verifyToken = async (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  res.vary('Authorization');
  if (req[authenticated]) return next();
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Access denied. No token provided.' });
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(decoded.id || '')) {
      return res.status(401).json({ error: 'Invalid session.' });
    }
    const { rows } = await pool.query('SELECT id, email, role FROM users WHERE id = $1 AND is_active = TRUE', [decoded.id]);
    if (!rows.length) return res.status(401).json({ error: 'Active account required.' });
    req.user = rows[0];
    req[authenticated] = true;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired. Please log in again.' });
    }
    if (err.name === 'JsonWebTokenError' || err.name === 'NotBeforeError') {
      return res.status(401).json({ error: 'Invalid token.' });
    }
    return next(err);
  }
};

/**
 * Middleware that restricts access to admin users only.
 * Must be used AFTER verifyToken.
 */
const requireAdmin = (req, res, next) => {
  if (!req.user || req.user.role?.toLowerCase() !== 'admin') {
    return res.status(403).json({ error: 'Admin access required.' });
  }
  next();
};

module.exports = { verifyToken, requireAdmin };
