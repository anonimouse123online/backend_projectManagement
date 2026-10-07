const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const pool = require('../db');

test('work-status migration extends lifecycle checks without altering historical data or progress constraints', async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const schema = `status_migration_test_${randomUUID().replaceAll('-', '')}`;
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET LOCAL search_path TO "${schema}", public`);
    await client.query(`CREATE TABLE tasks (id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      status VARCHAR(50) DEFAULT 'Pending', progress_pct INTEGER NOT NULL DEFAULT 0 CHECK (progress_pct BETWEEN 0 AND 100),
      subtasks JSONB NOT NULL DEFAULT '[]'::jsonb, updated_at TIMESTAMPTZ DEFAULT NOW(),
      CONSTRAINT tasks_status_check CHECK (status IN ('Pending','In Progress','Completed','Cancelled','Verified','Closed')))`);
    for (const status of ['Pending', 'In Progress', 'Completed', 'Cancelled', 'Verified', 'Closed', null]) {
      await client.query('INSERT INTO tasks (status,progress_pct,subtasks) VALUES ($1,35,$2)',
        [status, JSON.stringify([{ id: 'a', title: 'Existing work', completed: false }])]);
    }
    const original = (await client.query('SELECT * FROM tasks ORDER BY id')).rows;
    const sql = fs.readFileSync(path.join(__dirname, '../migrations/task_work_status.sql'), 'utf8');
    await client.query(sql);
    const definition = (await client.query("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='tasks'::regclass AND conname='tasks_status_check'")).rows[0].definition;
    await client.query(sql);
    assert.equal((await client.query("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='tasks'::regclass AND conname='tasks_status_check'")).rows[0].definition, definition);
    assert.deepEqual((await client.query('SELECT * FROM tasks ORDER BY id')).rows, original);
    for (const status of ['pending', 'ongoing', 'Completed', 'Cancelled', 'Verified', 'Closed']) {
      assert.equal((await client.query('INSERT INTO tasks (status) VALUES ($1) RETURNING status', [status])).rows[0].status, status);
    }
    assert.equal((await client.query('INSERT INTO tasks DEFAULT VALUES RETURNING status')).rows[0].status, 'pending');
    for (const [statement, values] of [
      ['INSERT INTO tasks (status) VALUES ($1)', ['working123']],
      ['INSERT INTO tasks (progress_pct) VALUES ($1)', [101]],
    ]) {
      await client.query('SAVEPOINT invalid_write');
      await assert.rejects(client.query(statement, values), { code: '23514' });
      await client.query('ROLLBACK TO SAVEPOINT invalid_write');
    }
    await client.query('DROP TABLE tasks');
    await client.query("CREATE TABLE tasks (status VARCHAR(50) DEFAULT 'Pending', progress_pct INTEGER)");
    await client.query("INSERT INTO tasks VALUES ('Historic custom state',45)");
    await client.query(sql);
    assert.deepEqual((await client.query('SELECT * FROM tasks')).rows, [{ status: 'Historic custom state', progress_pct: 45 }]);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});

test.after(() => pool.end());
