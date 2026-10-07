const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const jwt = require('jsonwebtoken');
const { randomUUID } = require('node:crypto');
const express = require('express');
const pool = require('../db');

test('task and subtask work statuses persist independently of progress and preserve completion/access rules', async () => {
  const client = await pool.connect();
  const schema = `task_work_status_test_${randomUUID().replaceAll('-', '')}`;
  let server;
  try {
    await client.query('BEGIN');
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET LOCAL search_path TO "${schema}", public`);
    await client.query(`CREATE TABLE users (id UUID PRIMARY KEY, full_name TEXT, email TEXT, role TEXT);
      CREATE TABLE projects (id UUID PRIMARY KEY, code TEXT, name TEXT, owner_id UUID, location TEXT,
        status TEXT, progress INTEGER DEFAULT 35, progress_pct INTEGER DEFAULT 35, updated_at TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE project_members (project_id TEXT, user_id UUID);
      CREATE TABLE tasks (id UUID PRIMARY KEY, task_name TEXT, phase TEXT, project_id UUID, assignee_id UUID,
        due_date DATE, priority TEXT, materials_required TEXT, site_instructions TEXT,
        status VARCHAR(50) NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending','In Progress','Completed','Cancelled')),
        progress_pct INTEGER NOT NULL DEFAULT 0 CHECK (progress_pct BETWEEN 0 AND 100),
        subtasks JSONB NOT NULL DEFAULT '[]'::jsonb, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE task_phases (task_id UUID, phase TEXT);`);
    await client.query(`CREATE FUNCTION normalize_task_phase(value TEXT) RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$ SELECT value $$`);
    await client.query(fs.readFileSync(path.join(__dirname, '../migrations/task_work_status.sql'), 'utf8'));
    const owner = randomUUID(), engineer = randomUUID(), outsider = randomUUID(), project = randomUUID(), task = randomUUID();
    for (const [id, name] of [[owner, 'Owner'], [engineer, 'Engineer'], [outsider, 'Outsider']]) {
      await client.query('INSERT INTO users VALUES ($1,$2,$3,$4)', [id, name, `${name}@example.test`, name === 'Owner' ? 'Project Manager' : 'Site Engineer']);
    }
    const colleague = randomUUID(), manager = randomUUID(), admin = randomUUID();
    for (const [id, name, role] of [[colleague, 'Colleague', 'Site Engineer'], [manager, 'Manager', 'Project Manager'], [admin, 'Admin', 'admin']]) {
      await client.query('INSERT INTO users VALUES ($1,$2,$3,$4)', [id, name, `${name}@example.test`, role]);
    }
    await client.query("INSERT INTO projects (id,code,name,owner_id,status) VALUES ($1,'WORK-TEST','Work test',$2,'Ongoing')", [project, owner]);
    for (const id of [engineer, colleague, manager, admin]) await client.query("INSERT INTO project_members VALUES ('WORK-TEST',$1)", [id]);
    const originalSubtasks = [
      { id: 'a', title: 'Excavation', completed: false, progress: 60, detail: 'preserve me' },
      { id: 'b', title: 'Rebar preparation', completed: false },
    ];
    await client.query(`INSERT INTO tasks (id,task_name,phase,project_id,assignee_id,status,progress_pct,subtasks)
      VALUES ($1,'Foundation','Structural',$2,$3,'Pending',45,$4)`, [task, project, engineer, JSON.stringify(originalSubtasks)]);
    mock.method(pool, 'query', (...args) => client.query(...args));
    // Controller transactions run as savepoints inside the disposable outer transaction.
    mock.method(pool, 'connect', async () => ({
      query(sql, values) {
        if (sql === 'BEGIN') return client.query('SAVEPOINT work_status_call');
        if (sql === 'COMMIT') return client.query('RELEASE SAVEPOINT work_status_call');
        if (sql === 'ROLLBACK') return client.query('ROLLBACK TO SAVEPOINT work_status_call');
        return client.query(sql, values);
      },
      release() {},
    }));
    mock.method(console, 'log', () => {});
    const app = express();
    app.use(express.json());
    app.use(require('../middlewares/authMiddleware').verifyToken);
    app.use('/tasks', require('../routes/task'));
    app.use('/dashboard', require('../routes/dashboard'));
    server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
    const request = async (path, method = 'GET', body, user = engineer) => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
        method, headers: { 'Content-Type': 'application/json', ...(user ? { Authorization: `Bearer ${jwt.sign({ id: user }, process.env.JWT_SECRET)}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    };
    const stored = async () => (await client.query('SELECT * FROM tasks WHERE id=$1', [task])).rows[0];

    for (const [input, saved] of [['ongoing', 'ongoing'], ['pending', 'pending']]) {
      const result = await request(`/tasks/${task}/status`, 'PATCH', { status: input });
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(result.body.data.status, saved);
      assert.equal(result.body.data.progress, 45);
      assert.equal((await stored()).progress_pct, 45);
      assert.deepEqual((await stored()).subtasks, originalSubtasks);
      const refreshed = await request(`/tasks/${task}`);
      assert.equal(refreshed.body.data.status, saved);
      assert.equal(refreshed.body.data.progress, 45);
    }
    // A project-member engineer still cannot update another engineer's task.
    const beforeDenied = await stored();
    for (const [url, body] of [
      [`/tasks/${task}/status`, { status: 'ongoing' }],
      [`/tasks/${task}/subtasks`, { subtask_id: 'a', status: 'ongoing' }],
      [`/tasks/${task}/subtasks`, { subtasks: originalSubtasks }],
      [`/tasks/${task}/complete`, {}],
    ]) assert.equal((await request(url, 'PATCH', body, colleague)).status, 403);
    assert.deepEqual(await stored(), beforeDenied);
    for (const user of [manager, admin, owner]) {
      const response = await request(`/tasks/${task}/status`, 'PATCH', { status: 'Pending' }, user);
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.equal(response.body.data.progress, 45);
    }
    // Task status changes do not change progress, and progress-only updates do not replace status.
    let independent = await request(`/tasks/${task}/status`, 'PATCH', { progress: 35 });
    assert.equal(independent.status, 200, JSON.stringify(independent.body));
    assert.equal(independent.body.data.status, 'pending');
    // Explicit progress changes retain the existing project-sync workflow;
    // this fixture has no completed subtasks, so reactivate it for work-state tests.
    await client.query("UPDATE projects SET status='Ongoing' WHERE id=$1", [project]);
    independent = await request(`/tasks/${task}/status`, 'PATCH', { status: 'ONGOING' });
    assert.equal(independent.status, 200, JSON.stringify(independent.body));
    assert.equal(independent.body.data.status, 'ongoing');
    assert.equal(independent.body.data.progress, 35);
    assert.equal(independent.body.data.progress_pct, 35);
    independent = await request(`/tasks/${task}/status`, 'PATCH', { status: 'pending', progress_pct: 45 });
    assert.equal(independent.body.data.progress, 45);
    assert.equal(independent.body.data.status, 'pending');
    await client.query("UPDATE projects SET status='Ongoing' WHERE id=$1", [project]);
    await client.query("UPDATE tasks SET status='In Progress' WHERE id=$1", [task]);
    for (const url of ['/tasks?status=ongoing', `/tasks?project_id=${project}&assignee_id=${engineer}`]) {
      const response = await request(url);
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.equal(response.body.data.length, 1);
      assert.equal(response.body.data[0].status, 'ongoing');
      assert.equal(response.body.data[0].progress, 45);
      assert.equal(response.body.data[0].subtasks[0].progress, 60);
    }
    let gauge = await request('/dashboard/gauge');
    assert.equal(gauge.status, 200, JSON.stringify(gauge.body));
    assert.equal(gauge.body.data[0].v, '1');
    await client.query('UPDATE tasks SET progress_pct=0 WHERE id=$1', [task]);
    assert.equal((await request(`/tasks/${task}/status`, 'PATCH', { status: 'ongoing' })).body.data.progress, 0);
    await client.query('UPDATE tasks SET progress_pct=45 WHERE id=$1', [task]);

    for (const input of ['ongoing', 'pending']) {
      const before = await stored();
      const result = await request(`/tasks/${task}/subtasks`, 'PATCH', { subtask_id: 'a', status: input });
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(result.body.data.subtasks[0].status, input);
      assert.equal(result.body.data.subtasks[0].progress, 60);
      assert.equal(result.body.data.subtasks[0].completed, false);
      assert.equal(result.body.data.subtasks[0].detail, 'preserve me');
      const after = await stored();
      assert.equal(after.status, before.status);
      assert.equal(after.progress_pct, before.progress_pct);
      assert.deepEqual(after.subtasks[1], before.subtasks[1]);
      const refreshed = await request(`/tasks/${task}`);
      assert.equal(refreshed.body.data.subtasks[0].status, input);
      assert.equal(refreshed.body.data.subtasks[0].progress, 60);
    }
    const beforeChildProgress = await stored();
    const childProgress = await request(`/tasks/${task}/subtasks`, 'PATCH', { subtask_id: 'a', progress: 70 });
    assert.equal(childProgress.status, 200, JSON.stringify(childProgress.body));
    assert.equal(childProgress.body.data.subtasks[0].status, 'pending');
    assert.equal(childProgress.body.data.subtasks[0].progress, 70);
    assert.equal(childProgress.body.data.progress, beforeChildProgress.progress_pct);
    await request(`/tasks/${task}/subtasks`, 'PATCH', { subtask_id: 'a', progress: 60 });
    const beforeArray = await stored();
    const arrayStatus = await request(`/tasks/${task}/subtasks`, 'PATCH', {
      subtasks: beforeArray.subtasks.map(item => item.id === 'a' ? { ...item, status: 'ongoing' } : item),
    });
    assert.equal(arrayStatus.status, 200, JSON.stringify(arrayStatus.body));
    assert.equal(arrayStatus.body.data.progress_pct, beforeArray.progress_pct);
    assert.equal(arrayStatus.body.data.status, beforeArray.status);
    await request(`/tasks/${task}/subtasks`, 'PATCH', { subtask_id: 'a', status: 'ongoing' });
    await request(`/tasks/${task}/subtasks`, 'PATCH', { subtask_id: 'b', status: 'pending' });
    let result = await request(`/tasks/${task}`);
    assert.deepEqual(result.body.data.subtasks.map(item => item.status), ['ongoing', 'pending']);
    assert.deepEqual(result.body.data.subtasks.map(item => item.progress), [60, 0]);
    const projectPct = (await client.query('SELECT progress_pct FROM projects WHERE id=$1', [project])).rows[0].progress_pct;
    await request(`/tasks/${task}/status`, 'PATCH', { status: 'pending' });
    assert.equal((await client.query('SELECT progress_pct FROM projects WHERE id=$1', [project])).rows[0].progress_pct, projectPct);

    for (const path of [`/tasks/${task}/status`, `/tasks/${task}/subtasks`]) {
      const body = path.endsWith('/status') ? { status: 'ongoing' } : { subtask_id: 'a', status: 'ongoing' };
      assert.equal((await request(path, 'PATCH', body, null)).status, 401);
      assert.equal((await request(path, 'PATCH', body, outsider)).status, 404);
    }
    assert.equal((await request(`/tasks/${task}/subtasks`, 'PATCH', { subtasks: [] }, outsider)).status, 404);
    assert.equal((await request(`/tasks/${task}/status`, 'PATCH', { status: 'invalid' })).status, 400);
    assert.equal((await request(`/tasks/${task}/status`, 'PATCH', { status: [] })).status, 400);
    assert.equal((await request(`/tasks/${task}/subtasks`, 'PATCH', { subtask_id: 'a', status: 'completed' })).status, 400);
    assert.equal((await request(`/tasks/${task}/subtasks`, 'PATCH', { subtask_id: 'missing', status: 'pending' })).status, 404);
    assert.equal((await request(`/tasks/${task}/subtasks`, 'PATCH', {})).status, 400);
    assert.equal((await request(`/tasks/${task}/status`, 'PATCH', { progress: 101 })).status, 400);
    await client.query("UPDATE projects SET status='Planning' WHERE id=$1", [project]);
    assert.equal((await request(`/tasks/${task}/status`, 'PATCH', { status: 'ongoing' })).status, 400);
    assert.equal((await request(`/tasks/${task}/subtasks`, 'PATCH', { subtask_id: 'a', status: 'ongoing' })).status, 400);
    await client.query("UPDATE projects SET status='Ongoing' WHERE id=$1", [project]);

    // Existing checkbox updates still calculate parent progress and complete subtasks.
    let subtasks = (await stored()).subtasks.map(item => ({ ...item, status: null, progress: null, completed: item.id === 'b' }));
    result = await request(`/tasks/${task}/subtasks`, 'PATCH', { subtasks });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.data.progress_pct, 50);
    assert.equal(result.body.data.subtasks[0].status, 'ongoing');
    assert.equal(result.body.data.subtasks[0].progress, 60);
    assert.equal(result.body.data.subtasks[1].progress, 100);
    assert.equal((await request(`/tasks/${task}/subtasks`, 'PATCH', { subtask_id: 'b', status: 'pending' })).status, 409);
    subtasks = (await stored()).subtasks.map(item => ({ ...item, completed: false }));
    assert.equal((await request(`/tasks/${task}/subtasks`, 'PATCH', { subtasks })).body.data.progress_pct, 0);

    result = await request(`/tasks/${task}/complete`, 'PATCH', {});
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.data.status, 'completed');
    assert.equal(result.body.data.progress_pct, 100);
    assert.ok((await stored()).subtasks.every(item => item.completed));
    assert.ok(result.body.data.subtasks.every(item => item.status === 'completed' && item.progress === 100));
    assert.ok((await stored()).subtasks.every(item => item.progress === 100));
    assert.equal((await request(`/tasks/${task}/status`, 'PATCH', { status: 'pending' })).status, 409);
    assert.equal((await request(`/tasks/${task}/subtasks`, 'PATCH', { subtask_id: 'a', status: 'pending' })).status, 409);
    await client.query("UPDATE tasks SET status='Cancelled' WHERE id=$1", [task]);
    assert.equal((await request(`/tasks/${task}/status`, 'PATCH', { status: 'ongoing' })).status, 409);
    assert.equal((await request(`/tasks/${task}`)).body.data.status, 'cancelled');
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    mock.restoreAll();
    await client.query('ROLLBACK');
    client.release();
    await pool.end();
  }
});
