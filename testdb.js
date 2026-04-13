const { Client } = require('pg');

const client = new Client({
  host:     'localhost',
  port:     5432,        // ← try this
  database: 'sitepulse',
  user:     'postgres',
  password: 'sitepulse12345',
  ssl:      false,
  family:   4,
});

client.connect()
  .then(async () => {
    console.log('✅ Connected!');
    const res = await client.query('SELECT datname FROM pg_database');
    console.log('Databases:', res.rows.map(r => r.datname));
    return client.end();
  })
  .catch(err => {
    console.error('❌ Failed:', err.message);
    console.error('Code:', err.code);
  });