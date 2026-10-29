'use strict';
const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const pool = require('../db');

test('task target-date API preserves date-only values and validates edits against project and dependency constraints', async () => {
  const client = await pool.connect();
  const schema = `task_schedule_api_${randomUUID().replaceAll('-', '')}`;
  const ownerId = randomUUID();
  const projectId = randomUUID();
  const taskId = randomUUID();
  const predecessorId = randomUUID();
  let server;
  try {
    await client.query('BEGIN');
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET LOCAL search_path TO "${schema}", public`);
    await client.query(`CREATE TABLE users (id UUID PRIMARY KEY, email TEXT, role TEXT, full_name TEXT,
      is_active BOOLEAN DEFAULT TRUE, email_verified BOOLEAN DEFAULT TRUE);
      CREATE TABLE projects (id UUID PRIMARY KEY, code TEXT UNIQUE, name TEXT, location TEXT, status TEXT,
        owner_id UUID, start_date DATE, end_date DATE);
      CREATE TABLE project_members (project_id TEXT, user_id UUID, user_name TEXT);
      CREATE TABLE tasks (id UUID PRIMARY KEY, task_name TEXT, phase TEXT, project_id UUID, assignee_id UUID,
        due_date DATE, start_date DATE, estimated_duration_days INTEGER, priority TEXT, status TEXT,
        materials_required TEXT, site_instructions TEXT, subtasks JSONB DEFAULT '[]'::jsonb,
        progress_pct INTEGER DEFAULT 0, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE task_dependencies (task_id UUID NOT NULL, predecessor_task_id UUID NOT NULL,
        PRIMARY KEY(task_id, predecessor_task_id));
      CREATE TABLE project_holidays (project_id UUID NOT NULL, holiday_date DATE NOT NULL, name TEXT,
        PRIMARY KEY(project_id, holiday_date));
      CREATE TABLE task_phases (task_id UUID NOT NULL, phase TEXT NOT NULL);
      CREATE TABLE resources (id UUID, task_id UUID, project TEXT, name TEXT, category TEXT, quantity INTEGER,
        unit TEXT, supplier TEXT, unit_price NUMERIC, task_name TEXT);
      CREATE FUNCTION normalize_task_phase(input TEXT) RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$ SELECT input $$;`);
    await client.query("INSERT INTO users(id,email,role,full_name) VALUES ($1,'owner@example.test','Admin','Owner')", [ownerId]);
    await client.query(`INSERT INTO projects(id,code,name,status,owner_id,start_date,end_date)
      VALUES ($1,'TASK-DATE-TEST','Date Test','Ongoing',$2,'2020-01-01','2100-12-31')`, [projectId, ownerId]);
    await client.query(`INSERT INTO tasks(id,task_name,phase,project_id,assignee_id,due_date,start_date,priority,status)
      VALUES ($1,'Legacy task','Structural',$2,$3,'2020-01-15',NULL,'Medium','Pending'),
             ($4,'Foundation','Structural',$2,$3,'2099-12-28','2099-12-21','Medium','Pending')`,
    [taskId, projectId, ownerId, predecessorId]);

    const query = (statement, values) => client.query(statement, values);
    mock.method(pool, 'query', query);
    mock.method(pool, 'connect', async () => ({
      query: (statement, values) => query(statement === 'BEGIN' ? 'SAVEPOINT task_date_request' :
        statement === 'COMMIT' ? 'RELEASE SAVEPOINT task_date_request' :
        statement === 'ROLLBACK' ? 'ROLLBACK TO SAVEPOINT task_date_request' : statement, values),
      release() {},
    }));
    mock.method(console, 'log', () => {});
    mock.method(console, 'error', () => {});
    const app = express();
    app.use(express.json());
    app.use('/tasks', require('../routes/task'));
    app.use((error, _req, res, _next) => res.status(error.status || 500).json({ message: error.message }));
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
    const root = `http://127.0.0.1:${server.address().port}`;
    const token = jwt.sign({ id: ownerId }, process.env.JWT_SECRET, { expiresIn: '5m' });
    async function request(url, method = 'GET', body) {
      const response = await fetch(root + url, { method, headers: { Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { response, body: await response.json() };
    }

    const legacy = await request(`/tasks/${taskId}`);
    assert.equal(legacy.response.status, 200);
    assert.equal(legacy.body.data.start_date, null);
    assert.equal(legacy.body.data.due_date, '2020-01-15');

    const invalidOrder = await request(`/tasks/${taskId}`, 'PATCH', { startDate: '2099-12-31', dueDate: '2099-12-30' });
    assert.equal(invalidOrder.response.status, 400);
    const invalidBoundary = await request(`/tasks/${taskId}`, 'PATCH', { dueDate: '2101-01-01' });
    assert.equal(invalidBoundary.response.status, 400);
    const predecessorConflict = await request(`/tasks/${taskId}`, 'PATCH', {
      startDate: '2099-12-28', dueDate: '2099-12-31', predecessorTaskIds: [predecessorId],
    });
    assert.equal(predecessorConflict.response.status, 400);

    const changed = await request(`/tasks/${taskId}`, 'PATCH', { startDate: '2099-12-30', dueDate: '2099-12-31' });
    assert.equal(changed.response.status, 200, JSON.stringify(changed.body));
    assert.equal(changed.body.data.start_date, '2099-12-30');
    assert.equal(changed.body.data.due_date, '2099-12-31');
    assert.equal(changed.body.data.schedule_validation.status, 'INSUFFICIENT_DATA');
    const reopened = await request(`/tasks/${taskId}`);
    assert.equal(reopened.body.data.due_date, '2099-12-31');
    const list = await request('/tasks?project_id=TASK-DATE-TEST');
    assert.equal(list.response.status, 200);
    assert.equal(list.body.data.find(task => task.id === taskId).due_date, '2099-12-31');
    assert.equal((await client.query('SELECT due_date::text,start_date::text FROM tasks WHERE id=$1', [taskId])).rows[0].due_date, '2099-12-31');
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await client.query('ROLLBACK');
    client.release();
    await pool.end();
  }
});
