const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const pool = require('../db');
const service = require('../services/taskWorkStatusService');
const controller = require('../controllers/taskController');

test('status normalization accepts deliberate legacy aliases and rejects invalid work values', () => {
  for (const value of ['pending', 'Pending', ' PENDING ']) assert.equal(service.workStatus(value), 'pending');
  for (const value of ['ongoing', 'Ongoing', 'In Progress', 'in-progress']) assert.equal(service.workStatus(value), 'ongoing');
  for (const value of ['working123', 'on going', '', null, undefined, 12, []]) {
    assert.throws(() => service.workStatus(value), { status: 400 });
  }
  for (const state of ['Completed', 'Cancelled', 'Verified', 'Closed']) assert.equal(service.statusValue(state), state.toLowerCase());
});

test('serializers expose independent status and progress while preserving original percentage fields', () => {
  const task = { status: 'Pending', progress_pct: 35, subtasks: [
    { id: 'a', title: 'Excavation', status: 'In Progress', progress: 60, completed: false },
    { id: 'b', title: 'Rebar', completed: false }, { id: 'c', title: 'Survey', completed: true },
  ] };
  const original = structuredClone(task);
  const response = service.taskFields(task);
  assert.equal(response.status, 'pending');
  assert.equal(response.progress, 35);
  assert.equal(response.progress_pct, 35);
  assert.deepEqual(response.subtasks.map(item => [item.status, item.progress]), [['ongoing', 60], ['pending', 0], ['completed', 100]]);
  assert.deepEqual(task, original);
  assert.equal(service.taskFields({ status: null, progress_pct: 45 }).status, 'pending');
});

test('old full-array payloads preserve omitted status/progress and still support completion and reopening', () => {
  const current = [{ id: 'a', title: 'Excavation', status: 'ongoing', progress: 60, completed: false, detail: 'Preserved' }];
  const result = service.mergeSubtasks(current, [{ id: 'a', title: 'Excavation', completed: false }]);
  assert.deepEqual(result, current);
  assert.deepEqual(service.mergeSubtasks([], [{ title: 'New', completed: false, status: 'ongoing', progress: 60 }])
    .map(({ status, progress }) => ({ status, progress })), [{ status: 'ongoing', progress: 60 }]);
  const done = service.mergeSubtasks(current, [{ ...current[0], completed: true }]);
  assert.equal(done[0].status, 'completed');
  assert.equal(done[0].progress, 100);
  const reopened = service.mergeSubtasks(done, [{ ...done[0], completed: false }]);
  assert.equal(reopened[0].status, 'pending');
  assert.equal(reopened[0].progress, 0);
  assert.throws(() => service.mergeSubtasks(current, [{ ...current[0], status: 'working123' }]), { status: 400 });
});

test('invalid status/progress updates and unauthenticated requests fail before any database write', async () => {
  const connect = mock.method(pool, 'connect', async () => { throw new Error('Unexpected connection'); });
  const res = { status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  try {
    for (const fn of [controller.updateTaskStatus, controller.updateTaskSubtasks, controller.completeTask]) {
      await fn({ params: {}, body: {} }, res);
      assert.equal(res.code, 401);
    }
    for (const body of [{ status: 'working123' }, { status: null }, { status: [] }, { progress: -1 },
      { progress: 101 }, { progress: null }, { progress: 20.5 }, { status: 'ongoing', progress: 35, progress_pct: 45 }, {}]) {
      await controller.updateTaskStatus({ user: { id: 'user' }, params: { id: 'task' }, body }, res);
      assert.equal(res.code, 400);
    }
    await controller.updateTaskSubtasks({ user: { id: 'user' }, params: { id: 'task' }, body: { subtask_id: 'a', status: 'working123' } }, res);
    assert.equal(res.code, 400);
    assert.equal(connect.mock.calls.length, 0);
  } finally { mock.restoreAll(); }
});

test.after(() => pool.end());
