const fs = require('node:fs');
const path = require('node:path');
const pool = require('../db');

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(fs.readFileSync(path.join(__dirname, 'login_security_logs.sql'), 'utf8'));
    await client.query('COMMIT');
    console.log('Login security logs migration complete.');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

if (require.main === module) {
  migrate().catch(error => {
    console.error('Login security migration failed:', error.code || error.message);
    process.exitCode = 1;
  }).finally(() => pool.end());
}

module.exports = { migrate };
