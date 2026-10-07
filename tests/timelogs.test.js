const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const pool = require('../db');
const controller = require('../controllers/timelogController');
const service = require('../services/timelogService');

function response() {
  return { status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
}

test('creation succeeds without an incident flag and ignores obsolete incident payloads', async () => {
  const query = mock.method(pool, 'query', async (_sql, values) => ({ rows: [{ id: 1, project_name: values[0] }] }));
  mock.method(console, 'log', () => {});
  mock.method(console, 'table', () => {});
  try {
    const body = { project_name: 'MATIMCO FENCE', engineer_name: 'Kurt Paul Perocillo', date: '2026-10-07', total_work_hours: 8 };
    for (const extra of [{}, { has_incident: 'invalid obsolete flag', incident_description: { ignored: true }, incident_type: ['ignored'] }]) {
      const res = response();
      await controller.createTimelog({ user: { id: 'user' }, body: { ...body, ...extra } }, res);
      assert.equal(res.code, 201);
      assert.equal(res.body.success, true);
    }
    for (const call of query.mock.calls) {
      assert.doesNotMatch(call.arguments[0], /incident/i);
      assert.equal(call.arguments[1].length, 13);
      assert.equal(call.arguments[1][6], 8);
    }
  } finally { mock.restoreAll(); }
});

test('Time Log update fields ignore incident keys while preserving supported work fields', () => {
  assert.deepEqual(service.changesOf({ total_work_hours: 8, additional_notes: ' Work done ', has_incident: true,
    incident_description: 'Do not persist this', incident_severity: 'critical' }),
  { total_work_hours: '8', additional_notes: 'Work done' });
  assert.throws(() => service.changesOf({ has_incident: false }), { status: 400, message: 'No Time Log fields provided.' });
  assert.deepEqual(service.changesOf({ temperature: 31, work_on_site: '5', supervisors: 1, sub_contractors: 0 }),
    { temperature: '31°C', work_on_site: 5, supervisors: 1, sub_contractors: 0 });
  assert.deepEqual(service.changesOf({ weather: null, additional_notes: null }), { weather: null, additional_notes: null });
});

test('invalid work/time updates return validation errors', () => {
  for (const body of [{ project_name: '' }, { engineer_name: null }, { date: '2026-02-30' }, { date: 'invalid' },
    { work_on_site: 'description' }, { supervisors: -1 }, { sub_contractors: 1.5 }, { total_work_hours: {} },
    { temperature: {} }, { work_completed: [] }, { project_name: 'x'.repeat(256) }]) {
    assert.throws(() => service.changesOf(body), { status: 400 });
  }
});

test('new detail/update/delete routes reject missing authentication and malformed IDs before database access', async () => {
  const query = mock.method(pool, 'query', async () => { throw new Error('Unexpected query'); });
  try {
    for (const fn of [controller.getTimelogById, controller.updateTimelog, controller.deleteTimelog]) {
      const res = response();
      await fn({ params: {}, body: {} }, res);
      assert.equal(res.code, 401);
      await fn({ user: { id: 'user' }, params: { id: 'bad-id' }, body: { additional_notes: 'Updated' } }, res);
      assert.equal(res.code, 400);
    }
    assert.equal(query.mock.calls.length, 0);
  } finally { mock.restoreAll(); }
});

test.after(() => pool.end());
