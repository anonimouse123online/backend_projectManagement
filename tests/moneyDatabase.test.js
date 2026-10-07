const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const pool = require('../db');
const taskController = require('../controllers/taskController');
const taskPhases = require('../services/taskPhaseService');

test('authenticated budget APIs calculate decimal quantities, cent rounding and subtraction in PostgreSQL', async () => {
  const owner = randomUUID();
  const task = randomUUID();
  const ids = Object.fromEntries(['FLOAT', 'DECIMAL', 'SUM', 'OVER', 'EMPTY'].map(code => [code, randomUUID()]));
  // Read-only CTEs shadow real tables: no schema changes, migrations or fixture writes.
  const fixtures = `WITH projects AS (
    SELECT v.id::uuid, v.code, v.code AS name, '${owner}'::uuid AS owner_id,
      v.budget::numeric(15,2), NULL::text AS location, NULL::text AS scope,
      NULL::text AS client, NULL::text AS phase, 'Ongoing'::text AS status,
      0::int AS progress, 0::int AS progress_pct, NULL::date AS start_date,
      NULL::date AS end_date, NOW() AS created_at
    FROM (VALUES ${Object.entries(ids).map(([code, id]) =>
      `('${id}', '${code}', ${code === 'EMPTY' ? 'NULL' : `'${({ FLOAT: '0.30', DECIMAL: '10000', SUM: '1', OVER: '1' })[code]}'`})`).join(', ')}) v(id, code, budget)
  ), resources AS (
    SELECT v.project, v.quantity::numeric, v.unit_price::numeric, v.task_id::uuid
    FROM (VALUES
      ('float', '1', '0.10', NULL),
      ('Unmatched project', '2.5', '999.99', '${task}'),
      ('SUM', '0.05', '0.10', NULL), ('SUM', '0.05', '0.10', NULL),
      ('OVER', '3', '0.50', NULL), ('PRIVATE', '100', '999', NULL)
    ) v(project, quantity, unit_price, task_id)
  ), tasks AS (
    SELECT '${task}'::uuid AS id, '${ids.DECIMAL}'::uuid AS project_id, 'Pending'::text AS status
  ), project_members AS (
    SELECT NULL::text AS project_id, NULL::uuid AS user_id, NULL::text AS user_name WHERE FALSE
  ), project_issues AS (
    SELECT NULL::uuid AS project_id, NULL::text AS project_code, NULL::text AS status WHERE FALSE
  ) `;
  const client = await pool.connect();
  let server;
  try {
    await client.query('BEGIN READ ONLY');
    let pending = Promise.resolve();
    mock.method(pool, 'query', (sql, values) => {
      assert.match(sql.trim(), /^SELECT\b/i);
      pending = pending.then(() => client.query(fixtures + sql, values));
      return pending;
    });
    const app = express();
    app.use(require('../middlewares/authMiddleware').verifyToken);
    app.use('/projects', require('../routes/project'));
    server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
    const request = async (path, user = owner) => {
      const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
        headers: user ? { Authorization: `Bearer ${jwt.sign({ id: user, role: 'Project Manager' }, process.env.JWT_SECRET)}` } : {},
      });
      return { status: res.status, body: await res.json() };
    };
    const expected = {
      FLOAT: ['0.30', '0.10', '0.20'], DECIMAL: ['10000.00', '2499.98', '7500.02'],
      SUM: ['1.00', '0.01', '0.99'], OVER: ['1.00', '1.50', '-0.50'], EMPTY: ['0.00', '0.00', '0.00'],
    };
    const list = await request('/projects');
    assert.equal(list.status, 200, JSON.stringify(list.body));
    assert.equal(list.body.data.length, 5);
    for (const [code, [allocated, cost, remaining]] of Object.entries(expected)) {
      const detail = await request(`/projects/${code}`);
      assert.equal(detail.status, 200, JSON.stringify(detail.body));
      for (const data of [detail.body.data, list.body.data.find(p => p.code === code)]) {
        assert.equal(data.budget_allocated, allocated);
        assert.equal(data.total_resource_cost, cost);
        assert.equal(data.total_spent, cost);
        assert.equal(data.remaining_budget, remaining);
      }
      const stats = await request(`/projects/${code}/stats`);
      assert.equal(stats.status, 200, JSON.stringify(stats.body));
      assert.equal(stats.body.data.budgetAllocated, Number(allocated));
      assert.equal(stats.body.data.totalResourceCost, Number(cost));
      assert.equal(stats.body.data.totalSpent, Number(cost));
      assert.equal(stats.body.data.remainingBudget, Number(remaining));
      assert.equal(typeof stats.body.data.remainingBudget, 'number');
    }
    assert.equal((await request('/projects?status=Ongoing&code=FLOAT')).body.data.length, 1);
    assert.equal((await request('/projects/FLOAT/stats', randomUUID())).status, 403);
    assert.equal((await request('/projects/FLOAT/stats', null)).status, 401);
  } finally {
    if (server) await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
    mock.restoreAll();
    await client.query('ROLLBACK');
    client.release();
  }
});

