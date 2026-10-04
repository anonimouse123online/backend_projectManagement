const pool = require('../db');
const { validateSecurityContext, invalid } = require('../services/loginSecurityContext');
const { recordLoginSecurityEventSafely } = require('../services/loginSecurityService');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES = new Set(['NORMAL', 'SUSPICIOUS', 'NEEDS_REVIEW']);

// Recheck the current account for these sensitive routes, in addition to the
// existing JWT/RBAC middleware (a seven-day token may predate a role change).
async function requireActiveSecurityUser(req, res, next) {
  try {
    if (typeof req.user?.id !== 'string' || !UUID.test(req.user.id)) {
      return res.status(403).json({ error: 'Active account required.' });
    }
    const result = await pool.query(
      'SELECT id, full_name, email, role FROM users WHERE id = $1 AND is_active = TRUE', [req.user.id]
    );
    if (!result.rows[0]) return res.status(403).json({ error: 'Active account required.' });
    req.securityUser = result.rows[0];
    next();
  } catch (error) {
    console.error('Security account check failed:', error.code || 'DATABASE_ERROR');
    return res.status(500).json({ success: false, error: 'Unable to verify account.' });
  }
}

function requireCurrentAdmin(req, res, next) {
  if (req.securityUser?.role?.toLowerCase() !== 'admin') {
    return res.status(403).json({ error: 'Admin access required.' });
  }
  next();
}

function integerParam(value, name, fallback, max) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > max) {
    throw invalid(`${name} must be an integer between 1 and ${max}.`);
  }
  return Number(value);
}

function timestampParam(value, name) {
  if (typeof value !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value)) {
    throw invalid(`${name} must be YYYY-MM-DD or an ISO timestamp with a timezone.`);
  }
  const datePart = value.slice(0, 10);
  if (value.startsWith('0000-') || (value.length > 10 &&
      (Number(value.slice(11, 13)) > 23 || Number(value.slice(14, 16)) > 59 ||
       Number(value.slice(17, 19)) > 59))) {
    throw invalid(`${name} must be a valid date and time.`);
  }
  const midnight = new Date(`${datePart}T00:00:00Z`);
  const date = new Date(value.length === 10 ? `${value}T00:00:00Z` : value);
  if (!Number.isFinite(date.getTime()) || !Number.isFinite(midnight.getTime()) || midnight.toISOString().slice(0, 10) !== datePart) {
    throw invalid(`${name} must be a valid date.`);
  }
  return date.toISOString();
}

function parseLogFilters(query) {
  const page = integerParam(query.page, 'page', 1, 1000000);
  const limit = integerParam(query.limit, 'limit', 25, 100);
  const clauses = [], values = [];
  const add = (column, operator, value) => {
    values.push(value);
    clauses.push(`${column} ${operator} $${values.length}`);
  };
  if (query.user_id !== undefined) {
    if (typeof query.user_id !== 'string' || !UUID.test(query.user_id)) throw invalid('user_id must be a UUID.');
    add('user_id', '=', query.user_id);
  }
  if (query.status !== undefined) {
    if (!STATUSES.has(query.status)) throw invalid('status must be NORMAL, SUSPICIOUS, or NEEDS_REVIEW.');
    add('security_status', '=', query.status);
  }
  const from = query.from === undefined ? null : timestampParam(query.from, 'from');
  const to = query.to === undefined ? null : timestampParam(query.to, 'to');
  if (from && to && from > to) throw invalid('from must be before or equal to to.');
  if (from) add('created_at', '>=', from);
  if (to) add('created_at', '<=', to);
  return { page, limit, offset: (page - 1) * limit, where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', values };
}

function serializeLog(row) {
  const result = { ...row };
  for (const field of ['latitude', 'longitude', 'location_accuracy']) {
    if (result[field] !== null && result[field] !== undefined) result[field] = Number(result[field]);
  }
  return result;
}

function handleError(res, error, message) {
  if (error.status === 400) return res.status(400).json({ success: false, error: error.message });
  console.error(message, error.code || 'DATABASE_ERROR');
  return res.status(500).json({ success: false, error: message });
}

async function getLoginSecurityLogs(req, res) {
  try {
    const { page, limit, offset, where, values } = parseLogFilters(req.query);
    const [count, result] = await Promise.all([
      pool.query(`SELECT COUNT(*) AS total FROM login_security_logs ${where}`, values),
      pool.query(`SELECT * FROM login_security_logs ${where} ORDER BY created_at DESC, id DESC
        LIMIT $${values.length + 1} OFFSET $${values.length + 2}`, [...values, limit, offset]),
    ]);
    return res.json({ success: true, data: result.rows.map(serializeLog), pagination: { page, limit, total: Number(count.rows[0].total) } });
  } catch (error) {
    return handleError(res, error, 'Failed to fetch login security logs.');
  }
}

async function getLoginSecurityLog(req, res) {
  try {
    if (!/^[1-9]\d{0,18}$/.test(req.params.id) || BigInt(req.params.id) > 9223372036854775807n) {
      throw invalid('id must be a positive BIGINT.');
    }
    const result = await pool.query('SELECT * FROM login_security_logs WHERE id = $1', [req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ success: false, error: 'Login security log not found.' });
    return res.json({ success: true, data: serializeLog(result.rows[0]) });
  } catch (error) {
    return handleError(res, error, 'Failed to fetch login security log.');
  }
}

async function logout(req, res) {
  try {
    const context = validateSecurityContext(req.body?.security_context, req.headers['user-agent']);
    const security = await recordLoginSecurityEventSafely({ req, user: req.securityUser, email: req.securityUser.email, context, eventType: 'LOGOUT' });
    return res.json({ success: true, message: 'Logout recorded. Clear the token on the client.',
      security_audit_available: security.security_audit_available });
  } catch (error) {
    return handleError(res, error, 'Failed to record logout.');
  }
}

module.exports = { requireActiveSecurityUser, requireCurrentAdmin, getLoginSecurityLogs, getLoginSecurityLog, logout, parseLogFilters };
