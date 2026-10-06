const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const pool = require('../db');
const phases = require('../services/taskPhaseService');
const controller = require('../controllers/taskController');
const { createTaskDiagnostics } = require('../services/taskCreationDiagnostics');

test('one or multiple categories are trimmed and deduplicated without losing selections', () => {
  assert.deepEqual(phases.phasesOf({ phases: [' Structural '] }, true), ['Structural']);
  assert.deepEqual(phases.phasesOf({ phases: ['Site Development', ' Structural ', 'Structural', 'Construction Phase'] }, true),
    ['Site Development', 'Structural', 'Construction Phase']);
  assert.deepEqual(phases.phasesOf({ phases: phases.PHASES }, true), phases.PHASES);
});

test('missing, empty and unsupported categories are rejected', () => {
  for (const body of [{}, ...[null, undefined, [], '', 'Structural', {}, [''], [' '], [null], [42],
    ['Structural', 'Unsupported'], ['Foundation'], ['Finishing']].map(value => ({ phases: value }))]) {
    assert.throws(() => phases.phasesOf(body, true), { status: 400 });
  }
  assert.throws(() => phases.phasesOf({ phase: 'Foundation', phases: [] }, true), { status: 400 });
});

test('legacy scalar names map safely and explicit arrays take precedence', () => {
  for (const [input, expected] of [
    ['Foundation', 'Site Development'], ['Phase 1 - Foundation', 'Site Development'],
    ['Finishing', 'Architectural'], ['Phase 5 - Finishing', 'Architectural'],
    ['Phase 2 - Structural', 'Structural'], ['Phase 3 - Electrical & Utilities', 'Electrical & Utilities'],
    ['Phase 4 - Plumbing & MEP', 'Plumbing & MEP'],
  ]) assert.deepEqual(phases.phasesOf({ phase: ` ${input} ` }, true), [expected]);
  assert.deepEqual(phases.phasesOf({ phase: 'Foundation', phases: ['Architectural', 'Turnover Phase'] }, true), ['Architectural', 'Turnover Phase']);
});

test('unrelated partial updates do not request phase replacement', () => {
  assert.equal(phases.phasesOf({ task_name: 'New name' }), null);
});

test('category filters preserve case-insensitive legacy names and existing substring searches', () => {
  assert.equal(phases.filterValue(' foundation '), '%Site Development%');
  assert.equal(phases.filterValue('PHASE 5 - FINISHING'), '%Architectural%');
  assert.equal(phases.filterValue('electrical & utilities'), '%Electrical & Utilities%');
  assert.equal(phases.filterValue('Struct'), '%Struct%');
});

test('create and edit controllers reject unauthenticated and invalid phase requests before database access', async () => {
  const query = mock.method(pool, 'query', async () => { throw new Error('Unexpected database read'); });
  const connect = mock.method(pool, 'connect', async () => { throw new Error('Unexpected database write'); });
  const res = { status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  mock.method(console, 'log', () => {});
  try {
    for (const fn of [controller.createTask, controller.updateTask]) {
      await fn({ params: {}, body: {} }, res);
      assert.equal(res.code, 401);
      for (const value of [null, [], 'Structural', ['Unsupported'], ['']]) {
        await fn({ user: { id: 'user' }, params: {}, body: { task_name: 'Task', phases: value } }, res);
        assert.equal(res.code, 400);
        assert.equal(res.body.success, false);
        assert.equal(typeof res.body.message, 'string');
      }
    }
    await controller.createTask({ user: { id: 'user' }, body: { task_name: 'Task' }, params: {} }, res);
    assert.equal(res.code, 400);
    assert.equal(query.mock.calls.length, 0);
    assert.equal(connect.mock.calls.length, 0);
  } finally { mock.restoreAll(); }
});

test('task creation diagnostics retain exact failing SQL and full PostgreSQL context through rollback failures', async () => {
  const logs = mock.method(console, 'log', () => {});
  const errors = mock.method(console, 'error', () => {});
  const sql = 'INSERT INTO resources (name, status) VALUES ($1, $2)';
  const failure = Object.assign(new Error('cannot insert a non-DEFAULT value into column "status"'), {
    code: '428C9', table: undefined, schema: undefined, column: undefined, constraint: undefined,
    detail: 'Column "status" is a generated column.', where: undefined, routine: 'rewriteTargetListIU',
  });
  const diagnostics = createTaskDiagnostics();
  const db = diagnostics.wrap({ query: async statement => { if (statement === sql) throw failure; throw new Error('Rollback failed'); } });
  try {
    await assert.rejects(db.query(sql, ['Private material name', 'Low stock']), failure);
    await assert.rejects(db.query('ROLLBACK'), /Rollback failed/);
    diagnostics.logError(failure);
    const details = errors.mock.calls[0].arguments[0];
    assert.equal(details.sql, sql);
    assert.equal(details.operation, 'inserting materials/resources');
    for (const key of ['message', 'code', 'table', 'schema', 'column', 'constraint', 'detail', 'where', 'routine']) {
      assert.ok(Object.hasOwn(details, key));
      assert.equal(details[key], failure[key]);
    }
    assert.equal(logs.mock.calls[0].arguments[0], '[CREATE TASK] inserting materials/resources');
    assert.equal(logs.mock.calls[1].arguments[0], '[CREATE TASK] rolling back transaction');
    assert.ok(!JSON.stringify([...logs.mock.calls, ...errors.mock.calls]).includes('Private material name'));
  } finally { mock.restoreAll(); }
});

test.after(() => pool.end());
