// migrate-passwords.js
// Run ONCE: node migrate-passwords.js
// Finds plain-text passwords and replaces them with bcrypt hashes.

require('dotenv').config();
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const pool = new Pool({
  host:     process.env.DB_HOST,
  port:     process.env.DB_PORT,
  database: process.env.DB_NAME,
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

const SALT_ROUNDS = 10;

async function isBcryptHash(str) {
  // bcrypt hashes always start with $2b$ or $2a$ and are 60 chars long
  return /^\$2[ab]\$\d{2}\$/.test(str) && str.length === 60;
}

async function migratePlainTextPasswords() {
  const client = await pool.connect();

  try {
    const { rows: users } = await client.query(
      'SELECT id, email, password_hash FROM users'
    );

    console.log(`Found ${users.length} users. Checking for plain-text passwords...\n`);

    let migrated = 0;
    let skipped = 0;

    for (const user of users) {
      const alreadyHashed = await isBcryptHash(user.password_hash);

      if (alreadyHashed) {
        console.log(`✓ SKIP   ${user.email} — already hashed`);
        skipped++;
        continue;
      }

      // Plain text detected — hash it
      console.log(`⚠ MIGRATE ${user.email} — plain text detected, hashing...`);
      const newHash = await bcrypt.hash(user.password_hash, SALT_ROUNDS);

      await client.query(
        'UPDATE users SET password_hash = $1 WHERE id = $2',
        [newHash, user.id]
      );

      console.log(`  ✓ Done   ${user.email}`);
      migrated++;
    }

    console.log(`\n=== Migration complete ===`);
    console.log(`  Migrated : ${migrated}`);
    console.log(`  Skipped  : ${skipped} (already hashed)`);
    console.log(`  Total    : ${users.length}`);

  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migratePlainTextPasswords();