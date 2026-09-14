const pool = require('./db');

const sql = `
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS is_group BOOLEAN DEFAULT FALSE;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS name VARCHAR(255);
`;

pool.query(sql).then(() => {
  console.log('Database altered successfully: added is_group and name to conversations.');
  process.exit(0);
}).catch(err => {
  console.log('Error altering database:', err);
  process.exit(1);
});
