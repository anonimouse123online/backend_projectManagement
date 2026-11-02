'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateSchedule } = require('../services/taskScheduleService');
const taskController = require('../controllers/taskController');

const project = { id: 'project-1', start_date: '2026-10-01', end_date: '2026-12-31' };

function fakeDb({ holidays = [], predecessors = [], overlaps = [] } = {}) {
  return {
    async query(sql) {
      if (sql.includes('FROM project_holidays')) return { rows: holidays.map(day => ({ day })) };
      if (sql.includes('SELECT id::text, task_name')) return { rows: predecessors };
      if (sql.includes('SELECT task_name, due_date')) return { rows: overlaps };
      if (sql.includes('WITH RECURSIVE')) return { rows: [] };
      throw new Error(`Unexpected SQL: ${sql}`);
    }
  };
}

test('validateSchedule exposes overlappingTasks and flags workload warning when assignee is booked', async () => {
  const overlap = await validateSchedule({
    db: fakeDb({ overlaps: [{ task_name: 'Excavation Inspection', due_date: '2026-10-29' }] }),
    project,
    startDate: '2026-10-26',
    dueDate: '2026-10-30',
    assigneeId: 'worker'
  });

  assert.equal(overlap.status, 'WARNING');
  assert.ok(overlap.warnings.some(m => /overlapping task/.test(m)));
  assert.ok(Array.isArray(overlap.overlappingTasks));
  assert.equal(overlap.overlappingTasks[0].task_name, 'Excavation Inspection');
});

test('getAssigneeWorkload rejects requests with missing or invalid assigneeId', async () => {
  // Test missing assigneeId
  let status1 = null;
  let json1 = null;
  const req1 = {
    user: { id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' },
    query: {}
  };
  const res1 = {
    status(code) { status1 = code; return this; },
    json(data) { json1 = data; return this; }
  };

  await taskController.getAssigneeWorkload(req1, res1);
  assert.equal(status1, 400);
  assert.match(json1.error, /Assignee ID is required/);

  // Test invalid UUID
  let status2 = null;
  let json2 = null;
  const req2 = {
    user: { id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' },
    query: { assigneeId: 'not-a-valid-uuid' }
  };
  const res2 = {
    status(code) { status2 = code; return this; },
    json(data) { json2 = data; return this; }
  };

  await taskController.getAssigneeWorkload(req2, res2);
  assert.equal(status2, 400);
  assert.match(json2.error, /Invalid assignee ID format/);
});
