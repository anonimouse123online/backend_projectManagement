const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const http = require('node:http');
const express = require('express');
const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const pool = require('../db');
const service = require('../services/projectIssueService');

test('current project authorization governs actual socket delivery and stale room revocation', { timeout: 15000 }, async t => {
  const client = await pool.connect();
  const schema = `issue_socket_access_${randomUUID().replaceAll('-', '')}`;
  const connections = [];
  let io;
  try {
    await client.query('BEGIN');
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET LOCAL search_path TO "${schema}"`);
    await client.query(`CREATE TABLE users (id UUID PRIMARY KEY, email TEXT, full_name TEXT, role TEXT,
        is_active BOOLEAN DEFAULT TRUE, email_verified BOOLEAN DEFAULT TRUE);
      CREATE TABLE projects (id UUID PRIMARY KEY, code TEXT UNIQUE, name TEXT, owner_id UUID);
      CREATE TABLE project_members (id SERIAL PRIMARY KEY, project_id TEXT, user_id UUID, user_name TEXT);
      CREATE TABLE tasks (id UUID PRIMARY KEY, project_id UUID, assignee_id UUID);`);
    const users = {};
    for (const name of ['owner', 'member', 'removed', 'assigned', 'inactive', 'outsider']) {
      users[name] = { id: randomUUID(), email: `${name}@socket.test`, role: name === 'owner' || name === 'outsider' ? 'admin' : 'engineer' };
      await client.query('INSERT INTO users (id,email,full_name,role) VALUES ($1,$2,$3,$4)',
        [users[name].id, users[name].email, name, users[name].role]);
    }
    const alpha = { id: randomUUID(), code: 'SOCKET-ALPHA', name: 'Alpha', owner_id: users.owner.id };
    const beta = { id: randomUUID(), code: 'SOCKET-BETA', name: 'Beta', owner_id: users.removed.id };
    for (const project of [alpha, beta]) await client.query('INSERT INTO projects VALUES ($1,$2,$3,$4)',
      [project.id, project.code, project.name, project.owner_id]);
    for (const name of ['member', 'removed', 'assigned', 'inactive']) await client.query(
      'INSERT INTO project_members (project_id,user_id,user_name) VALUES ($1,$2,$3)', [alpha.code, users[name].id, users[name].email]);
    await client.query('INSERT INTO tasks VALUES ($1,$2,$3)', [randomUUID(), alpha.id, users.assigned.id]);
    mock.method(pool, 'query', (sql, values) => client.query(sql, values));

    const app = express();
    app.use(express.json());
    const server = http.createServer(app);
    io = require('../services/socketService')(server);
    app.set('io', io);
    app.use('/projects', require('../routes/project'));
    app.use('/users', require('../routes/user'));
    app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
    server.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;

    async function connect(user, namespace) {
      const prefix = namespace === '/' ? '' : `${namespace},`;
      const ws = new WebSocket(base.replace('http:', 'ws:') + '/socket.io/?EIO=4&transport=websocket');
      const connection = { ws, namespace, events: [], barriers: new Map() };
      connections.push(connection);
      await new Promise((resolve, reject) => {
        ws.on('error', reject);
        ws.on('message', data => {
          const packet = data.toString();
          if (packet.startsWith('0')) ws.send(`40${prefix}${JSON.stringify({ token: jwt.sign(user, process.env.JWT_SECRET) })}`);
          else if (packet === '2') ws.send('3');
          else if (packet.startsWith(`40${prefix}`)) {
            connection.socket = io.of(namespace).sockets.get(JSON.parse(packet.slice(2 + prefix.length)).sid);
            resolve();
          } else if (packet.startsWith(`44${prefix}`)) reject(new Error(packet));
          else if (packet.startsWith(`42${prefix}`)) {
            const [event, payload] = JSON.parse(packet.slice(2 + prefix.length));
            if (event === 'test_barrier') connection.barriers.get(payload)?.();
            else connection.events.push({ event, payload });
          }
        });
      });
      return connection;
    }
    const sockets = {};
    for (const [name, user] of Object.entries(users)) {
      sockets[name] = await Promise.all(['/', '/project-issues'].map(namespace => connect(user, namespace)));
      for (const connection of sockets[name]) await connection.socket.join([`project:${alpha.code}`, `project:${alpha.id}`]);
    }
    for (const connection of sockets.removed) await connection.socket.join([`project:${beta.code}`, `project:${beta.id}`]);
    await client.query('UPDATE users SET is_active = FALSE WHERE id = $1', [users.inactive.id]);
    const req = { app };
    const counts = { active_issue_count: 0, has_active_issues: false };
    const notices = names => names.map(name => ({ audience: 'individual', target_user_id: users[name].id,
      title: 'Issue Resolved', message: 'Private resolution', project_id: alpha.code }));
    async function flush() {
      await Promise.all(connections.map(connection => new Promise(resolve => {
        const marker = randomUUID();
        connection.barriers.set(marker, resolve);
        connection.socket.emit('test_barrier', marker);
      })));
    }
    async function remove(path) {
      const response = await fetch(base + path, { method: 'DELETE', headers: {
        Authorization: `Bearer ${jwt.sign(users.owner, process.env.JWT_SECRET)}`,
      } });
      assert.equal(response.status, 200, JSON.stringify(await response.json()));
    }
    function clearEvents() { for (const connection of connections) connection.events.length = 0; }
    function receives(name, event) { return sockets[name][1].events.some(item => item.event === event); }
    function inAlpha(name) {
      return sockets[name].every(connection => connection.socket.rooms.has(`project:${alpha.code}`) && connection.socket.rooms.has(`project:${alpha.id}`));
    }

    await t.test('active members receive notifications; disabled and unrelated accounts do not', async () => {
      await service.publishChange(req, alpha, counts, notices(['owner', 'removed', 'assigned', 'inactive', 'outsider']));
      await flush();
      for (const name of ['owner', 'removed', 'assigned']) assert.ok(receives(name, 'new_notification'), name);
      assert.ok(receives('member', 'project_issues_updated'));
      for (const name of ['inactive', 'outsider']) assert.deepEqual(sockets[name][1].events, [], name);
    });
    await t.test('membership removal evicts stale code/UUID rooms in both namespaces and blocks resolution events', async () => {
      await remove(`/projects/${alpha.code}/members/${users.removed.id}`);
      assert.equal(inAlpha('removed'), false);
      for (const connection of sockets.removed) {
        assert.ok(!connection.socket.rooms.has(`project:${alpha.code}`));
        assert.ok(!connection.socket.rooms.has(`project:${alpha.id}`));
        assert.ok(connection.socket.rooms.has(`project:${beta.code}`));
        assert.ok(connection.socket.rooms.has(`user:${users.removed.id}`));
      }
      for (const name of ['owner', 'member', 'assigned']) assert.ok(inAlpha(name), name);
      for (const name of ['inactive', 'outsider']) assert.equal(inAlpha(name), false, name);
      clearEvents();
      await service.publishChange(req, alpha, counts, notices(['owner', 'removed', 'assigned']));
      await flush();
      assert.deepEqual(sockets.removed[1].events, []);
      assert.ok(receives('owner', 'new_notification'));
      assert.ok(receives('assigned', 'new_notification'));
      await service.publishChange(req, beta, counts, { audience: 'individual', target_user_id: users.removed.id });
      await flush();
      assert.ok(receives('removed', 'new_notification'), 'Other authorized projects remain usable');
    });
    await t.test('bulk team removal also revokes both project-room aliases', async () => {
      await remove(`/users/${users.member.id}`);
      assert.equal(inAlpha('member'), false);
      clearEvents();
      await service.publishChange(req, alpha, counts, notices(['member']));
      await flush();
      assert.deepEqual(sockets.member[1].events, []);
    });
    await t.test('task assignment retains access after membership removal and revocation takes effect at the next emit', async () => {
      await remove(`/projects/${alpha.code}/members/${users.assigned.id}`);
      assert.ok(inAlpha('assigned'));
      clearEvents();
      await service.publishChange(req, alpha, counts, notices(['assigned']));
      await flush();
      assert.ok(receives('assigned', 'new_notification'));
      await client.query('UPDATE tasks SET assignee_id = $1 WHERE project_id = $2', [users.owner.id, alpha.id]);
      clearEvents();
      await service.publishChange(req, alpha, counts, notices(['assigned']));
      await flush();
      assert.deepEqual(sockets.assigned[1].events, [], 'Stale project rooms cannot authorize delivery');
      await service.revokeProjectAccess(io, alpha);
      assert.equal(inAlpha('assigned'), false);
    });
    await t.test('ownership is reread instead of trusting a stale project object', async () => {
      await client.query('UPDATE projects SET owner_id = $1 WHERE id = $2', [users.outsider.id, alpha.id]);
      await client.query('UPDATE tasks SET assignee_id = $1 WHERE project_id = $2', [users.outsider.id, alpha.id]);
      clearEvents();
      await service.publishChange(req, alpha, counts, notices(['owner', 'outsider']));
      await flush();
      assert.deepEqual(sockets.owner[1].events, []);
      assert.ok(receives('outsider', 'new_notification'));
    });
    await t.test('authorization lookup failures emit no private data', async () => {
      clearEvents();
      const lookup = mock.method(pool, 'query', async () => { throw new Error('Lookup unavailable'); });
      try { await assert.rejects(service.publishChange(req, alpha, counts, notices(['outsider'])), /Lookup unavailable/); }
      finally { lookup.mock.restore(); }
      await flush();
      for (const connection of connections) assert.deepEqual(connection.events, []);
    });
  } finally {
    for (const connection of connections) connection.ws.terminate();
    if (io) await new Promise(resolve => io.close(resolve));
    mock.restoreAll();
    await client.query('ROLLBACK');
    client.release();
    await pool.end();
  }
});
