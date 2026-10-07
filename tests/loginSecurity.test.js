const { test, before, after, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
process.env.JWT_SECRET = 'login-security-test-secret';
const pool = require('../db');
const { configureTrustedProxy } = require('../configuration/trustedProxy');
const { validateSecurityContext, normalizeIp } = require('../services/loginSecurityContext');
const { evaluateSecurity } = require('../services/loginSecurityService');
const { parseLogFilters } = require('../controllers/loginSecurityController');

const user = {
  id: '11111111-1111-4111-8111-111111111111', full_name: 'Test Admin',
  email: 'admin@example.test', role: 'admin', password_hash: bcrypt.hashSync('test-password', 4),
};
let selectedUser, currentRole, auditFails, inserts, queryCalls, server, base;
let history;

before(async () => {
  mock.method(pool, 'query', async (sql, values) => {
    queryCalls.push({ sql, values });
    if (sql.includes('SELECT *') && sql.includes('FROM users')) return { rows: selectedUser ? [{ ...selectedUser }] : [] };
    if (sql.includes('SELECT id, full_name')) return { rows: currentRole ? [{ ...user, role: currentRole }] : [] };
    if (sql.includes('COUNT(*) AS total')) return { rows: [{ total: '1' }] };
    if (sql.includes('login_security_logs')) return { rows: values?.[0] === '999' ? [] : [{
      id: '1', user_id: user.id, latitude: '10.123456', longitude: '123.123456', location_accuracy: '25',
      security_status: 'NORMAL', created_at: new Date('2026-10-03T12:00:00Z'),
    }] };
    throw new Error(`Unexpected query: ${sql}`);
  });
  mock.method(pool, 'connect', async () => {
    if (auditFails) throw Object.assign(new Error('Test outage'), { code: 'TEST_OUTAGE' });
    return {
      query: async (sql, values) => {
        if (sql.includes('AS failed_count')) return { rows: [history] };
        if (sql.includes('SELECT latitude')) return { rows: [] };
        if (sql.includes('INSERT INTO')) {
          inserts.push(values);
          return { rows: [{ id: '1', security_status: values[14], security_flag: values[15], security_reason: values[16] }] };
        }
        return { rows: [] };
      }, release() {},
    };
  });
  const app = express();
  configureTrustedProxy(app, '');
  app.use(express.json());
  app.use('/auth', require('../routes/auth'));
  app.use('/security', require('../routes/security'));
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => {
  selectedUser = user; currentRole = 'admin'; auditFails = false; inserts = []; queryCalls = [];
  history = { now: new Date(), failed_count: '0', has_history: false, has_ip: false, has_device: false };
});
after(async () => { await new Promise(resolve => server.close(resolve)); mock.restoreAll(); await pool.end(); });

async function login(body = {}, headers = {}) {
  const response = await fetch(`${base}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ email: user.email, password: 'test-password', ...body }),
  });
  return { status: response.status, body: await response.json() };
}
const token = role => jwt.sign({ id: user.id, role, email: user.email }, process.env.JWT_SECRET, { expiresIn: '7d' });

test('admin login preserves response/JWT and ignores forged identity/IP/secrets', async () => {
  const result = await login({ security_context: {
    latitude: 10.123456, longitude: 123.123456, location_accuracy: 25,
    location_permission_status: 'GRANTED', user_agent: 'Test Browser', platform: 'Win32', language: 'en-US',
    ip_address: '203.0.113.9', user_name: 'Forged', role: 'engineer', password: 'never-store', token: 'never-store',
  } }, { 'X-Forwarded-For': '198.51.100.5', 'CF-Connecting-IP': '198.51.100.6' });
  assert.equal(result.status, 200);
  assert.equal(result.body.message, 'Login successful.');
  assert.equal(result.body.redirectTo, '/admin/dashboard');
  assert.deepEqual(result.body.user, { id: user.id, name: user.full_name, email: user.email, role: user.role });
  const claims = jwt.verify(result.body.token, process.env.JWT_SECRET);
  assert.equal(claims.exp - claims.iat, 7 * 24 * 3600);
  assert.equal(result.body.security_status, 'NORMAL');
  assert.equal(result.body.security_audit_available, true);
  assert.equal(inserts[0][1], user.full_name);
  assert.equal(inserts[0][3], 'admin');
  assert.equal(inserts[0][6], '127.0.0.1');
  assert.ok(!JSON.stringify(inserts).includes('never-store'));
  assert.ok(!JSON.stringify(inserts).includes('test-password'));
});

test('engineer login without security_context remains compatible', async () => {
  selectedUser = { ...user, role: 'engineer' };
  const result = await login();
  assert.equal(result.status, 200);
  assert.equal(result.body.redirectTo, '/engineer/dashboard');
  assert.equal(result.body.user.role, 'engineer');
  assert.equal(inserts[0][10], null);
});

test('denied/unavailable/timeout locations accept null coordinates', async () => {
  for (const permission of ['DENIED', 'UNAVAILABLE', 'TIMEOUT']) {
    assert.equal((await login({ security_context: {
      location_permission_status: permission, latitude: null, longitude: null, location_accuracy: null,
    } })).status, 200);
    assert.equal(inserts.at(-1)[7], null);
    assert.equal(inserts.at(-1)[10], permission);
  }
});

test('known and unknown account failures return identical errors and create failed records', async () => {
  const known = await login({ password: 'wrong-password' });
  assert.equal(known.status, 401);
  assert.equal(inserts[0][4], 'LOGIN_FAILED');
  assert.equal(inserts[0][5], 'FAILED');
  assert.equal(inserts[0][0], user.id);
  selectedUser = null;
  const unknown = await login({ email: 'unknown@example.test' });
  assert.deepEqual(unknown, known);
  assert.equal(inserts[1][0], null);
  assert.equal(inserts[1][2], 'unknown@example.test');
});

test('new IP and device are explained without blocking successful login', async () => {
  history.has_history = true;
  const result = await login({ security_context: { user_agent: 'New Browser' } });
  assert.equal(result.status, 200);
  assert.equal(result.body.security_status, 'NEEDS_REVIEW');
  assert.equal(result.body.security_flag, true);
  assert.match(result.body.security_reason, /New IP address/);
  assert.match(result.body.security_reason, /unseen user-agent/);
});

test('fifth failure is suspicious and audit outages preserve login without a verdict', async () => {
  history.failed_count = '4';
  assert.equal((await login({ password: 'wrong-password' })).status, 401);
  assert.equal(inserts[0][14], 'SUSPICIOUS');
  auditFails = true;
  const result = await login();
  assert.equal(result.status, 200);
  assert.equal(result.body.security_status, null);
  assert.equal(result.body.security_audit_available, false);
  assert.equal((await login({ password: 'wrong-password' })).status, 401);
});

test('malformed credentials and metadata produce 400 without querying or saving', async () => {
  for (const body of [
    { email: 123 }, { password: [] }, { security_context: [] },
    { security_context: { latitude: '10', longitude: 123 } },
    { security_context: { latitude: 91, longitude: 123, location_permission_status: 'GRANTED' } },
    { security_context: { latitude: 10, longitude: 181, location_permission_status: 'GRANTED' } },
    { security_context: { location_permission_status: 'GRANTED', location_accuracy: -1 } },
    { security_context: { location_permission_status: 'DENIED', latitude: 10, longitude: 123 } },
    { security_context: { location_permission_status: 'UNKNOWN' } },
    { security_context: { user_agent: 'a'.repeat(2049) } },
    { security_context: { platform: 'bad\u0000text' } },
  ]) assert.equal((await login(body)).status, 400);
  assert.equal(queryCalls.length, 0);
  assert.equal(inserts.length, 0);
  assert.throws(() => validateSecurityContext({ latitude: NaN }), /finite number/);
  assert.throws(() => validateSecurityContext({ latitude: Infinity }), /finite number/);
});

test('log endpoints reject anonymous, engineer, demoted, inactive and expired accounts', async () => {
  for (const path of ['/security/login-logs', '/security/login-logs/1']) {
    assert.equal((await fetch(base + path)).status, 401);
    assert.equal((await fetch(base + path, { headers: { Authorization: `Bearer ${token('engineer')}` } })).status, 403);
    for (const role of ['engineer', null]) {
      currentRole = role;
      assert.equal((await fetch(base + path, { headers: { Authorization: `Bearer ${token('admin')}` } })).status, 403);
    }
    currentRole = 'admin';
    const expired = jwt.sign({ id: user.id, role: 'admin' }, process.env.JWT_SECRET, { expiresIn: -1 });
    assert.equal((await fetch(base + path, { headers: { Authorization: `Bearer ${expired}` } })).status, 401);
  }
  assert.ok(queryCalls.every(call => !call.sql.includes('login_security_logs')));
});

test('admin list/detail support pagination, numeric locations, filters and 404', async () => {
  const headers = { Authorization: `Bearer ${token('admin')}` };
  const result = await fetch(`${base}/security/login-logs?page=2&limit=10&status=NEEDS_REVIEW&user_id=${user.id}&from=2026-10-01&to=2026-10-03T23:59:59%2B08:00`, { headers });
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  const body = await result.json();
  assert.deepEqual(body.pagination, { page: 2, limit: 10, total: 1 });
  assert.equal(body.data[0].latitude, 10.123456);
  const listQuery = queryCalls.find(call => call.sql.includes('LIMIT'));
  assert.ok(!listQuery.sql.includes('NEEDS_REVIEW'));
  assert.deepEqual(listQuery.values.slice(-2), [10, 10]);
  assert.equal((await fetch(`${base}/security/login-logs/1`, { headers })).status, 200);
  assert.equal((await fetch(`${base}/security/login-logs/999`, { headers })).status, 404);
  for (const path of ['?page=-1', '?limit=101', '?user_id=invalid', '?status=INVALID', '?from=2026-02-30', '?from=2026-10-03T24:00:00Z', '?from=0000-01-01', '?from=2026-10-03&to=2026-10-01', '?page=1&page=2', '/9223372036854775808', '/1%27']) {
    assert.equal((await fetch(`${base}/security/login-logs${path}`, { headers })).status, 400);
  }
});

test('logout requires authentication and uses account identity from the database', async () => {
  assert.equal((await fetch(`${base}/auth/logout`, { method: 'POST' })).status, 401);
  const response = await fetch(`${base}/auth/logout`, {
    method: 'POST', headers: { Authorization: `Bearer ${token('engineer')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: 'forged', security_context: { role: 'forged' } }),
  });
  assert.equal(response.status, 200);
  assert.equal(inserts[0][4], 'LOGOUT');
  assert.equal(inserts[0][0], user.id);
});