test('task resource synchronization preserves fractional quantities and exact prices on insert and stock addition', async () => {
  const client = await pool.connect();
  const user = randomUUID();
  const engineer = randomUUID();
  const project = { id: randomUUID(), code: 'MONEY', name: 'Money project', owner_id: user };
  let existingQuantity;
  let writes;
  let generatedStatus;
  try {
    await client.query('BEGIN READ ONLY');
    mock.method(console, 'log', () => {});
    mock.method(taskPhases, 'replacePhases', async () => {});
    mock.method(taskPhases, 'withPhases', async task => ({ ...task, phases: ['Structural'] }));
    mock.method(pool, 'connect', async () => ({
      release() {},
      async query(sql, values) {
        if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql.trim())) return { rows: [] };
        if (/SELECT current_database/.test(sql)) return { rows: [] };
        if (/FROM projects p/.test(sql)) return { rows: [project] };
        if (/FROM users/.test(sql)) return { rows: [{ id: engineer, full_name: 'Engineer', role: 'Site Engineer' }] };
        if (/FROM project_members/.test(sql)) return { rows: [{ id: randomUUID() }] };
        if (/INSERT INTO tasks/.test(sql)) return { rows: [{ id: randomUUID(), status: 'Pending', progress_pct: 0, subtasks: [] }] };
        if (/pg_attribute/.test(sql)) return { rows: [{ is_generated: generatedStatus }] };
        if (/FROM resources/.test(sql)) {
          if (existingQuantity === null) return { rows: [] };
          // Execute the controller's actual NUMERIC addition against a read-only fixture.
          return client.query(`WITH resources AS (
            SELECT 1 AS id, $4::numeric AS quantity, 10::numeric AS min_threshold,
              $1::text AS name, $2::text AS project
          ) ${sql}`, [...values, existingQuantity]);
        }
        if (/INSERT INTO resources|UPDATE resources/.test(sql)) {
          writes.push({ sql, values });
          return { rows: [] };
        }
        if (/FROM tasks/.test(sql)) return { rows: [] };
        throw new Error(`Unexpected task query: ${sql}`);
      },
    }));
    for (generatedStatus of [false, true]) {
      for (const structured of [false, true]) {
        for (existingQuantity of [null, '10.25']) {
          writes = [];
          const res = {
            status(code) { this.code = code; return this; },
            json(body) { this.body = body; return this; },
          };
          await taskController.createTask({ user: { id: user }, body: {
            taskName: 'Task', phase: 'Structural', projectId: project.code, assigneeId: engineer,
            dueDate: '2099-01-01', priority: 'Medium', materialsRequired: '2.5 bags Cement', siteInstructions: 'Install',
            ...(structured ? { allocatedMaterials: [{ name: 'Cement', quantity: '2.5', unitPrice: '999.99' }] } : {}),
          } }, res);
          assert.equal(res.code, 201, JSON.stringify(res.body));
          assert.equal(writes.length, 1);
          const { sql, values } = writes[0];
          if (existingQuantity !== null) {
            assert.match(sql, /UPDATE resources/);
            assert.equal(values[0], '12.75');
          } else if (structured) {
            assert.equal(values[3], '2.5');
            assert.equal(values[6], '999.99');
          } else {
            assert.equal(values[1], '2.5');
          }
        }
      }
    }
  } finally {
    mock.restoreAll();
    await client.query('ROLLBACK');
    client.release();
  }
});

test.after(() => pool.end());
