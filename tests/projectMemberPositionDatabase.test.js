const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const pool = require('../db');

test('invitation positions stay pending until the authenticated member chooses their own project position', async () => {
  const client = await pool.connect();
  const schema = `member_position_test_${randomUUID().replaceAll('-', '')}`;
  let server;
  try {
    await client.query('BEGIN');
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET LOCAL search_path TO "${schema}"`);
    // Match the installed membership field, constraints and integer identifiers.
    await client.query(`CREATE TABLE users (id UUID PRIMARY KEY, full_name VARCHAR(255), email VARCHAR(255) UNIQUE,
        role VARCHAR(50) NOT NULL CHECK (role IN ('admin','engineer')), is_active BOOLEAN DEFAULT TRUE);
      CREATE TABLE projects (id UUID PRIMARY KEY, code VARCHAR(50) UNIQUE NOT NULL, name TEXT, status TEXT,
        owner_id UUID REFERENCES users(id), created_at TIMESTAMP DEFAULT NOW());
      CREATE TABLE project_members (id SERIAL PRIMARY KEY, project_id VARCHAR(50) NOT NULL REFERENCES projects(code),
        user_name VARCHAR(255) NOT NULL, role VARCHAR(50) NOT NULL DEFAULT 'Member',
        joined_at TIMESTAMP NOT NULL DEFAULT NOW(), user_id UUID NOT NULL REFERENCES users(id),
        UNIQUE(project_id,user_id), UNIQUE(project_id,user_name));
      CREATE TABLE project_invite_codes (id SERIAL PRIMARY KEY, project_id VARCHAR(50) NOT NULL REFERENCES projects(code),
        code VARCHAR(20) UNIQUE NOT NULL, expires_at TIMESTAMP NOT NULL DEFAULT NOW()+INTERVAL '7 days',
        used BOOLEAN NOT NULL DEFAULT FALSE, used_at TIMESTAMP, created_at TIMESTAMP NOT NULL DEFAULT NOW());`);
    const owner = { id: randomUUID(), email: 'owner@example.test', role: 'admin' };
    const first = { id: randomUUID(), email: 'first@example.test', role: 'engineer' };
    const second = { id: randomUUID(), email: 'second@example.test', role: 'engineer' };
    const third = { id: randomUUID(), email: 'third@example.test', role: 'engineer' };
    const outsider = { id: randomUUID(), email: 'outsider@example.test', role: 'engineer' };
    for (const user of [owner, first, second, third, outsider]) {
      await client.query('INSERT INTO users (id,full_name,email,role) VALUES ($1,$2,$2,$3)', [user.id, user.email, user.role]);
    }
    for (const code of ['POSITION-A', 'POSITION-B']) {
      await client.query("INSERT INTO projects (id,code,name,status,owner_id) VALUES ($1,$2,'Test project','Active',$3)", [randomUUID(), code, owner.id]);
    }
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;
      ALTER TABLE project_members ADD COLUMN IF NOT EXISTS user_name TEXT;
      CREATE TABLE IF NOT EXISTS tasks (id UUID PRIMARY KEY, project_id UUID, assignee_id UUID);
      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS assignee_id UUID;`);
    mock.method(pool, 'query', (sql, values) => client.query(sql, values));
    mock.method(console, 'error', () => {});
    const app = express();
    app.use(express.json());
    app.use(require('../middlewares/authMiddleware').verifyToken);
    app.use('/projects', require('../routes/project'));
    app.use((_req, res) => res.status(404).json({ message: 'Route not found' }));
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const root = `http://127.0.0.1:${server.address().port}`;
    async function request(url, method = 'GET', body, user = owner) {
      const response = await fetch(root + url, { method, headers: {
        ...(user ? { Authorization: `Bearer ${jwt.sign(user, process.env.JWT_SECRET)}` } : {}),
        'Content-Type': 'application/json',
      }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, body: await response.json() };
    }
    async function membership(code, user) {
      return (await client.query('SELECT id,role FROM project_members WHERE project_id=$1 AND user_id=$2', [code, user.id])).rows[0];
    }
    const endpoint = '/projects/POSITION-A/members/me/position';
    assert.equal((await request('/projects/POSITION-A/members', 'POST', { userId: first.id }, null)).status, 401);
    assert.equal((await request('/projects/POSITION-A/members', 'POST', { userId: first.id }, outsider)).status, 404);
    assert.equal((await request('/projects/POSITION-A/members', 'POST', { userId: first.id })).status, 200);
    assert.equal((await membership('POSITION-A', first)).role, '');
    assert.equal((await request('/projects/POSITION-A/members', 'POST', {
      userId: second.id, role: 'Admin chosen role', position: 'Safety Engineer', designation: 'Project Engineer',
    })).status, 200);
    assert.equal((await membership('POSITION-A', second)).role, '', 'Admin-supplied positions must not be saved');
    assert.equal((await request('/projects/POSITION-B/members', 'POST', { userId: first.id })).status, 200);
    assert.equal((await request('/projects/POSITION-A/members', 'POST', { userId: first.id })).status, 409);
    const pendingList = await request('/projects/POSITION-A/members');
    assert.equal(pendingList.status, 200, JSON.stringify(pendingList.body));
    assert.equal(pendingList.body.data.find(user => user.id === first.id).role, '');
    assert.equal(pendingList.body.data.find(user => user.id === first.id).system_role, 'engineer');
    for (const position of [undefined, null, '', '  ', 42, [], {}, 'x'.repeat(51)]) {
      assert.equal((await request(endpoint, 'PATCH', { position }, first)).status, 400);
    }
    assert.equal((await request(endpoint, 'PATCH', { position: 'Site Engineer' }, null)).status, 401);
    assert.equal((await request(endpoint, 'PATCH', { position: 'Site Engineer' }, outsider)).status, 404);
    assert.equal((await request(endpoint, 'PATCH', { position: 'Site Engineer' }, { ...outsider, email: first.email })).status, 404,
      'Legacy email access must not allow updating another authenticated user\'s membership');
    assert.equal((await request(endpoint, 'PATCH', { position: 'Site Engineer' }, owner)).status, 404);
    const chosen = await request(endpoint, 'PATCH', { position: ' Site Engineer ' }, first);
    assert.equal(chosen.status, 200, JSON.stringify(chosen.body));
    assert.equal(chosen.body.data.user_id, first.id);
    assert.equal(chosen.body.data.position, 'Site Engineer');
    assert.equal((await membership('POSITION-A', first)).role, 'Site Engineer');
    assert.equal((await membership('POSITION-B', first)).role, '');
    assert.equal((await request('/projects/POSITION-B/members/me/position', 'PATCH', { position: 'QA/QC Engineer' }, first)).status, 200);
    assert.equal((await membership('POSITION-B', first)).role, 'QA/QC Engineer');
    // Supplying another engineer's identifiers cannot redirect the self-only update.
    const peer = await request(endpoint, 'PATCH', { position: 'Safety Engineer', userId: first.id, user_id: first.id,
      memberId: chosen.body.data.id }, second);
    assert.equal(peer.status, 200);
    assert.equal(peer.body.data.user_id, second.id);
    assert.equal((await membership('POSITION-A', first)).role, 'Site Engineer');
    assert.equal((await membership('POSITION-A', second)).role, 'Safety Engineer');
    assert.equal((await request(`/projects/POSITION-A/members/${chosen.body.data.id}/position`, 'PATCH', { position: 'Other' }, second)).status, 404);
    assert.equal((await request('/projects/POSITION-B/members/me/position', 'PATCH', { position: 'Other' }, second)).status, 404);
    const displayed = await request('/projects/POSITION-A/members', 'GET', undefined, first);
    assert.equal(displayed.body.data.find(user => user.id === first.id).role, 'Site Engineer');
    assert.equal(displayed.body.data.find(user => user.id === first.id).system_role, 'engineer');

    // Existing code generation/expiry/used/owner/member checks remain in place.
    assert.equal((await request('/projects/POSITION-A/generate-code', 'POST', {}, first)).status, 403);
    const generated = await request('/projects/POSITION-A/generate-code', 'POST', { position: 'Ignored admin position' });
    assert.equal(generated.status, 200);
    const invite_code = generated.body.code;
    for (const position of [undefined, null, ' ', 123, 'x'.repeat(51)]) {
      assert.equal((await request('/projects/join', 'POST', { invite_code, position }, third)).status, 400);
    }
    assert.equal((await client.query('SELECT used FROM project_invite_codes WHERE code=$1', [invite_code])).rows[0].used, false);
    assert.equal((await request('/projects/join', 'POST', { invite_code, position: 'Project Engineer' }, owner)).status, 409);
    assert.equal((await request('/projects/join', 'POST', { invite_code, position: 'Project Engineer' }, first)).status, 409);
    assert.equal((await request('/projects/join', 'POST', { invite_code: 'INVALID', position: 'Project Engineer' }, third)).status, 400);
    const joined = await request('/projects/join', 'POST', { invite_code, position: ' Project Engineer ', userId: first.id,
      role: 'admin' }, third);
    assert.equal(joined.status, 200, JSON.stringify(joined.body));
    assert.equal((await membership('POSITION-A', third)).role, 'Project Engineer');
    assert.equal((await membership('POSITION-A', first)).role, 'Site Engineer');
    assert.equal((await client.query('SELECT used FROM project_invite_codes WHERE code=$1', [invite_code])).rows[0].used, true);
    assert.equal((await request('/projects/join', 'POST', { invite_code, position: 'Other' }, outsider)).status, 400);
    await client.query("INSERT INTO project_invite_codes (project_id,code,expires_at) VALUES ('POSITION-A','EXPIRED',NOW()-INTERVAL '1 day')");
    assert.equal((await request('/projects/join', 'POST', { invite_code: 'EXPIRED', position: 'Other' }, outsider)).status, 400);
    assert.deepEqual((await client.query('SELECT id,role FROM users ORDER BY id')).rows,
      [owner, first, second, third, outsider].map(user => ({ id: user.id, role: user.role })).sort((a, b) => a.id.localeCompare(b.id)),
      'No project position operation may update global user roles');
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    mock.restoreAll();
    await client.query('ROLLBACK');
    client.release();
    await pool.end();
  }
});
