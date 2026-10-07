const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const pool = require('../db');

test('PostgreSQL migration and task HTTP workflows preserve legacy data and atomically save multiple phases', async () => {
  const client = await pool.connect();
  const schema = `task_phases_test_${randomUUID().replaceAll('-', '')}`;
  let server;
  try {
    await client.query('BEGIN');
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET LOCAL search_path TO "${schema}", public`);
    await client.query(`CREATE TABLE users (id UUID PRIMARY KEY, full_name TEXT, email TEXT, role TEXT, is_active BOOLEAN DEFAULT TRUE);
      CREATE TABLE projects (id UUID PRIMARY KEY, code VARCHAR(50), name TEXT, owner_id UUID REFERENCES users(id),
        location TEXT, client TEXT, budget NUMERIC, phase TEXT, scope TEXT, status TEXT, progress INTEGER DEFAULT 0,
        progress_pct INTEGER DEFAULT 0, start_date DATE, end_date DATE, updated_at TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE project_members (id SERIAL PRIMARY KEY, project_id VARCHAR(50), user_id UUID REFERENCES users(id), user_name TEXT);
      CREATE TABLE tasks (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), task_name VARCHAR(255) NOT NULL,
        phase VARCHAR(100) NOT NULL CHECK (phase IN ('Phase 1 - Foundation','Phase 2 - Structural',
          'Phase 3 - Electrical & Utilities','Phase 4 - Plumbing & MEP','Phase 5 - Finishing')),
        assignee_id UUID NOT NULL REFERENCES users(id), due_date DATE NOT NULL, priority VARCHAR(20) NOT NULL,
        materials_required TEXT, site_instructions TEXT, project_id UUID REFERENCES projects(id),
        status VARCHAR(50) NOT NULL DEFAULT 'Pending', subtasks JSONB NOT NULL DEFAULT '[]'::jsonb,
        progress_pct INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE resources (id SERIAL PRIMARY KEY, name TEXT, supplier TEXT, category TEXT, quantity INTEGER,
        unit TEXT, min_threshold INTEGER, unit_price NUMERIC, project TEXT, status TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE reports (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), task_id UUID REFERENCES tasks(id) ON DELETE CASCADE, report_date DATE,
        report_text TEXT, observations JSONB, status TEXT, created_at TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE project_progress_logs (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), project_code VARCHAR(50), phase TEXT,
        progress_pct INTEGER, summary TEXT, work_completed TEXT, manpower INTEGER, weather TEXT, logged_by UUID,
        created_at TIMESTAMPTZ DEFAULT NOW());`);
    const users = {
      owner: { id: randomUUID(), role: 'Project Manager', email: 'owner@example.test' },
      engineer: { id: randomUUID(), role: 'Site Engineer', email: 'engineer@example.test' },
      outsider: { id: randomUUID(), role: 'Site Engineer', email: 'outsider@example.test' },
    };
    for (const [name, user] of Object.entries(users)) {
      await client.query('INSERT INTO users (id,full_name,email,role) VALUES ($1,$2,$3,$4)', [user.id, name, user.email, user.role]);
    }
    const projectId = randomUUID();
    const code = 'TASK-PHASE-TEST';
    await client.query(`INSERT INTO projects (id,code,name,owner_id,start_date,end_date,status)
      VALUES ($1,$2,'Test Phase Project',$3,'2000-01-01','2100-12-31','Pending')`, [projectId, code, users.owner.id]);
    await client.query('INSERT INTO project_members (project_id,user_id,user_name) VALUES ($1,$2,$3)', [code, users.engineer.id, users.engineer.email]);
    const legacy = ['Phase 1 - Foundation', 'Phase 2 - Structural', 'Phase 3 - Electrical & Utilities', 'Phase 4 - Plumbing & MEP', 'Phase 5 - Finishing'];
    const mapped = ['Site Development', 'Structural', 'Electrical & Utilities', 'Plumbing & MEP', 'Architectural'];
    const legacyIds = [];
    for (const phase of legacy) {
      legacyIds.push((await client.query(`INSERT INTO tasks (task_name,phase,assignee_id,due_date,priority,project_id)
        VALUES ($1,$1,$2,'2099-01-01','Medium',$3) RETURNING id`, [phase, users.engineer.id, projectId])).rows[0].id);
    }
    const sql = fs.readFileSync(path.join(__dirname, '../migrations/task_phases.sql'), 'utf8');
    await client.query(sql);
    const firstCheck = (await client.query("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='tasks'::regclass AND conname='tasks_phase_check'")).rows[0].definition;
    await client.query(sql);
    assert.equal((await client.query("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='tasks'::regclass AND conname='tasks_phase_check'")).rows[0].definition, firstCheck);
    assert.deepEqual((await client.query('SELECT phase FROM tasks ORDER BY phase')).rows.map(r => r.phase), legacy);
    for (let i = 0; i < legacyIds.length; i++) {
      assert.deepEqual((await client.query('SELECT phase FROM task_phases WHERE task_id=$1', [legacyIds[i]])).rows.map(r => r.phase), [mapped[i]]);
    }
    assert.deepEqual((await client.query("SELECT normalize_task_phase('Foundation') AS foundation, normalize_task_phase('Finishing') AS finishing")).rows[0],
      { foundation: 'Site Development', finishing: 'Architectural' });
    await client.query('SAVEPOINT constraints');
    await assert.rejects(client.query("INSERT INTO task_phases (task_id,phase) VALUES ($1,'Site Development')", [legacyIds[0]]), { code: '23505' });
    await client.query('ROLLBACK TO SAVEPOINT constraints');
    await assert.rejects(client.query("INSERT INTO task_phases (task_id,phase) VALUES ($1,'Unsupported')", [legacyIds[0]]), { code: '23514' });
    await client.query('ROLLBACK TO SAVEPOINT constraints');
    await assert.rejects(client.query("INSERT INTO task_phases (task_id,phase) VALUES ($1,'Architectural')", [randomUUID()]), { code: '23503' });
    await client.query('ROLLBACK TO SAVEPOINT constraints');
    // Unknown historical categories cause an explicit migration failure, preserving all data on rollback.
    await client.query('ALTER TABLE tasks DROP CONSTRAINT tasks_phase_check');
    await client.query("UPDATE tasks SET phase='Unreviewed legacy category' WHERE id=$1", [legacyIds[0]]);
    await assert.rejects(client.query(sql), /Unsupported historical task phases/);
    await client.query('ROLLBACK TO SAVEPOINT constraints');

    // The repository setup schema has no phase check and permits blank/null historical rows.
    await client.query('SAVEPOINT setup_schema_compatibility');
    await client.query('ALTER TABLE tasks DROP CONSTRAINT tasks_phase_check');
    await client.query('ALTER TABLE tasks ALTER COLUMN phase DROP NOT NULL');
    await client.query('DROP TRIGGER task_phase_legacy_sync ON tasks');
    await client.query("UPDATE tasks SET phase=CASE WHEN id=$1 THEN 'Foundation' ELSE 'Finishing' END WHERE id IN ($1,$2)", [legacyIds[0], legacyIds[4]]);
    await client.query('DELETE FROM task_phases WHERE task_id IN ($1,$2)', [legacyIds[0], legacyIds[4]]);
    const emptyPhase = (await client.query(`INSERT INTO tasks (task_name,phase,assignee_id,due_date,priority,project_id)
      VALUES ('Historical blank',NULL,$1,'2099-01-01','Medium',$2) RETURNING id`, [users.engineer.id, projectId])).rows[0].id;
    await client.query(sql);
    assert.equal((await client.query('SELECT phase FROM task_phases WHERE task_id=$1', [legacyIds[0]])).rows[0].phase, 'Site Development');
    assert.equal((await client.query('SELECT phase FROM task_phases WHERE task_id=$1', [legacyIds[4]])).rows[0].phase, 'Architectural');
    assert.equal((await client.query('SELECT COUNT(*)::int AS count FROM task_phases WHERE task_id=$1', [emptyPhase])).rows[0].count, 0);
    await client.query('ROLLBACK TO SAVEPOINT setup_schema_compatibility');

    let failPhase = false;
    let failResource = false;
    let failProgress = false;
    const query = async (statement, values) => {
      if (failPhase && /INSERT INTO task_phases/.test(statement)) { failPhase = false; throw new Error('Injected phase insert failure'); }
      if (failResource && /(?:INSERT INTO|UPDATE) resources/.test(statement)) { failResource = false; throw new Error('Injected resource write failure'); }
      if (failProgress && /UPDATE projects/.test(statement)) { failProgress = false; throw new Error('Injected progress write failure'); }
      return client.query(statement, values);
    };
    mock.method(pool, 'query', query);
    mock.method(pool, 'connect', async () => ({
      query: (statement, values) => query(statement === 'BEGIN' ? 'SAVEPOINT task_request' :
        statement === 'COMMIT' ? 'RELEASE SAVEPOINT task_request' :
        statement === 'ROLLBACK' ? 'ROLLBACK TO SAVEPOINT task_request' : statement, values), release() {},
    }));
    const operationLogs = mock.method(console, 'log', () => {});
    mock.method(console, 'error', () => {});
    const app = express();
    app.use(express.json());
    app.use(require('../middlewares/authMiddleware').verifyToken);
    app.use('/tasks', require('../routes/task'));
    app.use('/dashboard', require('../routes/dashboard'));
    app.use('/projects', require('../routes/project'));
    app.use('/reports', require('../routes/routes_report'));
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const root = `http://127.0.0.1:${server.address().port}`;
    async function request(url, method = 'GET', body, user = users.owner) {
      const response = await fetch(root + url, { method, headers: {
        ...(user ? { Authorization: `Bearer ${jwt.sign(user, process.env.JWT_SECRET)}` } : {}),
        'Content-Type': 'application/json',
      }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, body: await response.json() };
    }
    const baseBody = { task_name: 'Perimeter fence', phases: ['Site Development'], project_id: projectId,
      assignee_id: users.engineer.id, due_date: '2099-01-01', priority: 'Medium',
      materials_required: '2 bags Cement', site_instructions: 'Inspect the perimeter',
      subtasks: ['Inspect', { title: 'Prepare', completed: true }] };
    assert.equal((await request('/tasks', 'POST', baseBody, null)).status, 401);
    assert.equal((await request('/tasks', 'POST', baseBody, users.outsider)).status, 403);
    assert.equal((await request('/tasks', 'POST', { ...baseBody, assignee_id: users.outsider.id })).status, 400);
    let response = await request('/tasks', 'POST', baseBody);
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const single = response.body.data;
    assert.deepEqual(single.phases, ['Site Development']);
    assert.equal(single.phase, 'Site Development');
    assert.equal(single.status, 'In Progress');
    assert.equal(single.progress_pct, 50);
    assert.equal(single.subtasks.length, 2);
    const successfulRequestId = operationLogs.mock.calls.find(call => call.arguments[0] === '[CREATE TASK] inserting task (including embedded subtasks)').arguments[1].request_id;
    const labels = operationLogs.mock.calls.filter(call => call.arguments[1]?.request_id === successfulRequestId).map(call => call.arguments[0]);
    for (const label of ['database connection', 'checking project access and dates', 'looking up assignee',
      'checking assignee membership', 'inserting task (including embedded subtasks)', 'inserting task phases',
      'looking up materials/resources', 'inserting materials/resources', 'reading tasks for project progress',
      'synchronizing project progress/status', 'loading created task phases', 'committing transaction']) {
      assert.ok(labels.includes(`[CREATE TASK] ${label}`), `Missing query label: ${label}`);
    }
    assert.equal(labels.filter(label => label === '[CREATE TASK] database connection').length, 1);
    assert.equal((await client.query('SELECT COUNT(*)::int AS count FROM resources')).rows[0].count, 1);
    response = await request('/tasks', 'POST', { ...baseBody, task_name: 'Combined works',
      phases: [' Structural ', 'Site Development', 'Structural', 'Construction Phase'] });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const multi = response.body.data;
    assert.equal(multi.phase, 'Structural');
    assert.deepEqual(multi.phases, ['Structural', 'Construction Phase', 'Site Development']);
    assert.equal((await client.query('SELECT COUNT(*)::int AS count FROM task_phases WHERE task_id=$1', [multi.id])).rows[0].count, 3);
    for (const phases of [[], null, 'Structural', ['Unsupported'], [''], ['Structural', ' ']]) {
      assert.equal((await request('/tasks', 'POST', { ...baseBody, phases })).status, 400);
      assert.equal((await request(`/tasks/${multi.id}`, 'PATCH', { phases })).status, 400);
    }
    const withoutPhases = { ...baseBody };
    delete withoutPhases.phases;
    assert.equal((await request('/tasks', 'POST', withoutPhases)).status, 400);
    for (const [phase, expected] of [['Foundation', 'Site Development'], ['Finishing', 'Architectural'], ['Phase 3 - Electrical & Utilities', 'Electrical & Utilities']]) {
      response = await request('/tasks', 'POST', { ...withoutPhases, phase });
      assert.equal(response.status, 201);
      assert.deepEqual(response.body.data.phases, [expected]);
    }
    response = await request(`/tasks/${multi.id}`);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.data.phases, multi.phases);
    response = await request('/tasks?phase=Construction%20Phase');
    assert.equal(response.status, 200);
    assert.equal(response.body.data.length, 1);
    assert.equal(response.body.data[0].id, multi.id);
    assert.ok((await request('/tasks?phase=Foundation')).body.data.some(t => t.id === multi.id));
    assert.ok((await request('/tasks?phase=foundation')).body.data.some(t => t.id === multi.id));
    assert.equal((await request('/tasks')).body.data.length, (await client.query('SELECT COUNT(*)::int AS count FROM tasks')).rows[0].count);
    assert.equal((await request(`/tasks/${multi.id}`, 'PATCH', { phases: ['Architectural'] }, users.outsider)).status, 404);
    assert.equal((await request(`/tasks/${randomUUID()}`, 'PATCH', { phases: ['Architectural'] })).status, 404);
    assert.equal((await request(`/tasks/${multi.id}`, 'PATCH', { phase: 'Finishing' })).status, 400);
    assert.deepEqual((await request(`/tasks/${multi.id}`)).body.data.phases, multi.phases);
    response = await request(`/tasks/${multi.id}`, 'PATCH', { phases: ['Architectural', 'Turnover Phase', 'Architectural'] });
    assert.equal(response.status, 200);
    assert.equal(response.body.data.phase, 'Architectural');
    assert.deepEqual(response.body.data.phases, ['Architectural', 'Turnover Phase']);
    const replaced = response.body.data.phases;
    response = await request(`/tasks/${multi.id}`, 'PUT', { taskName: 'Updated fence', siteInstructions: 'Final inspection' });
    assert.equal(response.status, 200);
    assert.equal(response.body.data.task_name, 'Updated fence');
    assert.deepEqual(response.body.data.phases, replaced);
    // Existing action routes preserve the phase relations during unrelated edits.
    response = await request(`/tasks/${multi.id}/status`, 'PATCH', { status: 'In Progress' });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.data.phases, replaced);
    response = await request(`/tasks/${multi.id}/assign`, 'PATCH', { assigneeId: users.engineer.id });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.data.phases, replaced);
    response = await request(`/tasks/${multi.id}/subtasks`, 'PATCH', { subtasks: [{ title: 'Inspect', completed: false }, { title: 'Repair', completed: true }] });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.data.phases, replaced);
    assert.deepEqual((await request(`/tasks/${multi.id}`)).body.data.phases, replaced);

    // Non-first categories must contribute to dashboards and project category totals once.
    response = await request('/dashboard/progress?category=Turnover%20Phase');
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.data.tasks.total, 1);
    assert.equal(response.body.data.projects.total, 1);
    response = await request('/dashboard/gauge?category=Turnover%20Phase');
    assert.equal(response.status, 200);
    assert.equal(response.body.data.find(item => item.l === 'Active').v, '1');
    response = await request(`/projects/${code}/progress`);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(Number(response.body.data.taskBreakdown.find(item => item.phase === 'Turnover Phase').total_tasks), 1);
    assert.equal(response.body.data.stats.totalTasks, (await client.query('SELECT COUNT(*)::int AS count FROM tasks')).rows[0].count);
    // Additive report and active-task responses expose all categories too.
    const reportId = (await client.query("INSERT INTO reports (task_id,report_date,status) VALUES ($1,CURRENT_DATE,'Final') RETURNING id", [multi.id])).rows[0].id;
    response = await request(`/reports/${reportId}`);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.data.phases, replaced);
    response = await request(`/projects/${code}/active-task`);
    assert.equal(response.status, 200);
    assert.ok(Array.isArray(response.body.data.phases));

    const snapshot = async () => ({
      taskCount: (await client.query('SELECT COUNT(*)::int AS count FROM tasks')).rows[0].count,
      phaseCount: (await client.query('SELECT COUNT(*)::int AS count FROM task_phases')).rows[0].count,
      resources: (await client.query('SELECT name,quantity FROM resources ORDER BY id')).rows,
      project: (await client.query('SELECT status,progress,progress_pct FROM projects WHERE id=$1', [projectId])).rows[0],
    });
    for (const failure of ['phase', 'resource', 'progress']) {
      const before = await snapshot();
      failPhase = failure === 'phase'; failResource = failure === 'resource'; failProgress = failure === 'progress';
      assert.equal((await request('/tasks', 'POST', { ...baseBody, phases: ['Electrical & Utilities', 'Plumbing & MEP'] })).status, 500);
      assert.deepEqual(await snapshot(), before);
    }
    failPhase = true;
    response = await request(`/tasks/${multi.id}`, 'PATCH', { task_name: 'Must roll back', phases: ['Construction Phase'] });
    assert.equal(response.status, 500);
    response = await request(`/tasks/${multi.id}`);
    assert.equal(response.body.data.task_name, 'Updated fence');
    assert.equal(response.body.data.phase, 'Architectural');
    assert.deepEqual(response.body.data.phases, replaced);

    // Match the live generated resources.status schema and test both insert/update branches.
    await client.query('SAVEPOINT generated_resources');
    await client.query(`ALTER TABLE resources DROP COLUMN status;
      ALTER TABLE resources ADD COLUMN status VARCHAR(50) GENERATED ALWAYS AS (
        CASE WHEN category='Material' AND quantity <= min_threshold THEN 'Low stock'
             WHEN category='Material' AND quantity > min_threshold THEN 'In stock'
             WHEN category='Equipment' AND quantity <= min_threshold THEN 'Low Availability'
             WHEN category='Equipment' AND quantity > min_threshold THEN 'Available' ELSE NULL END) STORED;`);
    await client.query('SAVEPOINT generated_status_rejection');
    await assert.rejects(client.query(`EXPLAIN INSERT INTO resources (name,category,quantity,min_threshold,status)
      VALUES ('Diagnostic','Material',2,10,'Low stock')`), { code: '428C9' });
    await client.query('ROLLBACK TO SAVEPOINT generated_status_rejection');
    for (const allocated of [false, true]) {
      const name = allocated ? 'Generated equipment' : 'Generated cement';
      for (let attempt = 0; attempt < 2; attempt++) {
        response = await request('/tasks', 'POST', { ...baseBody,
          materials_required: `20 bags ${name}`,
          ...(allocated ? { allocatedMaterials: [{ name, category: 'Equipment', quantity: 20, minThreshold: 10 }] } : {}),
        });
        assert.equal(response.status, 201, JSON.stringify(response.body));
        assert.equal(response.body.data.status, 'In Progress');
        const resource = (await client.query('SELECT status,quantity FROM resources WHERE name=$1', [name])).rows[0];
        assert.equal(resource.quantity, 20 * (attempt + 1));
        assert.equal(resource.status, allocated ? 'Available' : 'In stock');
      }
    }
    await client.query('ROLLBACK TO SAVEPOINT generated_resources');
    await client.query(sql); // Rerunning a migration must not re-add old or removed selections.
    assert.deepEqual((await request(`/tasks/${multi.id}`)).body.data.phases, replaced);
    response = await request(`/tasks/${multi.id}/complete`, 'PATCH', {});
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.data.phases, replaced);
    // A legacy scalar SQL edit adds its mapped category without losing other categories.
    await client.query("UPDATE tasks SET phase='Phase 2 - Structural' WHERE id=$1", [multi.id]);
    assert.deepEqual(new Set((await request(`/tasks/${multi.id}`)).body.data.phases), new Set([...replaced, 'Structural']));
    await client.query('DELETE FROM tasks WHERE id=$1', [multi.id]);
    assert.equal((await client.query('SELECT COUNT(*)::int AS count FROM task_phases WHERE task_id=$1', [multi.id])).rows[0].count, 0);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    mock.restoreAll();
    await client.query('ROLLBACK');
    client.release();
    await pool.end();
  }
});
