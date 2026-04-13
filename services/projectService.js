const pool = require('../db');

const getAll = async (status) => {
  const query = status
    ? `SELECT id, code, name, location, client, TO_CHAR(due_date, 'Mon DD, YYYY') AS due_date, status, progress
       FROM projects WHERE status ILIKE $1 ORDER BY created_at DESC`
    : `SELECT id, code, name, location, client, TO_CHAR(due_date, 'Mon DD, YYYY') AS due_date, status, progress
       FROM projects ORDER BY created_at DESC`;

  const { rows } = await pool.query(query, status ? [status] : []);
  return rows;
};

const getByCode = async (code) => {
  const { rows } = await pool.query(
    `SELECT id, code, name, location, client, TO_CHAR(due_date, 'Mon DD, YYYY') AS due_date, status, progress
     FROM projects WHERE code ILIKE $1`,
    [code]
  );
  return rows[0] || null;
};

module.exports = { getAll, getByCode };