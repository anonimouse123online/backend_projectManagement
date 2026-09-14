const pool = require('../db');

const getAll = async (status, search, code, userId) => {
  const conditions = [];
  const params = [];

  // ============================================================
  // OWNER / MEMBER ISOLATION
  // Only return projects owned by or shared with the current user.
  // ============================================================

  if (userId) {
    params.push(userId);
    conditions.push(`(
      p.owner_id = $${params.length}
      OR p.code IN (SELECT pm.project_id FROM project_members pm WHERE pm.user_id = $${params.length})
      OR p.id::text IN (SELECT pm.project_id FROM project_members pm WHERE pm.user_id = $${params.length})
    )`);
  }

  if (status && status !== 'All' && status !== 'All Statuses') {
    params.push(status);
    conditions.push(`p.status ILIKE $${params.length}`);
  }

  if (code && code !== 'All' && code !== 'All Projects') {
    params.push(code);
    conditions.push(`p.code ILIKE $${params.length}`);
  }

  if (search) {
    params.push(`%${search}%`);
    conditions.push(`(p.name ILIKE $${params.length} OR p.code ILIKE $${params.length} OR p.client ILIKE $${params.length} OR p.location ILIKE $${params.length})`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const query = `
    SELECT p.id, p.code, p.name, p.location, p.client, p.budget, p.phase, p.scope, p.status,
           TO_CHAR(p.start_date, 'YYYY-MM-DD') AS start_date,
           TO_CHAR(p.end_date, 'YYYY-MM-DD') AS end_date
    FROM projects p
    ${where}
    ORDER BY p.created_at DESC
  `;

  const { rows } = await pool.query(query, params);
  return rows;
};

const getByCode = async (code, userId) => {
  const params = [code];
  let ownerCheck = '';

  if (userId) {
    params.push(userId);
    ownerCheck = `AND (
      p.owner_id = $${params.length}
      OR p.code IN (SELECT pm.project_id FROM project_members pm WHERE pm.user_id = $${params.length})
      OR p.id::text IN (SELECT pm.project_id FROM project_members pm WHERE pm.user_id = $${params.length})
    )`;
  }

  const { rows } = await pool.query(
    `SELECT p.id, p.code, p.name, p.location, p.client, p.budget, p.phase, p.scope, p.status,
            TO_CHAR(p.start_date, 'YYYY-MM-DD') AS start_date,
            TO_CHAR(p.end_date, 'YYYY-MM-DD') AS end_date
     FROM projects p
     WHERE p.code ILIKE $1 ${ownerCheck}`,
    params
  );
  return rows[0] || null;
};

module.exports = { getAll, getByCode };