const pool = require('../db');

const getAll = async (status, search, code) => {
  const conditions = [];
  const params = [];

  if (status && status !== 'All' && status !== 'All Statuses') {
    params.push(status);
    conditions.push(`status ILIKE $${params.length}`);
  }

  if (code && code !== 'All' && code !== 'All Projects') {
    params.push(code);
    conditions.push(`code ILIKE $${params.length}`);
  }

  if (search) {
    params.push(`%${search}%`);
    conditions.push(`(name ILIKE $${params.length} OR code ILIKE $${params.length} OR client ILIKE $${params.length} OR location ILIKE $${params.length})`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const query = `
    SELECT id, code, name, location, client, budget, phase, scope, status,
           TO_CHAR(start_date, 'YYYY-MM-DD') AS start_date,
           TO_CHAR(end_date, 'YYYY-MM-DD') AS end_date
    FROM projects
    ${where}
    ORDER BY created_at DESC
  `;

  const { rows } = await pool.query(query, params);
  return rows;
};

const getByCode = async (code) => {
  const { rows } = await pool.query(
    `SELECT id, code, name, location, client, budget, phase, scope, status,
            TO_CHAR(start_date, 'YYYY-MM-DD') AS start_date,
            TO_CHAR(end_date, 'YYYY-MM-DD') AS end_date
     FROM projects WHERE code ILIKE $1`,
    [code]
  );
  return rows[0] || null;
};

module.exports = { getAll, getByCode };