test('extreme travel requires accurate locations and stays a review signal', () => {
  const args = {
    eventType: 'LOGIN_SUCCESS', history: { failed_count: 0, has_history: true, has_ip: true, has_device: true },
    now: '2026-10-03T12:00:00Z',
    context: validateSecurityContext({ latitude: 51.5, longitude: -0.1, location_accuracy: 25, location_permission_status: 'GRANTED' }),
    previousLocation: { latitude: '10.123456', longitude: '123.123456', created_at: '2026-10-03T11:00:00Z' },
  };
  assert.equal(evaluateSecurity(args).security_status, 'NEEDS_REVIEW');
  args.context.location_accuracy = null;
  assert.equal(evaluateSecurity(args).security_status, 'NORMAL');
  args.context.location_accuracy = 20000;
  assert.equal(evaluateSecurity(args).security_status, 'NORMAL');
  args.history.has_history = false;
  assert.equal(evaluateSecurity(args).security_status, 'NORMAL');
});

test('IP canonicalization and explicit proxy configuration resist header spoofing', async () => {
  assert.equal(normalizeIp('::ffff:192.0.2.5'), '192.0.2.5');
  assert.equal(normalizeIp('::ffff:c000:205'), '192.0.2.5');
  assert.equal(normalizeIp('2001:0DB8:0:0:0:0:0:1'), '2001:db8::1');
  assert.equal(normalizeIp('fe80::1%5'), 'fe80::1');
  assert.equal(normalizeIp('invalid'), null);
  const app = express();
  for (const config of ['true', '1', 'uniquelocal', '0.0.0.0/0', '::/0', '127.0.0.1/33']) {
    assert.throws(() => configureTrustedProxy(app, config), /explicit IP/);
  }
  const { getClientIp } = require('../services/loginSecurityContext');
  app.get('/', (req, res) => res.json({ ip: getClientIp(req) }));
  const proxyServer = app.listen(0, '127.0.0.1');
  await new Promise(resolve => proxyServer.once('listening', resolve));
  const url = `http://127.0.0.1:${proxyServer.address().port}/`;
  try {
    configureTrustedProxy(app, '10.0.0.1/32');
    const headers = { 'X-Forwarded-For': '198.51.100.9, 192.0.2.10' };
    assert.equal((await (await fetch(url, { headers })).json()).ip, '127.0.0.1');
    configureTrustedProxy(app, '127.0.0.1/32');
    assert.equal((await (await fetch(url, { headers })).json()).ip, '192.0.2.10');
  } finally { await new Promise(resolve => proxyServer.close(resolve)); }
  assert.throws(() => parseLogFilters({ from: '2026-10-03T12:00:00' }), /timezone/);
});
