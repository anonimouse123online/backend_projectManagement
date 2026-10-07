const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const pool = require('../db');
const { materialItems } = require('../services/taskResourceService');

test('existing material text and JSON structures remain readable without inventing allocation quantities', () => {
  assert.deepEqual(materialItems('20 bags Portland Cement, 2.5 tons Steel Rebar'), [
    { name: 'Portland Cement', quantity: 20, unit: 'bags' },
    { name: 'Steel Rebar', quantity: 2.5, unit: 'tons' },
  ]);
  assert.deepEqual(materialItems('Unspecified item'), [{ name: 'Unspecified item', quantity: null, unit: null }]);
  for (const value of [null, undefined, '', 'None', 'None specified']) assert.deepEqual(materialItems(value), []);
  const items = [{ name: 'Mixer', category: 'Equipment', quantity: 1, unit: 'unit', supplier: 'Contractor' }];
  assert.deepEqual(materialItems(JSON.stringify(items)), items);
  assert.deepEqual(materialItems(items), items);
  assert.equal(materialItems('[Legacy note')[0].name, '[Legacy note');
});

test('JWT task list/detail return scoped materials, equipment and instructions using read-only PostgreSQL queries', async () => {
  const ids = {
    engineer: '00000000-0000-4000-8000-000000000001', owner: '00000000-0000-4000-8000-000000000002',
    member: '00000000-0000-4000-8000-000000000003', outsider: '00000000-0000-4000-8000-000000000004',
    otherEngineer: '00000000-0000-4000-8000-000000000005',
    project: '00000000-0000-4000-8000-000000000010', otherProject: '00000000-0000-4000-8000-000000000011',
    task: '00000000-0000-4000-8000-000000000020', empty: '00000000-0000-4000-8000-000000000021',
    other: '00000000-0000-4000-8000-000000000022', sibling: '00000000-0000-4000-8000-000000000023',
  };
  const task = {
    id: ids.task, task_name: 'Fence Foundation', phase: 'Structural', project_id: ids.project,
    assignee_id: ids.engineer, due_date: '2099-01-01', priority: 'Medium', status: 'In Progress', progress_pct: 45,
    materials_required: '20 bags Portland Cement, 1 unit Concrete Mixer, 2.5 tons Steel Rebar, 3 bags Shared Screws',
    site_instructions: 'Follow approved structural plans and safety procedures.',
    subtasks: [{ id: 'a', title: 'Excavation', completed: false, status: 'ongoing', progress: 60 }],
    created_at: '2026-10-07T00:00:00Z',
  };
  const resource = { name: 'Portland Cement', category: 'Material', quantity: 20, unit: 'bags',
    supplier: 'ABC Construction Supply', unit_price: 250, project: 'Fixture project', task_id: ids.task, task_name: task.task_name };
  // CTE fixtures exist only inside each SELECT. They create no tables, rows or migrations.
  const cte = (name, fields, rows) => `${name} AS (SELECT * FROM jsonb_to_recordset('${JSON.stringify(rows).replaceAll("'", "''")}') AS fixture(${fields}))`;
  const fixtures = `WITH ${[
    cte('users', 'id UUID, full_name TEXT, email TEXT', [
      { id: ids.engineer, full_name: 'Engineer' }, { id: ids.otherEngineer, full_name: 'Other engineer' },
    ]),
    cte('projects', 'id UUID, name TEXT, code TEXT, owner_id UUID, location TEXT, status TEXT', [
      { id: ids.project, name: 'Fixture project', code: 'FIXTURE', owner_id: ids.owner, location: 'Site', status: 'Ongoing' },
      { id: ids.otherProject, name: 'Private project', code: 'PRIVATE', owner_id: ids.outsider, location: 'Other site', status: 'Ongoing' },
    ]),
    cte('project_members', 'project_id TEXT, user_id UUID', [{ project_id: 'FIXTURE', user_id: ids.member }]),
    cte('tasks', `id UUID, task_name TEXT, phase TEXT, project_id UUID, assignee_id UUID, due_date DATE,
      priority TEXT, status TEXT, progress_pct INTEGER, materials_required TEXT, site_instructions TEXT, subtasks JSONB, created_at TIMESTAMPTZ`, [
      task,
      { ...task, id: ids.empty, task_name: 'Empty task', status: 'Pending', progress_pct: 0,
        materials_required: null, site_instructions: null, subtasks: [] },
      { ...task, id: ids.other, project_id: ids.otherProject, assignee_id: ids.otherEngineer },
      { ...task, id: ids.sibling, task_name: 'Other task', assignee_id: ids.otherEngineer },
    ]),
    cte('task_phases', 'task_id UUID, phase TEXT', [{ task_id: ids.task, phase: 'Structural' }]),
    cte('resources', `id INTEGER, name TEXT, category TEXT, quantity NUMERIC, unit TEXT, supplier TEXT,
      unit_price NUMERIC, project TEXT, task_id UUID, task_name TEXT`, [
      { ...resource, id: 1 },
      { ...resource, id: 2, name: 'Concrete Mixer', category: 'Equipment', quantity: 1, unit: 'unit', supplier: null },
      { ...resource, id: 3, task_id: null, task_name: null, quantity: 900 },
      { ...resource, id: 4, name: 'Steel Rebar', task_id: null, task_name: null, quantity: 500, unit: 'tons', supplier: 'Steel Supplier' },
      { ...resource, id: 5, name: 'Shared Screws', task_id: ids.sibling, task_name: 'Other task', supplier: 'Other task supplier' },
      { ...resource, id: 6, name: 'Steel Rebar', task_id: null, task_name: null, project: 'Private project', supplier: 'Private supplier' },
      { ...resource, id: 7, name: 'Shared Screws', task_id: null, task_name: 'Other task', supplier: 'Legacy other task supplier' },
      { ...resource, id: 8, name: 'Legacy Equipment', category: 'Equipment', task_id: null },
    ]),
  ].join(', ')} `;
  const client = await pool.connect();
  let server;
  let resourceQueries = 0;
  try {
    await client.query('BEGIN READ ONLY');
    mock.method(pool, 'query', (sql, values) => {
      assert.match(sql.trim(), /^SELECT\b/i, 'Task retrieval must execute only SELECT');
      if (sql.includes('FROM resources r')) resourceQueries++;
      return client.query(fixtures + sql, values);
    });
    mock.method(pool, 'connect', () => { throw new Error('Unexpected additional database connection'); });
    mock.method(console, 'log', () => {});
    const app = express();
    app.use(require('../middlewares/authMiddleware').verifyToken);
    app.use('/tasks', require('../routes/task'));
    server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
    const request = async (path, user = ids.engineer) => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
        headers: user ? { Authorization: `Bearer ${jwt.sign({ id: user, role: 'Site Engineer' }, process.env.JWT_SECRET)}` } : {},
      });
      return { status: response.status, body: await response.json() };
    };
    const detail = await request(`/tasks/${ids.task}`);
    assert.equal(detail.status, 200, JSON.stringify(detail.body));
    const data = detail.body.data;
    assert.equal(data.materials_required, task.materials_required);
    assert.equal(data.site_instructions, task.site_instructions);
    assert.deepEqual(data.resources.map(item => item.id), [1, 2, 8]);
    assert.equal(data.resources[0].supplier, resource.supplier);
    assert.equal(data.resources[0].unitPrice, 250); // Existing authenticated resource API already exposes prices.
    assert.equal(data.resources[1].category, 'Equipment');
    assert.equal(data.resources[1].supplier, null);
    assert.deepEqual(data.allocated_materials.map(item => item.quantity), [20, 1, 2.5, 3]);
    assert.equal(data.allocated_materials[2].supplier, 'Steel Supplier');
    assert.equal(data.allocated_materials[2].category, 'Material');
    assert.equal(data.allocated_materials[3].supplier, null);
    assert.equal(data.allocated_materials[3].category, null);
    assert.equal(data.status, 'ongoing');
    assert.equal(data.progress, 45);
    assert.equal(data.progress_pct, 45);
    assert.deepEqual(data.subtasks, task.subtasks);

    const list = await request(`/tasks?assignee_id=${ids.engineer}&project_id=FIXTURE`);
    assert.equal(list.status, 200, JSON.stringify(list.body));
    assert.deepEqual(list.body.data.map(item => item.id).sort(), [ids.task, ids.empty].sort());
    const listed = list.body.data.find(item => item.id === ids.task);
    assert.deepEqual(listed.resources, data.resources);
    assert.deepEqual(listed.allocated_materials, data.allocated_materials);
    assert.equal(listed.site_instructions, task.site_instructions);
    const empty = await request(`/tasks/${ids.empty}`);
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body.data.resources, []);
    assert.deepEqual(empty.body.data.allocated_materials, []);
    assert.equal(empty.body.data.materials_required, null);
    assert.equal(empty.body.data.site_instructions, null);

    for (const user of [ids.member, ids.owner]) assert.equal((await request(`/tasks/${ids.task}`, user)).status, 200);
    const beforeDenied = resourceQueries;
    assert.equal((await request(`/tasks/${ids.task}`, ids.outsider)).status, 404);
    assert.equal((await request(`/tasks/${ids.other}`)).status, 404);
    assert.equal((await request(`/tasks/${ids.task}`, null)).status, 401);
    const deniedList = await request(`/tasks?assignee_id=${ids.engineer}`, ids.outsider);
    assert.equal(deniedList.status, 200);
    assert.deepEqual(deniedList.body.data, []);
    assert.equal(resourceQueries, beforeDenied, 'Denied/empty task results must not fetch resources');
  } finally {
    if (server) await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
    mock.restoreAll();
    await client.query('ROLLBACK');
    client.release();
  }
});

test.after(() => pool.end());
