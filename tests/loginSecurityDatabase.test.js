const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const pool = require('../db');
const { recordLoginSecurityEvent } = require('../services/loginSecurityService');
const { validateSecurityContext } = require('../services/loginSecurityContext');

test('PostgreSQL migration, real event history, constraints and account deletion', async () => {
  // Everything, including the schema, is rolled back. Never touch public users
  // or public login logs, and never put credentials/tokens into fixtures.
  const client = await pool.connect();
  const schema = `login_security_test_${randomUUID().replaceAll('-', '')}`;
  try {
    await client.query('BEGIN');
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET LOCAL search_path TO "${schema}"`);
    await client.query('CREATE TABLE users (id UUID PRIMARY KEY)');
    const sql = fs.readFileSync(path.join(__dirname, '../migrations/login_security_logs.sql'), 'utf8');
    await client.query(sql);
    await client.query(sql);
    const user = { id: randomUUID(), full_name: 'Audit Test', email: 'audit@example.test', role: 'admin' };
    await client.query('INSERT INTO users VALUES ($1)', [user.id]);
    mock.method(pool, 'connect', async () => ({
      query: (query, values) => client.query(
        query === 'BEGIN' ? 'SAVEPOINT audit_event' :
        query === 'COMMIT' ? 'RELEASE SAVEPOINT audit_event' :
        query === 'ROLLBACK' ? 'ROLLBACK TO SAVEPOINT audit_event' : query, values),
      release() {},
    }));
    const context = validateSecurityContext({ user_agent: 'Known Browser', location_permission_status: 'DENIED' });
    const args = { req: { ip: '::ffff:192.0.2.1' }, user, email: user.email, context, eventType: 'LOGIN_SUCCESS' };
    assert.equal((await recordLoginSecurityEvent(args)).security_status, 'NORMAL');
    assert.equal((await recordLoginSecurityEvent(args)).security_status, 'NORMAL');
    const changed = await recordLoginSecurityEvent({ ...args, req: { ip: '192.0.2.2' }, context: { ...context, user_agent: 'New Browser' } });
    assert.equal(changed.security_status, 'NEEDS_REVIEW');
    assert.match(changed.security_reason, /New IP address/);
    assert.match(changed.security_reason, /unseen user-agent/);
    for (let i = 1; i <= 5; i++) {
      const result = await recordLoginSecurityEvent({ ...args, user: undefined, email: 'unknown@example.test', eventType: 'LOGIN_FAILED' });
      assert.equal(result.security_status, i === 5 ? 'SUSPICIOUS' : 'NORMAL');
    }
    assert.equal((await recordLoginSecurityEvent({ ...args, eventType: 'LOGOUT' })).security_status, 'NORMAL');
    const stored = await client.query('SELECT * FROM login_security_logs ORDER BY id');
    assert.equal(stored.rows.length, 9);
    assert.equal(stored.rows[0].ip_address, '192.0.2.1');
    assert.equal(stored.rows[0].latitude, null);
    assert.equal(stored.rows[3].user_id, null);
    assert.ok(stored.rows[0].created_at instanceof Date);
    assert.equal(typeof stored.rows[0].id, 'string');

    await client.query('SAVEPOINT constraint_check');
    await assert.rejects(client.query(`INSERT INTO login_security_logs
      (email,event_type,login_status,security_status,latitude,longitude,location_permission_status)
      VALUES ('invalid@example.test','LOGIN_SUCCESS','SUCCESS','NORMAL',91,123,'GRANTED')`), { code: '23514' });
    await client.query('ROLLBACK TO SAVEPOINT constraint_check');
    await assert.rejects(client.query(`INSERT INTO login_security_logs
      (email,event_type,login_status,security_status,latitude,longitude)
      VALUES ('invalid@example.test','LOGIN_SUCCESS','SUCCESS','NORMAL',10,123)`), { code: '23514' });
    await client.query('ROLLBACK TO SAVEPOINT constraint_check');

    await client.query('DELETE FROM users WHERE id = $1', [user.id]);
    const retained = await client.query('SELECT user_id,user_name,email,role FROM login_security_logs WHERE id=$1', [stored.rows[0].id]);
    assert.equal(retained.rows[0].user_id, null);
    assert.equal(retained.rows[0].user_name, user.full_name);
    assert.equal(retained.rows[0].email, user.email);
  } finally {
    mock.restoreAll();
    await client.query('ROLLBACK');
    client.release();
    await pool.end();
  }
});
