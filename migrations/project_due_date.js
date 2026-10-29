'use strict';
const fs = require('node:fs');
const path = require('node:path');
const pool = require('../db');

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(fs.readFileSync(path.join(__dirname, 'project_due_date.sql'), 'utf8'));
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

if (require.main === module) migrate().catch(error => {
  console.error('Project due-date migration failed:', error.code || error.message);
  process.exitCode = 1;
}).finally(() => pool.end());

module.exports = { migrate };
