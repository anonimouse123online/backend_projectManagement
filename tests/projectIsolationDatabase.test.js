const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const express = require('express');
const pool = require('../db');
const jwt = require('jsonwebtoken');

test('account isolation through real PostgreSQL queries and HTTP routes', async t => {
  const client = await pool.connect();
  const schema = `isolation_${randomUUID().replaceAll('-', '')}`;
  let server;
  try {
    await client.query('BEGIN');
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET LOCAL search_path TO "${schema}", public`);
    // Clone the inspected schema; all data and DDL are rolled back. Serial defaults
    // get private sequences so even production sequence counters remain untouched.
    const tables = ['users', 'projects', 'project_members', 'project_invite_codes', 'tasks', 'task_phases',
      'resources', 'time_logs', 'time_log_tags', 'documents', 'project_issues', 'issue_resolutions',
      'notifications', 'task_images', 'project_reports', 'software', 'monitor_items', 'rfis', 'notes', 'login_security_logs'];
    for (const table of tables) {
      await client.query(`CREATE TABLE "${table}" (LIKE public."${table}" INCLUDING ALL)`);
      const columns = (await client.query(`SELECT column_name FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = $2 AND column_default LIKE 'nextval%'`, [schema, table])).rows;
      for (const { column_name: column } of columns) {
        const sequence = `${table}_${column}_private_seq`;
        await client.query(`CREATE SEQUENCE "${sequence}"`);
        await client.query(`ALTER TABLE "${table}" ALTER COLUMN "${column}" SET DEFAULT nextval('${sequence}')`);
      }
    }
    // Legacy report endpoints reference a table absent from this installation.
    // Exercise their access SQL with a test-only compatible table, never production DDL.
    await client.query(`CREATE TABLE reports (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), task_id UUID,
      report_date DATE, report_text TEXT, observations JSONB, status TEXT, created_at TIMESTAMPTZ DEFAULT now(), image_paths JSONB)`);
    const users = {};
    for (const [name, role] of [['a', 'admin'], ['b', 'admin'], ['c', 'engineer'], ['viewer', 'engineer']]) {
      const id = randomUUID();
      await client.query(`INSERT INTO users (id, full_name, email, password_hash, role, is_active, email_verified)
        VALUES ($1,$2,$3,'test-only',$4,TRUE,TRUE)`, [id, name, `${name}@isolation.test`, role]);
      users[name] = { id, email: `${name}@isolation.test`, role };
    }
    const project = { id: randomUUID(), code: 'ISOLATION-ALPHA' };
    const task = randomUUID();
    await client.query(`INSERT INTO projects (id,code,name,owner_id,status,budget)
      VALUES ($1,$2,'Alpha',$3,'Ongoing',10000)`, [project.id, project.code, users.a.id]);
    await client.query(`INSERT INTO project_members (project_id,user_id,user_name,role)
      VALUES ($1,$2,$3,'Engineer')`, [project.code, users.c.id, users.c.email]);
    await client.query(`INSERT INTO tasks (id,task_name,project_id,assignee_id,status,phase,priority,due_date)
      VALUES ($1,'Alpha task',$2,$3,'Pending','Site Development','Medium','2099-01-01')`, [task, project.id, users.c.id]);
    const report = (await client.query(`INSERT INTO reports (task_id,report_date,report_text,status)
      VALUES ($1,CURRENT_DATE,'Alpha report','completed') RETURNING id`, [task])).rows[0].id;
    const software = (await client.query(`INSERT INTO software (name,project_id) VALUES ('Alpha software',$1) RETURNING id`, [project.id])).rows[0].id;
    const resource = (await client.query(`INSERT INTO resources (name,category,quantity,unit,unit_price,project)
      VALUES ('Alpha cement','Material',1,'bags',100,'Alpha') RETURNING id`)).rows[0].id;
    const log = (await client.query(`INSERT INTO time_logs (project_name,engineer_name,date)
      VALUES ('Alpha','Engineer',CURRENT_DATE) RETURNING id`)).rows[0].id;
    const issue = (await client.query(`INSERT INTO project_issues (project_id,project_code,title,category,description,status,severity)
      VALUES ($1,$2,'Alpha issue','other','Private','open','high') RETURNING id`, [project.id, project.code])).rows[0].id;
    await client.query(`INSERT INTO notifications (title,message,audience,project_id,created_by)
      VALUES ('Alpha notification','Private','project',$1,$2)`, [project.code, users.a.id]);
    await client.query(`INSERT INTO documents (project_code,name,type,category,file_path)
      VALUES ($1,'Private plan','PDF','Site Reference','/uploads/documents/private-plan.pdf')`, [project.code]);

    mock.method(pool, 'query', (sql, values) => client.query(sql, values));
    mock.method(pool, 'connect', async () => ({
      query: (sql, values) => client.query(sql === 'BEGIN' ? 'SAVEPOINT http_request' :
        sql === 'COMMIT' ? 'RELEASE SAVEPOINT http_request' : sql === 'ROLLBACK' ? 'ROLLBACK TO SAVEPOINT http_request' : sql, values),
      release() {},
    }));
    mock.method(console, 'log', () => {});
    const app = express();
    app.use(express.json());
    app.use('/auth', require('../routes/auth'));
    app.use('/uploads', require('../middlewares/projectFileAccess'), (_req, res) => res.json({ authorized: true }));
    for (const [prefix, file] of [['projects', 'project'], ['tasks', 'task'], ['resources', 'resource'],
      ['reports', 'routes_report'], ['timelogs', 'timelog'], ['software', 'software'], ['dashboard', 'dashboard'],
      ['notifications', 'notificationRoutes'], ['users', 'user']]) app.use(`/${prefix}`, require(`../routes/${file}`));
    app.use(require('../routes/issuesRoutes'));
    app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    async function request(path, account = 'b', method = 'GET', body, token) {
      const response = await fetch(base + path, { method, headers: {
        'Content-Type': 'application/json',
        ...(account ? { Authorization: `Bearer ${token || jwt.sign(users[account], process.env.JWT_SECRET, { expiresIn: '5m' })}` } : {}),
      }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, body: await response.json(), headers: response.headers };
    }

    await t.test('A owns Alpha, fresh admin B has empty lists, assigned C retains access', async () => {
      for (const account of ['a', 'c']) {
        const result = await request('/projects', account);
        assert.equal(result.status, 200);
        assert.equal(result.body.data.length, 1);
        assert.equal((await request(`/projects/${project.code}`, account)).status, 200);
      }
      for (const path of ['/projects', '/projects/joined', '/tasks', '/reports', '/resources', '/software', '/notifications', '/timelogs', '/dashboard/projects', '/dashboard/notes', '/dashboard/monitor', '/dashboard/rfis']) {
        const result = await request(path);
        assert.equal(result.status, 200, `${path}: ${JSON.stringify(result.body)}`);
        assert.deepEqual(result.body.data, [], path);
        assert.equal(result.headers.get('cache-control'), 'no-store');
      }
    });
    await t.test('B cannot guess project or related IDs, including files and report actions', async () => {
      for (const path of [`/projects/${project.code}`, `/projects/${project.id}`, `/projects/${project.code}/members`,
        `/projects/${project.code}/documents`, `/projects/${project.code}/reports`, `/projects/${project.code}/stats`,
        `/projects/${project.code}/active-code`, `/projects/${project.code}/progress`, `/projects/${project.code}/issues`,
        `/issues/${issue}`, `/tasks/${task}`, `/tasks/${task}/images`, `/tasks/${task}/report`,
        `/reports/${report}`, `/reports/task/${task}`, `/software/${software}`, `/software/project/${project.id}`,
        `/timelogs/${log}`, '/uploads/documents/private-plan.pdf', `/uploads/tasks/${task}/2026-10-13/image.jpg`]) {
        const result = await request(path);
        assert.ok([403, 404].includes(result.status), `${path}: ${result.status} ${JSON.stringify(result.body)}`);
      }
      for (const [path, method, body] of [
        [`/tasks/${task}/reports`, 'POST', { report_text: 'Injected' }], [`/tasks/${task}/generate-report`, 'POST', {}],
        [`/tasks/${task}/images`, 'POST', {}], [`/tasks/${task}/subtasks`, 'PATCH', { subtasks: [] }],
        [`/projects/${project.code}/generate-code`, 'POST', {}], [`/projects/${project.code}`, 'DELETE'],
        [`/resources/${resource}`, 'DELETE'], [`/timelogs/${log}`, 'DELETE'], [`/software/${software}`, 'DELETE'],
        ['/resources', 'POST', { project: 'Alpha', name: 'Injected' }],
        ['/timelogs', 'POST', { project_name: 'Alpha', date: '2026-10-13' }],
      ]) assert.ok([403, 404].includes((await request(path, 'b', method, body)).status), path);
    });
    await t.test('C can report and work, but cannot assign tasks or manage stock/projects', async () => {
      assert.equal((await request(`/tasks/${task}/status`, 'c', 'PATCH', { status: 'ongoing' })).status, 200);
      for (const [path, method, body] of [[`/tasks/${task}/assign`, 'PATCH', { assigneeId: users.b.id }],
        [`/tasks/${task}`, 'PATCH', { task_name: 'Changed' }], [`/projects/${project.code}`, 'DELETE'],
        [`/resources/${resource}`, 'DELETE']]) assert.equal((await request(path, 'c', method, body)).status, 403, path);
      assert.equal((await request(`/reports/${report}`, 'c')).status, 200);
    });
    await t.test('invalid/expired JWT, stale roles, forged identities and disabled accounts', async () => {
      assert.equal((await request('/projects', null)).status, 401);
      assert.equal((await request('/projects', 'b', 'GET', undefined, jwt.sign(users.a, 'wrong-key'))).status, 401);
      assert.equal((await request('/projects', 'b', 'GET', undefined, jwt.sign(users.a, process.env.JWT_SECRET, { expiresIn: -1 }))).status, 401);
      assert.deepEqual((await request(`/projects?userId=${users.a.id}&owner_id=${users.a.id}&role=admin`)).body.data, []);
      const forgedRole = jwt.sign({ ...users.c, role: 'admin' }, process.env.JWT_SECRET);
      assert.equal((await request(`/tasks/${task}/assign`, 'c', 'PATCH', { assigneeId: users.b.id }, forgedRole)).status, 403);
      await client.query('UPDATE users SET is_active = FALSE WHERE id = $1', [users.b.id]);
      assert.equal((await request('/projects')).status, 401);
      await client.query('UPDATE users SET is_active = TRUE WHERE id = $1', [users.b.id]);
    });
    await t.test('email collisions do not override bound member IDs; verified legacy members retain access', async () => {
      await client.query('UPDATE project_members SET user_name = $1 WHERE user_id = $2', [users.b.email, users.c.id]);
      assert.deepEqual((await request('/projects')).body.data, []);
      // Older supported deployments allowed email-only memberships.
      await client.query('ALTER TABLE project_members ALTER COLUMN user_id DROP NOT NULL');
      await client.query("INSERT INTO project_members (project_id,user_name,role) VALUES ($1,$2,'Engineer')", [project.code, users.viewer.email]);
      assert.equal((await request('/projects', 'viewer')).body.data.length, 1);
      await client.query('UPDATE users SET email_verified = FALSE WHERE id = $1', [users.viewer.id]);
      assert.deepEqual((await request('/projects', 'viewer')).body.data, []);
      await client.query('UPDATE project_members SET user_name=$1 WHERE user_id=$2', [users.c.email, users.c.id]);
    });
    await t.test('same-name projects cannot expose legacy stock, budgets or time logs', async () => {
      await client.query(`INSERT INTO projects (code,name,owner_id,status) VALUES ('ISOLATION-BETA','Alpha',$1,'Ongoing')`, [users.b.id]);
      assert.deepEqual((await request('/resources')).body.data, []);
      assert.deepEqual((await request('/timelogs')).body.data, []);
      assert.equal(Number((await request('/projects')).body.data[0].total_spent), 0);
      assert.ok([403, 404].includes((await request(`/resources/${resource}`, 'b', 'DELETE')).status));
      await client.query('UPDATE resources SET task_id = $1 WHERE id = $2', [task, resource]);
      assert.equal((await request('/resources', 'a')).body.data.length, 1);
      assert.deepEqual((await request('/resources')).body.data, []);
    });
    await t.test('owner invitation workflow admits B explicitly, then removal revokes access', async () => {
      const invite = await request(`/projects/${project.code}/generate-code`, 'a', 'POST', {});
      assert.equal(invite.status, 200, JSON.stringify(invite.body));
      const code = (await client.query('SELECT code FROM project_invite_codes WHERE project_id=$1', [project.code])).rows[0].code;
      const joined = await request('/projects/join', 'b', 'POST', { invite_code: code, position: 'Engineer' });
      assert.equal(joined.status, 200, JSON.stringify(joined.body));
      assert.equal((await request(`/projects/${project.code}`)).status, 200);
      await client.query('DELETE FROM project_members WHERE project_id=$1 AND user_id=$2', [project.code, users.b.id]);
      assert.equal((await request(`/projects/${project.code}`)).status, 404);
      await client.query('DELETE FROM project_members WHERE project_id=$1 AND user_id=$2', [project.code, users.c.id]);
      // Explicit task assignment still authorizes C until that assignment is removed.
      assert.equal((await request(`/tasks/${task}`, 'c')).status, 200);
      await client.query('UPDATE tasks SET assignee_id = $2 WHERE id=$1', [task, users.a.id]);
      assert.equal((await request(`/tasks/${task}`, 'c')).status, 404);
    });
    await t.test('real signup/login starts empty and project creation ignores supplied ownership', async () => {
      const credentials = { email: 'new@isolation.test', password: 'Test-only-password-123' };
      const signup = await request('/auth/signup', null, 'POST', { ...credentials, name: 'New account', role: 'admin' });
      assert.equal(signup.status, 201, JSON.stringify(signup.body));
      const login = await request('/auth/login', null, 'POST', credentials);
      assert.equal(login.status, 200, JSON.stringify(login.body));
      assert.deepEqual((await request('/projects', 'b', 'GET', undefined, login.body.token)).body.data, []);
      const created = await request('/projects', 'b', 'POST', {
        code: 'ISOLATION-NEW', name: 'New project', location: 'Test site', scope: 'Test work', client: 'Client',
        budget: '1000.00', start_date: '2099-01-01', end_date: '2099-12-31', owner_id: users.a.id, user_id: users.a.id,
      }, login.body.token);
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const saved = (await client.query("SELECT owner_id FROM projects WHERE code='ISOLATION-NEW'")).rows[0];
      assert.equal(saved.owner_id, signup.body.user.id);
      assert.equal((await request(`/projects/${project.code}`, 'b', 'GET', undefined, login.body.token)).status, 404);
    });
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    mock.restoreAll();
    await client.query('ROLLBACK');
    client.release();
    await pool.end();
  }
});
