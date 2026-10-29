'use strict';
const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const pool = require('../db');

test('project due-date API changes only end_date and rejects schedule conflicts', async () => {
  const client = await pool.connect();
  const schema = `project_due_date_${randomUUID().replaceAll('-', '')}`;
  const ownerId = randomUUID();
  const memberId = randomUUID();
  const projectId = randomUUID();
  const taskId = randomUUID();
  let server;
  try {
    await client.query('BEGIN');
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET LOCAL search_path TO "${schema}", public`);
    await client.query(`CREATE TABLE users (id UUID PRIMARY KEY, email TEXT, role TEXT, full_name TEXT,
      is_active BOOLEAN DEFAULT TRUE, email_verified BOOLEAN DEFAULT TRUE);
      CREATE TABLE projects (id UUID PRIMARY KEY, code TEXT UNIQUE, name TEXT, location TEXT, status TEXT,
        owner_id UUID, start_date DATE, end_date DATE, updated_at TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE project_members (project_id TEXT, user_id UUID, user_name TEXT);
      CREATE TABLE tasks (id UUID PRIMARY KEY, task_name TEXT, project_id UUID, assignee_id UUID, due_date DATE);`);
    await client.query(`INSERT INTO users(id,email,role,full_name) VALUES
      ($1,'owner@example.test','Admin','Owner'),($2,'member@example.test','Site Engineer','Member')`, [ownerId, memberId]);
    await client.query(`INSERT INTO projects(id,code,name,status,owner_id,start_date,end_date)
      VALUES ($1,'DUE-DATE-TEST','Due Date Test','Ongoing',$2,'2026-10-26','2026-10-30')`, [projectId, ownerId]);
    await client.query('INSERT INTO project_members(project_id,user_id) VALUES ($1,$2)', ['DUE-DATE-TEST', memberId]);
    await client.query(`INSERT INTO tasks(id,task_name,project_id,due_date)
      VALUES ($1,'Late task',$2,'2026-11-15')`, [taskId, projectId]);

    const query = (statement, values) => client.query(statement, values);
    mock.method(pool, 'query', query);
    mock.method(pool, 'connect', async () => ({
      query: (statement, values) => client.query(statement === 'BEGIN' ? 'SAVEPOINT due_date_request' :
        statement === 'COMMIT' ? 'RELEASE SAVEPOINT due_date_request' :
          statement === 'ROLLBACK' ? 'ROLLBACK TO SAVEPOINT due_date_request' : statement, values),
      release() {},
    }));
    mock.method(console, 'log', () => {});
    mock.method(console, 'error', () => {});
    const app = express();
    app.use(express.json());
    app.use('/projects', require('../routes/project'));
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
    const root = `http://127.0.0.1:${server.address().port}`;
    const tokenFor = id => jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: '5m' });
    async function request(code, userId, body) {
      const response = await fetch(`${root}/projects/${code}/due-date`, { method: 'PATCH',
        headers: { Authorization: `Bearer ${tokenFor(userId)}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body) });
      const text = await response.text();
      let parsed;
      try { parsed = JSON.parse(text); } catch (_) { parsed = { raw: text }; }
      return { response, body: parsed };
    }

    const noAuthResponse = await fetch(`${root}/projects/DUE-DATE-TEST/due-date`, { method: 'PATCH',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dueDate: '2026-11-30', reason: 'Extension' }) });
    assert.equal(noAuthResponse.status, 401);

    const conflict = await request('DUE-DATE-TEST', ownerId, { dueDate: '2026-11-10', reason: 'Earlier deadline' });
    assert.equal(conflict.response.status, 409, JSON.stringify(conflict.body));
    assert.equal(conflict.body.data.affectedTasks[0].id, taskId);
    assert.equal((await client.query('SELECT end_date::text,start_date::text FROM projects WHERE id=$1', [projectId])).rows[0].end_date, '2026-10-30');

    await client.query('UPDATE tasks SET due_date=$1 WHERE id=$2', ['2026-10-29', taskId]);
    const invalid = await request('DUE-DATE-TEST', ownerId, { dueDate: '2026-02-30', reason: 'Invalid' });
    assert.equal(invalid.response.status, 400);
    const beforeStart = await request('DUE-DATE-TEST', ownerId, { dueDate: '2026-10-25', reason: 'Invalid order' });
    assert.equal(beforeStart.response.status, 400);
    const missingReason = await request('DUE-DATE-TEST', ownerId, { dueDate: '2026-11-30' });
    assert.equal(missingReason.response.status, 400);
    const unauthorized = await request('DUE-DATE-TEST', memberId, { dueDate: '2026-11-30', reason: 'Extension' });
    assert.equal(unauthorized.response.status, 403);
    const unknown = await request('MISSING-PROJECT', ownerId, { dueDate: '2026-11-30', reason: 'Extension' });
    assert.equal(unknown.response.status, 404);

    const changed = await request('DUE-DATE-TEST', ownerId, { dueDate: '2026-11-30', reason: 'Extension' });
    assert.equal(changed.response.status, 200, JSON.stringify(changed.body));
    assert.deepEqual(changed.body.data, { code: 'DUE-DATE-TEST', startDate: '2026-10-26', dueDate: '2026-11-30' });
    const persisted = (await client.query('SELECT end_date::text,start_date::text FROM projects WHERE id=$1', [projectId])).rows[0];
    assert.equal(persisted.end_date, '2026-11-30');
    assert.equal(persisted.start_date, '2026-10-26');
    assert.equal((await client.query('SELECT due_date::text FROM tasks WHERE id=$1', [taskId])).rows[0].due_date, '2026-10-29');
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await client.query('ROLLBACK');
    client.release();
    await pool.end();
  }
});
