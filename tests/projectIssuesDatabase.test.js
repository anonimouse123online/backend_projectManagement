const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const pool = require('../db');
const service = require('../services/projectIssueService');

test('PostgreSQL issue migration, aggregate counts, authorized HTTP routes, notifications and socket updates', async () => {
  // All fixtures and DDL live in a temporary schema inside one rolled-back transaction.
  const client = await pool.connect();
  const schema = `project_issues_test_${randomUUID().replaceAll('-', '')}`;
  let server;
  try {
    await client.query('BEGIN');
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET LOCAL search_path TO "${schema}", public`);
    await client.query(`CREATE TABLE users (id UUID PRIMARY KEY, full_name TEXT, email TEXT, role TEXT, is_active BOOLEAN DEFAULT TRUE);
      CREATE TABLE projects (id UUID PRIMARY KEY, code VARCHAR(50) UNIQUE NOT NULL, name TEXT,
        owner_id UUID REFERENCES users(id), location TEXT, client TEXT, budget NUMERIC, phase TEXT,
        scope TEXT, status TEXT, progress INTEGER, progress_pct INTEGER, start_date DATE, end_date DATE,
        created_at TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE project_members (project_id VARCHAR(50), user_id UUID REFERENCES users(id), user_name TEXT, role TEXT);
      CREATE TABLE tasks (id UUID PRIMARY KEY, project_id UUID REFERENCES projects(id));
      CREATE TABLE resources (quantity INTEGER, unit_price NUMERIC, project TEXT, task_id UUID);
      CREATE TABLE project_issues (id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        project_code VARCHAR(50) REFERENCES projects(code) ON DELETE CASCADE, title VARCHAR(255) NOT NULL,
        category VARCHAR(100) NOT NULL, priority VARCHAR(20) NOT NULL DEFAULT 'Medium', location VARCHAR(255),
        description TEXT NOT NULL, status VARCHAR(50) NOT NULL DEFAULT 'Open',
        reported_by UUID REFERENCES users(id) ON DELETE SET NULL, assigned_to UUID REFERENCES users(id) ON DELETE SET NULL,
        resolution_notes TEXT, resolved_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE notifications (id SERIAL PRIMARY KEY, title TEXT, message TEXT, audience TEXT, project_id VARCHAR(50),
        target_user_id UUID REFERENCES users(id), created_by UUID REFERENCES users(id), created_at TIMESTAMPTZ DEFAULT NOW());`);
    const users = {
      owner: { id: randomUUID(), email: 'owner@example.test', role: 'Project Manager' },
      engineer: { id: randomUUID(), email: 'engineer@example.test', role: 'Site Engineer' },
      outsider: { id: randomUUID(), email: 'outsider@example.test', role: 'Site Engineer' },
      manager: { id: randomUUID(), email: 'manager@example.test', role: 'Project Manager' },
      supervisor: { id: randomUUID(), email: 'supervisor@example.test', role: 'Supervisor' },
      admin: { id: randomUUID(), email: 'admin@example.test', role: 'Admin' },
      viewer: { id: randomUUID(), email: 'viewer@example.test', role: 'Member' },
    };
    for (const [name, user] of Object.entries(users)) {
      await client.query('INSERT INTO users (id,full_name,email,role) VALUES ($1,$2,$3,$4)', [user.id, name, user.email, user.role]);
    }
    const first = { id: randomUUID(), code: 'PRJ-TEST-001' };
    const second = { id: randomUUID(), code: 'PRJ-TEST-002' };
    const empty = { id: randomUUID(), code: 'PRJ-TEST-003' };
    for (const project of [first, second, empty]) {
      await client.query("INSERT INTO projects (id,code,name,owner_id,status) VALUES ($1,$2,'Test Project',$3,'Completed')",
        [project.id, project.code, project === second ? users.outsider.id : users.owner.id]);
    }
    for (const user of [users.engineer, users.manager, users.supervisor, users.viewer]) {
      await client.query('INSERT INTO project_members VALUES ($1,$2,$3,$4)', [first.code, user.id, user.email, user.role]);
    }
    // Duplicate membership must never multiply counts.
    await client.query('INSERT INTO project_members VALUES ($1,$2,$3,$4)', [first.code, users.engineer.id, users.engineer.email, 'Member']);
    for (const [status, priority] of [['Open', 'High'], ['In Progress', 'Medium'], ['Resolved', 'Low']]) {
      await client.query(`INSERT INTO project_issues (project_code,title,category,priority,description,status,reported_by)
        VALUES ($1,$2,'Safety Hazard',$3,'Legacy description',$2,$4)`, [first.code, status, priority, users.engineer.id]);
    }
    const sql = fs.readFileSync(path.join(__dirname, '../migrations/project_issue_alerts.sql'), 'utf8');
    await client.query(sql);
    await client.query(sql);
    const migrated = (await client.query('SELECT * FROM project_issues ORDER BY severity')).rows;
    assert.equal(migrated.length, 3);
    assert.ok(migrated.every(issue => issue.project_id === first.id));
    assert.deepEqual(new Set(migrated.map(issue => issue.status)), new Set(['open', 'in_progress', 'resolved']));
    assert.ok(migrated.find(issue => issue.status === 'resolved').resolved_at);
    assert.deepEqual(await service.getCounts(first.id, client), { active_issue_count: 2, has_active_issues: true });
    const legacyInsert = (await client.query(`INSERT INTO project_issues
      (project_code,title,category,priority,description,status)
      VALUES ($1,'Legacy write','equipment','Critical','Legacy API write','Open') RETURNING *`, [empty.code])).rows[0];
    assert.equal(legacyInsert.project_id, empty.id);
    assert.equal(legacyInsert.severity, 'critical');
    assert.equal(legacyInsert.status, 'open');
    const legacyUpdate = (await client.query("UPDATE project_issues SET priority='Low',status='Resolved' WHERE id=$1 RETURNING *", [legacyInsert.id])).rows[0];
    assert.equal(legacyUpdate.severity, 'low');
    assert.ok(legacyUpdate.resolved_at);
    assert.equal((await service.getCounts(empty.id, client)).active_issue_count, 0);
    const idInsert = (await client.query(`INSERT INTO project_issues
      (project_id,title,category,severity,description,status)
      VALUES ($1,'ID-only write','other','high','New API write','in_progress') RETURNING *`, [empty.id])).rows[0];
    assert.equal(idInsert.project_code, empty.code);
    assert.equal(idInsert.priority, 'High');
    await client.query('DELETE FROM project_issues WHERE id IN ($1,$2)', [legacyInsert.id, idInsert.id]);

    // New code and legacy code share constraints, project associations and timestamps.
    await client.query('SAVEPOINT constraint_test');
    await assert.rejects(client.query("UPDATE project_issues SET status='invalid' WHERE id=$1", [migrated[0].id]), { code: '23514' });
    await client.query('ROLLBACK TO SAVEPOINT constraint_test');
    await assert.rejects(client.query("UPDATE project_issues SET severity='urgent' WHERE id=$1", [migrated[0].id]), { code: '23514' });
    await client.query('ROLLBACK TO SAVEPOINT constraint_test');
    await assert.rejects(client.query(`INSERT INTO project_issues (project_id,project_code,title,category,description)
      VALUES ($1,$2,'Mismatched project','other','Invalid association')`, [second.id, first.code]), { code: '23503' });
    await client.query('ROLLBACK TO SAVEPOINT constraint_test');

    const resolutionSql = fs.readFileSync(path.join(__dirname, '../migrations/issue_resolutions.sql'), 'utf8');
    await client.query(resolutionSql);
    await client.query(resolutionSql);
    await client.query('SAVEPOINT resolution_constraints');
    for (const steps of [[], [' '], ['Valid', null], ['Valid', 42], 'Inspected', {}]) {
      await assert.rejects(client.query(`INSERT INTO issue_resolutions
        (issue_id,resolution_summary,resolution_steps,final_remarks,resolved_by)
        VALUES ($1,'Summary',$2::jsonb,'Remarks',$3)`, [migrated[0].id, JSON.stringify(steps), users.admin.id]), { code: '23514' });
      await client.query('ROLLBACK TO SAVEPOINT resolution_constraints');
    }

    let failNotification = false;
    let failResolution = false;
    let failStatusUpdate = false;
    const query = async (sql, values) => {
      if (failNotification && /INSERT INTO notifications/.test(sql)) { failNotification = false; throw new Error('Injected notification failure'); }
      if (failResolution && /INSERT INTO issue_resolutions/.test(sql)) { failResolution = false; throw new Error('Injected resolution failure'); }
      if (failStatusUpdate && /UPDATE project_issues SET/.test(sql)) { failStatusUpdate = false; throw new Error('Injected status failure'); }
      return client.query(sql, values);
    };
    mock.method(pool, 'query', query);
    mock.method(pool, 'connect', async () => ({
      query: (sql, values) => query(sql === 'BEGIN' ? 'SAVEPOINT issue_request' :
        sql === 'COMMIT' ? 'RELEASE SAVEPOINT issue_request' :
        sql === 'ROLLBACK' ? 'ROLLBACK TO SAVEPOINT issue_request' : sql, values), release() {},
    }));
    mock.method(console, 'error', () => {});
    const emissions = [];
    const app = express();
    app.use(express.json());
    app.use(require('../middlewares/authMiddleware').verifyToken);
    app.set('io', { of(name) { assert.equal(name, '/project-issues'); return {
      to(rooms) { return { emit(event, payload) { emissions.push({ rooms, event, payload }); } }; },
    }; } });
    app.use('/projects', require('../routes/project'));
    app.use('/', require('../routes/issuesRoutes'));
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const root = `http://127.0.0.1:${server.address().port}`;
    async function request(url, user = users.engineer, method = 'GET', body) {
      const response = await fetch(root + url, { method, headers: {
        ...(user ? { Authorization: `Bearer ${jwt.sign(user, process.env.JWT_SECRET)}` } : {}),
        'Content-Type': 'application/json',
      }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, body: await response.json() };
    }
    const base = `/projects/${first.id}/issues`;
    assert.equal((await request(base, null)).status, 401);
    const invalidToken = await fetch(root + base, { headers: {
      Authorization: `Bearer ${jwt.sign(users.engineer, randomUUID())}`,
    } });
    assert.equal(invalidToken.status, 403);
    assert.equal((await invalidToken.json()).error, 'Invalid token.');
    // Owners/admins need no membership; assigned roles and viewers read through membership.
    for (const url of [base, `/projects/${first.code}/issues`, `/issues/${migrated[0].id}`]) {
      for (const user of [users.engineer, users.owner, users.manager, users.supervisor, users.admin, users.viewer]) {
        const response = await request(url, user);
        assert.equal(response.status, 200,
          `${user.role} reading ${url}: ${JSON.stringify(response.body)}`);
      }
    }
    for (const url of [base, `/projects/${first.code}/issues`, `/issues/${migrated[0].id}`]) {
      assert.equal((await request(url, users.outsider)).status, 403);
    }
    assert.equal((await request(`/projects/${second.id}/issues`, users.manager)).status, 403);
    assert.equal((await request(`/projects/${randomUUID()}/issues`)).status, 404);
    assert.equal((await request(`/issues/${randomUUID()}`)).status, 404);
    assert.equal((await request('/issues/bad-id')).status, 400);
    assert.equal((await request(`${base}?status=invalid`)).status, 400);
    let listing = await request('/projects', users.owner);
    assert.equal(listing.status, 200);
    assert.equal(listing.body.data.find(p => p.id === first.id).active_issue_count, 2);
    assert.equal(listing.body.data.find(p => p.id === empty.id).active_issue_count, 0);
    assert.equal(listing.body.data.find(p => p.id === empty.id).has_active_issues, false);
    assert.equal(listing.body.data.some(p => p.id === second.id), false);
    assert.equal((await request('/projects', users.admin)).body.data.length, 3);
    assert.equal((await request('/projects?status=Completed&search=Test&code=PRJ-TEST-001', users.owner)).body.data.length, 1);
    assert.equal((await request('/projects/joined')).body.data[0].active_issue_count, 2);
    assert.equal((await request(`/projects/${first.code}`)).body.data.active_issue_count, 2);
    const projectService = require('../services/projectService');
    const queryCalls = pool.query.mock.calls.length;
    const accessible = await projectService.getAll(undefined, undefined, undefined, users.owner.id, users.owner.email, users.owner.role);
    assert.equal(accessible.length, 2);
    assert.equal(pool.query.mock.calls.length - queryCalls, 1);
    let result = await request(`${base}?status=active`);
    assert.equal(result.body.active_issue_count, 2);
    assert.equal(result.body.issues.length, 2);
    assert.deepEqual(result.body.data, result.body.issues);
    result = await request(`${base}?status=active&severity=high&category=Safety%20Hazard&search=Open`);
    assert.equal(result.body.issues.length, 1);
    assert.equal(result.body.active_issue_count, 2);
    assert.equal((await request(`${base}?status=Resolved`)).body.issues.length, 1);
    assert.equal((await request(base)).body.issues.length, 3);

    const body = { title: 'Hollow blocks not delivered', description: 'Expected delivery did not arrive', category: 'delivery', severity: 'critical', reported_by: users.admin.id, assigned_to: users.engineer.id };
    // The shared issue controller must preserve the project activation restriction.
    for (const status of ['Planning', ' Draft ', 'Pending']) {
      await client.query('UPDATE projects SET status=$1 WHERE id=$2', [status, first.id]);
      for (const reference of [first.id, first.code]) {
        const url = `/projects/${reference}/issues`;
        assert.equal((await request(url)).status, 200);
        const blocked = await request(url, users.engineer, 'POST', body);
        assert.equal(blocked.status, 400);
        assert.equal(blocked.body.message,
          'Cannot report issues because the project is in planning and not yet activated.');
        assert.equal((await request(url, users.outsider, 'POST', body)).status, 403);
        assert.equal((await request(url, users.viewer, 'POST', body)).status, 403);
      }
    }
    await client.query("UPDATE projects SET status='Completed' WHERE id=$1", [first.id]);
    assert.equal((await client.query('SELECT COUNT(*)::int AS count FROM notifications')).rows[0].count, 0);
    assert.equal((await service.getCounts(first.id, client)).active_issue_count, 2);
    assert.equal((await request(base, users.outsider, 'POST', body)).status, 403);
    assert.equal((await request(base, users.viewer, 'POST', body)).status, 403);
    assert.equal((await request(base, users.engineer, 'POST', { ...body, assigned_to: users.outsider.id })).status, 400);
    assert.equal((await request(base, users.engineer, 'POST', { ...body, project_id: second.id })).status, 400);
    assert.equal((await request(base, users.engineer, 'POST', { ...body, title: {} })).status, 400);
    result = await request(base, users.engineer, 'POST', body);
    assert.equal(result.status, 201);
    const created = result.body.data;
    assert.equal(created.status, 'open');
    assert.equal(created.severity, 'critical');
    assert.equal(created.reported_by, users.engineer.id);
    assert.equal(created.project_id, first.id);
    assert.equal(result.body.active_issue_count, 3);
    const notifications = (await client.query('SELECT * FROM notifications')).rows;
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].title, 'New Project Issue');
    assert.equal(notifications[0].message, `Test Project has a new issue: ${body.title}.`);
    assert.equal(notifications[0].project_id, first.code);
    assert.equal(notifications[0].audience, 'project');
    assert.equal(emissions[0].event, 'project_issues_updated');
    assert.equal(emissions[0].payload.active_issue_count, 3);
    assert.ok(emissions[0].rooms.includes(`user:${users.admin.id}`));
    assert.ok(emissions[0].rooms.includes(`user:${users.owner.id}`));
    assert.ok(!emissions[0].rooms.includes(`user:${users.outsider.id}`));
    assert.equal(emissions[1].event, 'new_notification');
    listing = await request('/projects');
    assert.equal(listing.body.data[0].active_issue_count, 3);

    const issueUrl = `${base}/${created.id}`;
    const feedback = {
      resolution_summary: ' The delivery arrived. ',
      resolution_steps: [' Contacted supplier ', ' Verified delivery '],
      final_remarks: ' Materials are available. ',
      resolved_by: users.admin.id, resolved_at: '2000-01-01T00:00:00Z', role: 'Admin', admin_id: users.admin.id,
    };
    assert.equal((await request(issueUrl, users.supervisor, 'PATCH', {
      resolution_notes: 'Reviewed by the assigned supervisor',
    })).status, 200);
    assert.equal((await request(issueUrl, users.outsider, 'PATCH', { ...feedback, status: 'resolved' })).status, 403);
    assert.equal((await request(`/projects/${second.id}/issues/${created.id}`, users.admin, 'PATCH', { ...feedback, status: 'resolved' })).status, 404);
    assert.equal((await request(`${issueUrl}/resolve`, null, 'PATCH', feedback)).status, 401);
    assert.equal((await request('/issues/bad-id/resolve', users.admin, 'PATCH', feedback)).status, 400);
    assert.equal((await request(`/issues/${randomUUID()}/resolve`, users.admin, 'PATCH', feedback)).status, 404);
    for (const user of [users.engineer, users.supervisor, users.viewer, users.outsider]) {
      assert.equal((await request(`${issueUrl}/resolve`, user, 'PATCH', feedback)).status, 403);
    }
    // An old privileged JWT cannot override the user's current database role or disabled account.
    await client.query("UPDATE users SET role='Member' WHERE id=$1", [users.manager.id]);
    assert.equal((await request(`${issueUrl}/resolve`, users.manager, 'PATCH', feedback)).status, 403);
    await client.query("UPDATE users SET role='Project Manager',is_active=FALSE WHERE id=$1", [users.manager.id]);
    assert.equal((await request(`${issueUrl}/resolve`, users.manager, 'PATCH', feedback)).status, 401);
    await client.query('UPDATE users SET is_active=TRUE WHERE id=$1', [users.manager.id]);
    assert.equal((await request(issueUrl, users.engineer, 'PATCH', { status: 'closed' })).status, 400);
    assert.equal((await request(issueUrl, users.engineer, 'PATCH', {})).status, 400);
    assert.equal((await request(issueUrl, users.manager, 'PATCH', { status: 'resolved' })).status, 400);
    const beforeFailure = emissions.length;
    for (const failure of ['resolution', 'status', 'notification']) {
      failResolution = failure === 'resolution';
      failStatusUpdate = failure === 'status';
      failNotification = failure === 'notification';
      assert.equal((await request(`${issueUrl}/resolve`, users.manager, 'PATCH', feedback)).status, 500);
      const unchanged = (await client.query('SELECT status,resolved_at FROM project_issues WHERE id=$1', [created.id])).rows[0];
      assert.equal(unchanged.status, 'open');
      assert.equal(unchanged.resolved_at, null);
      assert.equal((await client.query('SELECT COUNT(*)::int AS count FROM issue_resolutions WHERE issue_id=$1', [created.id])).rows[0].count, 0);
      assert.equal((await client.query("SELECT COUNT(*)::int AS count FROM notifications WHERE title='Issue Resolved'")).rows[0].count, 0);
      assert.equal(emissions.length, beforeFailure);
    }
    result = await request(issueUrl, users.manager, 'PATCH', { ...feedback, status: 'resolved' });
    assert.equal(result.status, 200);
    assert.ok(result.body.data.resolved_at);
    assert.equal(result.body.active_issue_count, 2);
    assert.equal(result.body.data.resolution.resolution_summary, 'The delivery arrived.');
    assert.deepEqual(result.body.data.resolution.resolution_steps, ['Contacted supplier', 'Verified delivery']);
    assert.equal(result.body.data.resolution.final_remarks, 'Materials are available.');
    assert.deepEqual(result.body.data.resolution.resolved_by, { id: users.manager.id, name: 'manager' });
    assert.equal(new Date(result.body.data.resolution.resolved_at).getTime(), new Date(result.body.data.resolved_at).getTime());
    assert.notEqual(result.body.data.resolved_at, feedback.resolved_at);
    assert.deepEqual((await request(`/issues/${created.id}`)).body.data.resolution, result.body.data.resolution);
    assert.deepEqual((await request(`/projects/${first.code}/issues/${created.id}`)).body.data.resolution, result.body.data.resolution);
    assert.deepEqual((await request(base)).body.data.find(i => i.id === created.id).resolution, result.body.data.resolution);
    const notice = (await client.query("SELECT * FROM notifications WHERE title='Issue Resolved'")).rows;
    assert.equal(notice.length, 1);
    assert.equal(notice[0].target_user_id, users.engineer.id);
    assert.equal(notice[0].audience, 'individual');
    assert.equal(notice[0].message, `${body.title} has been resolved by manager.`);
    assert.deepEqual(emissions.at(-1).rooms, [`user:${users.engineer.id}`]);
    const resolvedAt = result.body.data.resolved_at;
    for (const url of [`${issueUrl}/resolve`, `/issues/${created.id}/resolve`, issueUrl, `/issues/${created.id}`]) {
      assert.equal((await request(url, users.manager, 'PATCH', { ...feedback, status: 'Resolved' })).status, 409);
    }
    result = await request(`/issues/${created.id}`, users.engineer, 'PUT', { title: created.title });
    assert.equal(result.status, 200);
    assert.equal(result.body.data.resolved_at, resolvedAt);
    result = await request(issueUrl, users.engineer, 'PATCH', { status: 'In Progress', priority: 'High' });
    assert.equal(result.body.data.status, 'in_progress');
    assert.equal(result.body.data.severity, 'high');
    assert.equal(result.body.data.priority, 'High');
    assert.equal(result.body.data.resolved_at, null);
    assert.equal(result.body.data.resolution, null);
    assert.equal(result.body.active_issue_count, 3);
    result = await request(`/issues/${created.id}/resolve`, users.admin, 'PATCH', { ...feedback, assigned_to: users.supervisor.id });
    assert.equal(result.status, 200);
    assert.equal(result.body.data.resolution.resolved_by.id, users.admin.id);
    assert.equal((await client.query('SELECT COUNT(*)::int AS count FROM issue_resolutions WHERE issue_id=$1', [created.id])).rows[0].count, 2);
    const secondNotices = (await client.query("SELECT target_user_id FROM notifications WHERE title='Issue Resolved' AND created_by=$1", [users.admin.id])).rows;
    assert.deepEqual(new Set(secondNotices.map(n => n.target_user_id)), new Set([users.engineer.id, users.supervisor.id]));
    result = await request(issueUrl, users.engineer, 'PATCH', { status: 'open' });
    assert.equal(result.status, 200);
    assert.equal((await request(issueUrl, users.engineer, 'DELETE')).status, 403);
    assert.equal((await request(`/issues/${created.id}`, users.owner, 'DELETE')).status, 200);
    assert.equal((await client.query('SELECT COUNT(*)::int AS count FROM issue_resolutions WHERE issue_id=$1', [created.id])).rows[0].count, 0);
    assert.equal((await service.getCounts(first.id, client)).active_issue_count, 2);

    const legacy = await request(`/projects/${first.code}/issues`, users.engineer, 'POST', { ...body, severity: undefined, priority: 'Medium' });
    assert.equal(legacy.status, 201);
    assert.equal(legacy.body.data.severity, 'medium');
    const priorCount = (await service.getCounts(first.id, client)).active_issue_count;
    failNotification = true;
    assert.equal((await request(base, users.engineer, 'POST', body)).status, 500);
    assert.equal((await service.getCounts(first.id, client)).active_issue_count, priorCount);
    assert.equal((await client.query('SELECT COUNT(*)::int AS count FROM notifications')).rows[0].count, 5);
    // Membership revocation takes effect for both HTTP reads and socket recipients.
    await client.query('DELETE FROM project_members WHERE user_id=$1', [users.engineer.id]);
    assert.equal((await request(base)).status, 403);
    assert.equal((await request(`/projects/${first.code}/issues/${legacy.body.data.id}/resolve`, users.owner, 'PATCH', feedback)).status, 200);
    assert.ok(!emissions.findLast(e => e.event === 'project_issues_updated').rooms.includes(`user:${users.engineer.id}`));
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    mock.restoreAll();
    await client.query('ROLLBACK');
    client.release();
  }
});

test('concurrent resolution requests save one resolution and return one conflict', { timeout: 15000 }, async () => {
  // Separate connections need committed fixtures. Only this uniquely named test schema is removed.
  const setup = await pool.connect();
  const schema = `issue_resolution_race_${randomUUID().replaceAll('-', '')}`;
  const projectId = randomUUID();
  const issueId = randomUUID();
  const adminId = randomUUID();
  const reporterId = randomUUID();
  const racers = [];
  let server;
  let releaseBarrier;
  try {
    await setup.query(`CREATE SCHEMA "${schema}"`);
    await setup.query(`SET search_path TO "${schema}", public`);
    await setup.query(`CREATE TABLE users (id UUID PRIMARY KEY, full_name TEXT, email TEXT, role TEXT, is_active BOOLEAN DEFAULT TRUE);
      CREATE TABLE projects (id UUID PRIMARY KEY, code VARCHAR(50), name TEXT, status TEXT, owner_id UUID REFERENCES users(id));
      CREATE TABLE project_members (project_id VARCHAR(50), user_id UUID, user_name TEXT);
      CREATE TABLE project_issues (id UUID PRIMARY KEY, project_id UUID REFERENCES projects(id), title TEXT, status TEXT,
        reported_by UUID REFERENCES users(id), assigned_to UUID REFERENCES users(id), resolved_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE notifications (id SERIAL PRIMARY KEY, title TEXT, message TEXT, audience TEXT, project_id VARCHAR(50),
        target_user_id UUID REFERENCES users(id), created_by UUID REFERENCES users(id), created_at TIMESTAMPTZ DEFAULT NOW());`);
    await setup.query(fs.readFileSync(path.join(__dirname, '../migrations/issue_resolutions.sql'), 'utf8'));
    await setup.query("INSERT INTO users (id,full_name,email,role) VALUES ($1,'Admin','admin@example.test','Admin'),($2,'Reporter','reporter@example.test','Site Engineer')", [adminId, reporterId]);
    await setup.query("INSERT INTO projects VALUES ($1,'RACE-PROJECT','Race Project','Active',$2)", [projectId, adminId]);
    await setup.query("INSERT INTO project_issues (id,project_id,title,status,reported_by) VALUES ($1,$2,'Race issue','open',$3)", [issueId, projectId, reporterId]);
    racers.push(await pool.connect(), await pool.connect());
    for (const racer of racers) await racer.query(`SET search_path TO "${schema}", public`);
    const available = [...racers];
    let arrivals = 0;
    const barrier = new Promise(resolve => { releaseBarrier = resolve; });
    mock.method(pool, 'connect', async () => {
      const racer = available.shift();
      return {
        async query(sql, values) {
          if (sql === 'SELECT id FROM projects WHERE id = $1 FOR UPDATE') {
            if (++arrivals === 2) releaseBarrier();
            await barrier; // Both requests located the open issue before either obtains the project lock.
          }
          return racer.query(sql, values);
        },
        release() {},
      };
    });
    const app = express();
    app.use(express.json());
    app.use(require('../middlewares/authMiddleware').verifyToken);
    app.use('/', require('../routes/issuesRoutes'));
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const url = `http://127.0.0.1:${server.address().port}/issues/${issueId}/resolve`;
    const options = { method: 'PATCH', headers: {
      Authorization: `Bearer ${jwt.sign({ id: adminId, role: 'Admin' }, process.env.JWT_SECRET)}`,
      'Content-Type': 'application/json',
    }, body: JSON.stringify({ resolution_summary: 'Fixed', resolution_steps: ['Inspected', 'Repaired'], final_remarks: 'Safe' }) };
    const responses = await Promise.all([fetch(url, options), fetch(url, options)]);
    assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
    assert.equal((await setup.query('SELECT COUNT(*)::int AS count FROM issue_resolutions')).rows[0].count, 1);
    assert.equal((await setup.query('SELECT COUNT(*)::int AS count FROM notifications')).rows[0].count, 1);
    const state = (await setup.query(`SELECT i.status, i.resolved_at = r.resolved_at AS same_timestamp
      FROM project_issues i JOIN issue_resolutions r ON r.issue_id = i.id`)).rows[0];
    assert.equal(state.status, 'resolved');
    assert.equal(state.same_timestamp, true);
  } finally {
    releaseBarrier?.();
    if (server) await new Promise(resolve => server.close(resolve));
    mock.restoreAll();
    for (const racer of racers) {
      await racer.query('ROLLBACK');
      await racer.query('RESET search_path');
      racer.release();
    }
    await setup.query('RESET search_path');
    await setup.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    setup.release();
  }
});

test.after(() => pool.end());
