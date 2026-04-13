const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  host:                    process.env.DB_HOST,
  port:                    parseInt(process.env.DB_PORT),
  database:                process.env.DB_NAME,
  user:                    process.env.DB_USER,
  password:                process.env.DB_PASSWORD,
  ssl:                     false,
  family:                  4,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis:       30000,
  max:                     10,
});

if (process.env.NODE_ENV !== 'production') {
  pool.on('connect', () => {
    console.log('📦 New DB client connected');
  });
}

pool.on('error', (err) => {
  console.error('❌ Unexpected DB error:', err.message);
  process.exit(1);
});

module.exports = pool;