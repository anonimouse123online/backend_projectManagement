const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const pool = require('../db');

for (const idType of ['SERIAL', 'UUID DEFAULT gen_random_uuid()']) {
  test(`incident-free Time Log CRUD and migration preserve historical records (${idType})`, async () => {
    const client = await pool.connect();
    const schema = `timelogs_test_${randomUUID().replaceAll('-', '')}`;
    let server;
    try {
      await client.query('BEGIN');
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET LOCAL search_path TO "${schema}", public`);
      await client.query(`CREATE TABLE projects (id UUID PRIMARY KEY, code TEXT UNIQUE, name TEXT, owner_id UUID);
        CREATE TABLE project_members (project_id TEXT, user_id UUID);
        CREATE TABLE time_logs (id ${idType} PRIMARY KEY, project_name VARCHAR(255) NOT NULL,
          engineer_name VARCHAR(255) NOT NULL, date DATE NOT NULL, work_on_site INTEGER NOT NULL DEFAULT 0,
          supervisors INTEGER NOT NULL DEFAULT 0, sub_contractors INTEGER NOT NULL DEFAULT 0,
          total_work_hours VARCHAR(50) NOT NULL DEFAULT '0h', weather VARCHAR(50), temperature VARCHAR(50),
          work_completed TEXT, materials_delivered TEXT, equipment_used TEXT, additional_notes TEXT,
          has_incident BOOLEAN NOT NULL DEFAULT FALSE CHECK (has_incident IN (TRUE, FALSE)),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
        CREATE FUNCTION touch_timelog() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$;
        CREATE TRIGGER timelog_updated_at BEFORE UPDATE ON time_logs FOR EACH ROW EXECUTE FUNCTION touch_timelog();`);
      const owner = { id: randomUUID(), role: 'Project Manager' };
      const engineer = { id: randomUUID(), role: 'Site Engineer' };
      const outsider = { id: randomUUID(), role: 'Site Engineer' };
      for (const [code, name, user] of [['TEST-FENCE', 'MATIMCO FENCE', owner], ['TEST-OTHER', 'Other project', outsider]]) {
        await client.query('INSERT INTO projects VALUES ($1,$2,$3,$4)', [randomUUID(), code, name, user.id]);
      }
      await client.query('INSERT INTO project_members VALUES ($1,$2)', ['TEST-FENCE', engineer.id]);
      const historical = (await client.query(`INSERT INTO time_logs
        (project_name, engineer_name, date, work_completed, has_incident)
        VALUES ('MATIMCO FENCE', 'Historical Engineer', '2026-10-06', 'Old work record', TRUE) RETURNING *`)).rows[0];
      const migration = fs.readFileSync(path.join(__dirname, '../migrations/timelog_remove_incidents.sql'), 'utf8');
      // External dependencies must block dropping the flag rather than be deleted by CASCADE.
      await client.query('CREATE VIEW old_incident_consumer AS SELECT id, has_incident FROM time_logs');
      await client.query('SAVEPOINT migration_dependency');
      await assert.rejects(client.query(migration), { code: '2BP01' });
      await client.query('ROLLBACK TO SAVEPOINT migration_dependency');
      assert.equal((await client.query('SELECT COUNT(*)::int AS count FROM old_incident_consumer')).rows[0].count, 1);
      await client.query('DROP VIEW old_incident_consumer');

      const query = mock.method(pool, 'query', (sql, params) => client.query(sql, params));
      mock.method(console, 'log', () => {});
      mock.method(console, 'table', () => {});
      const app = express();
      app.use(express.json());
      app.use(require('../middlewares/authMiddleware').verifyToken);
      app.use('/timelogs', require('../routes/timelog'));
      server = app.listen(0, '127.0.0.1');
      await new Promise(resolve => server.once('listening', resolve));
      const root = `http://127.0.0.1:${server.address().port}`;
      async function request(url, method = 'GET', body, user = engineer) {
        const result = await fetch(root + url, { method, headers: {
          ...(user ? { Authorization: `Bearer ${jwt.sign(user, process.env.JWT_SECRET)}` } : {}),
          'Content-Type': 'application/json',
        }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        return { status: result.status, body: await result.json() };
      }
      const body = { project_name: 'MATIMCO FENCE', engineer_name: 'Kurt Paul Perocillo', date: '2026-10-07',
        work_on_site: 5, supervisors: 1, sub_contractors: 2, total_work_hours: 8, weather: 'Sunny', temperature: 31,
        work_completed: 'Fence foundation preparation', materials_delivered: 'Cement', equipment_used: 'Mixer', additional_notes: 'Work done' };
      // Updated API also works during rollout while the old flag still exists.
      let result = await request('/timelogs', 'POST', body);
      assert.equal(result.status, 201, JSON.stringify(result.body));
      assert.equal(Object.hasOwn(result.body.data, 'has_incident'), false);
      assert.equal((await request('/timelogs')).status, 200);

      await client.query(migration);
      await client.query(migration);
      assert.equal((await client.query(`SELECT COUNT(*)::int AS count FROM information_schema.columns
        WHERE table_schema=$1 AND table_name='time_logs' AND column_name='has_incident'`, [schema])).rows[0].count, 0);
      const { has_incident: _oldFlag, ...preserved } = historical;
      assert.deepEqual((await client.query('SELECT * FROM time_logs WHERE id=$1', [historical.id])).rows[0], preserved);

      for (const extra of [{}, { has_incident: 'not a boolean', incident_description: { ignored: true }, incident_severity: ['ignored'] }]) {
        result = await request('/timelogs', 'POST', { ...body, ...extra });
        assert.equal(result.status, 201, JSON.stringify(result.body));
        assert.equal(result.body.data.date, body.date);
        assert.equal(result.body.data.total_work_hours, '8');
        assert.equal(result.body.data.temperature, '31°C');
        assert.equal(Object.hasOwn(result.body.data, 'has_incident'), false);
        const id = result.body.data.id;
        result = await request(`/timelogs/${id}`);
        assert.equal(result.status, 200);
        assert.equal(result.body.data.work_completed, body.work_completed);
        assert.equal((await request(`/timelogs/${id}`, 'GET', undefined, outsider)).status, 404);
        assert.equal((await request(`/timelogs/${id}`, 'PATCH', { additional_notes: 'Spoofed' }, outsider)).status, 404);
        assert.equal((await request(`/timelogs/${id}`, 'DELETE', undefined, outsider)).status, 404);
        assert.equal((await request(`/timelogs/${id}`, 'PATCH', { project_name: 'Other project' })).status, 404);
        for (const method of ['PATCH', 'PUT']) {
          result = await request(`/timelogs/${id}`, method, { total_work_hours: 9, additional_notes: 'Updated', ...extra });
          assert.equal(result.status, 200, JSON.stringify(result.body));
          assert.equal(result.body.data.total_work_hours, '9');
          assert.equal(result.body.data.work_completed, body.work_completed);
          assert.equal(Object.hasOwn(result.body.data, 'has_incident'), false);
        }
        assert.equal((await request(`/timelogs/${id}`, 'PATCH', { has_incident: true })).status, 400);
        assert.equal((await request(`/timelogs/${id}`, 'PATCH', { date: '2026-02-30' })).status, 400);
        result = await request(`/timelogs/${id}`, 'DELETE', undefined, owner);
        assert.equal(result.status, 200);
        assert.equal((await request(`/timelogs/${id}`)).status, 404);
      }
      result = await request('/timelogs?date=2026-10-06&engineer=Historical&search=Old');
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(result.body.count, 1);
      assert.equal(result.body.data[0].id, historical.id);
      assert.equal(Object.hasOwn(result.body.data[0], 'has_incident'), false);
      assert.equal((await request('/timelogs', 'GET', undefined, outsider)).body.count, 0);
      for (const method of ['GET', 'PATCH', 'DELETE']) {
        assert.equal((await request(`/timelogs/${historical.id}`, method, method === 'PATCH' ? { additional_notes: 'Updated' } : undefined, null)).status, 401);
      }
      assert.equal((await request('/timelogs', 'POST', body, null)).status, 401);
      assert.equal((await request('/timelogs', 'POST', { date: body.date })).status, 400);
      assert.equal((await request('/timelogs', 'POST', { project_name: body.project_name })).status, 400);
      assert.ok(query.mock.calls.every(call => !/incident/i.test(call.arguments[0])));
    } finally {
      if (server) await new Promise(resolve => server.close(resolve));
      mock.restoreAll();
      await client.query('ROLLBACK');
      client.release();
    }
  });
}

test.after(() => pool.end());
