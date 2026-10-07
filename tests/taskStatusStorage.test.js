const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const pool = require('../db');
const controller = require('../controllers/taskController');
const service = require('../services/taskWorkStatusService');

// Exercise the real controllers without opening a database connection or changing records.
// The adapter rejects task-column values outside the confirmed live lifecycle CHECK.
const allowed = new Set(['Pending', 'In Progress', 'Completed', 'Cancelled']);
const ownerId = '00000000-0000-4000-8000-000000000001';
const engineerId = '00000000-0000-4000-8000-000000000002';
const projectId = '00000000-0000-4000-8000-000000000003';
const taskId = '00000000-0000-4000-8000-000000000004';

function fixture() {
  const state = {
    task: { id: taskId, project_id: projectId, assignee_id: engineerId, status: 'Pending',
      progress_pct: 35, subtasks: [{ id: 'a', title: 'Excavation', completed: false, status: 'ongoing', progress: 60 }] },
    phases: [], taskWrites: [], projectWrites: 0,
  };
  const query = async (statement, values) => {
    const sql = statement.replace(/\s+/g, ' ').trim();
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [] };
    if (sql.startsWith('SELECT current_database()')) return { rows: [{ current_database: 'in-memory fixture' }] };
    if (sql.includes('pg_attribute')) return { rows: [{ is_generated: true }] };
    if (sql.includes('FROM projects p') && !sql.includes('FROM tasks t')) {
      return { rows: [{ id: projectId, code: 'FIXTURE', name: 'Fixture project', owner_id: ownerId }] };
    }
    if (sql.includes('FROM users')) return { rows: [{ id: engineerId, full_name: 'Engineer', role: 'Site Engineer' }] };
    if (sql.includes('FROM project_members') && !sql.includes('FROM tasks t')) return { rows: [{ id: 1 }] };
    if (sql.startsWith('INSERT INTO tasks ')) {
      assert.ok(allowed.has(values[8]), `Rejected task status: ${values[8]}`);
      state.task = { id: taskId, task_name: values[0], phase: values[1], assignee_id: values[2],
        due_date: values[3], priority: values[4], materials_required: values[5], site_instructions: values[6],
        project_id: values[7], status: values[8], subtasks: JSON.parse(values[9]), progress_pct: values[10] };
      state.taskWrites.push(values[8]);
      return { rows: [structuredClone(state.task)] };
    }
    if (sql.startsWith('DELETE FROM task_phases')) { state.phases = []; return { rows: [] }; }
    if (sql.startsWith('INSERT INTO task_phases')) { state.phases = [...values[1]]; return { rows: [] }; }
    if (sql.includes('jsonb_agg')) return { rows: [{ phases: state.phases }] };
    if (sql.includes('FROM tasks t')) {
      return { rows: [{ ...structuredClone(state.task), owner_id: ownerId, project_status: 'Ongoing' }] };
    }
    if (sql.startsWith('SELECT * FROM tasks') || sql.startsWith('SELECT id, status, progress_pct, subtasks')) {
      return { rows: [structuredClone(state.task)] };
    }
    if (sql.startsWith('UPDATE tasks SET status = COALESCE')) {
      if (values[0] !== null) {
        assert.ok(allowed.has(values[0]), `Rejected task status: ${values[0]}`);
        state.task.status = values[0];
      }
      if (values[1] !== null) state.task.progress_pct = values[1];
      if (values[2] !== null) state.task.subtasks = JSON.parse(values[2]);
      state.taskWrites.push(values[0]);
      return { rows: [structuredClone(state.task)] };
    }
    if (sql.startsWith('UPDATE projects')) { state.projectWrites++; return { rows: [] }; }
    if (sql.includes('FROM resources') || sql.startsWith('INSERT INTO resources')) return { rows: [] };
    throw new Error(`Unexpected fixture query: ${sql}`);
  };
  mock.method(pool, 'connect', async () => ({ query, release() {} }));
  mock.method(pool, 'query', query);
  mock.method(console, 'log', () => {});
  mock.method(console, 'error', () => {});
  return state;
}

function response() {
  return { status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
}

test('one storage mapping preserves API work values and existing terminal storage', () => {
  for (const [input, stored] of [['pending', 'Pending'], ['Pending', 'Pending'], ['ongoing', 'In Progress'],
    ['In Progress', 'In Progress'], ['completed', 'Completed'], ['done', 'Completed'], ['cancelled', 'Cancelled']]) {
    assert.equal(service.databaseStatus(input), stored);
    assert.equal(service.displayStatus(stored), service.displayStatus(input === 'done' ? 'completed' : input));
  }
  assert.throws(() => service.databaseStatus('working123'), { status: 400 });
});

test('Create Task succeeds at zero, partial and complete progress with legacy-compatible SQL status', async () => {
  for (const [subtasks, status, progress, apiStatus] of [
    [[], 'Pending', 0, 'pending'],
    [[{ id: 'a', title: 'Excavation', completed: true }, { id: 'b', title: 'Rebar', completed: false }], 'In Progress', 50, 'ongoing'],
    [[{ id: 'a', title: 'Excavation', completed: true }], 'Completed', 100, 'completed'],
  ]) {
    const state = fixture();
    const res = response();
    try {
      await controller.createTask({ user: { id: ownerId }, body: {
        taskName: 'Fence foundation', projectId, assigneeId: engineerId, dueDate: '2099-01-01',
        priority: 'Medium', materialsRequired: 'Concrete', siteInstructions: 'Prepare foundation',
        construction_phase_categories: ['Site Development', 'Structural'], subtasks,
      } }, res);
      assert.equal(res.code, 201, JSON.stringify(res.body));
      assert.deepEqual(state.taskWrites, [status]);
      assert.equal(state.task.status, status);
      assert.equal(state.task.progress_pct, progress);
      assert.equal(res.body.data.status, apiStatus);
      assert.equal(res.body.data.progress, progress);
      assert.deepEqual(state.phases, ['Site Development', 'Structural']);
    } finally { mock.restoreAll(); }
  }
});

test('PATCH status maps SQL values, preserves independent progress, and retains completion/cancellation', async () => {
  for (const [body, stored, progress, apiStatus] of [
    [{ status: 'pending' }, 'Pending', 35, 'pending'],
    [{ status: 'ongoing' }, 'In Progress', 35, 'ongoing'],
    [{ progress: 45 }, 'In Progress', 45, 'ongoing'],
    [{ status: 'completed' }, 'Completed', 100, 'completed'],
    [{ status: 'cancelled' }, 'Cancelled', 35, 'cancelled'],
  ]) {
    const state = fixture();
    state.task.status = body.status === 'pending' || body.status === undefined ? 'In Progress' : 'Pending';
    const subtasksBefore = structuredClone(state.task.subtasks);
    const res = response();
    try {
      await controller.updateTaskStatus({ user: { id: engineerId, role: 'Site Engineer' }, params: { id: taskId }, body }, res);
      assert.equal(res.code, 200, JSON.stringify(res.body));
      assert.equal(state.task.status, stored);
      assert.equal(state.task.progress_pct, progress);
      assert.equal(res.body.data.status, apiStatus);
      assert.equal(res.body.data.progress, progress);
      if (body.status !== 'completed') assert.deepEqual(state.task.subtasks, subtasksBefore);
      else assert.ok(state.task.subtasks.every(item => item.completed && item.progress === 100));
      if (['pending', 'ongoing', 'cancelled'].includes(body.status)) assert.equal(state.projectWrites, 0);
    } finally { mock.restoreAll(); }
  }
});

test.after(() => pool.end());
