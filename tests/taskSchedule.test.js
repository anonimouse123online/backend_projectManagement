'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateSchedule, workingDays, completionDate } = require('../services/taskScheduleService');

const project = { id: 'project-1', start_date: '2026-10-01', end_date: '2026-12-31' };
function fakeDb({ holidays = [], predecessors = [], overlaps = [] } = {}) {
  return { async query(sql) {
    if (sql.includes('FROM project_holidays')) return { rows: holidays.map(day => ({ day })) };
    if (sql.includes('SELECT id::text, task_name')) return { rows: predecessors };
    if (sql.includes('SELECT task_name, due_date')) return { rows: overlaps };
    if (sql.includes('WITH RECURSIVE')) return { rows: [] };
    throw new Error(`Unexpected SQL: ${sql}`);
  } };
}

test('rejects reversed dates and project boundary violations', async () => {
  const reversed = await validateSchedule({ db: fakeDb(), project, startDate: '2026-10-30', dueDate: '2026-10-26' });
  assert.equal(reversed.status, 'INVALID');
  assert.match(reversed.errors[0], /cannot be after/);
  const outside = await validateSchedule({ db: fakeDb(), project, startDate: '2026-09-30', dueDate: '2026-10-02' });
  assert.equal(outside.status, 'INVALID');
});

test('normalizes PostgreSQL DATE values supplied as Date objects without shifting the calendar day', async () => {
  const { dateOnlyString, parseDate } = require('../services/taskScheduleService');
  const stored = new Date(2099, 11, 31);
  assert.equal(dateOnlyString(stored), '2099-12-31');
  assert.equal(parseDate(stored).toISOString().slice(0, 10), '2099-12-31');
});

test('counts weekdays and configured holidays; flags insufficient estimated duration', async () => {
  assert.equal(workingDays(new Date('2026-10-26T00:00:00Z'), new Date('2026-10-30T00:00:00Z'), new Set(['2026-10-28'])), 4);
  const result = await validateSchedule({ db: fakeDb({ holidays: ['2026-10-28'] }), project,
    startDate: '2026-10-26', dueDate: '2026-10-30', estimatedDurationDays: 8 });
  assert.equal(result.status, 'INVALID');
  assert.equal(result.availableWorkingDays, 4);
  assert.match(result.errors[0], /requires an estimated 8 working days/);
  assert.equal(result.suggestions[0].dueDate, '2026-11-05');
});

test('revised finish suggestion respects weekends and holidays, including non-working starts', () => {
  assert.equal(completionDate(new Date('2026-10-26T00:00:00Z'), 8, new Set(['2026-10-28'])).toISOString().slice(0, 10), '2026-11-05');
  assert.equal(completionDate(new Date('2026-10-31T00:00:00Z'), 1, new Set()).toISOString().slice(0, 10), '2026-11-02');
});

test('checks configured predecessor dates and suggests next working date', async () => {
  const result = await validateSchedule({ db: fakeDb({ predecessors: [{ id: 'pre', task_name: 'Foundation', due_date: '2026-10-28' }] }),
    project, startDate: '2026-10-26', dueDate: '2026-10-30', predecessorIds: ['pre'] });
  assert.equal(result.status, 'INVALID');
  assert.match(result.errors[0], /Foundation is scheduled to finish on 2026-10-28/);
  assert.equal(result.suggestions[0].startDate, '2026-10-29');
});

test('missing duration remains insufficient data and resource overlap is only a warning', async () => {
  const missing = await validateSchedule({ db: fakeDb(), project, startDate: '2026-10-26', dueDate: '2026-10-30' });
  assert.equal(missing.status, 'INSUFFICIENT_DATA');
  const overlap = await validateSchedule({ db: fakeDb({ overlaps: [{ task_name: 'Inspection', due_date: '2026-10-29' }] }),
    project, startDate: '2026-10-26', dueDate: '2026-10-30', assigneeId: 'worker' });
  assert.equal(overlap.status, 'WARNING');
  assert.ok(overlap.warnings.some(message => /overlapping task/.test(message)));
});
