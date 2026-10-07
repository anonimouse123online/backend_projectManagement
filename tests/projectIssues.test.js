const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const pool = require('../db');
const service = require('../services/projectIssueService');
const controller = require('../controllers/issuesController');

test('issue routes reject unauthenticated and malformed requests before writing', async () => {
  const db = mock.method(pool, 'query', async () => { throw new Error('Unexpected database access'); });
  const connect = mock.method(pool, 'connect', async () => { throw new Error('Unexpected database access'); });
  const res = { status(code) { this.code = code; return this; }, json(value) { this.body = value; return this; } };
  try {
    for (const fn of Object.values(controller)) {
      await fn({ params: {}, query: {}, body: {} }, res);
      assert.equal(res.code, 401);
    }
    for (const body of [
      { title: 123, description: 'Text' },
      { title: 'Issue', description: [] },
      { title: 'Issue', description: 'Text', severity: 'urgent' },
      { title: 'Issue', description: 'Text', severity: 'high', priority: 'Low' },
      { title: 'Issue', description: 'Text', status: 'resolved' },
      { title: 'Issue', description: 'Text', category: {} },
    ]) {
      await controller.createIssue({ user: { id: 'user' }, body, params: {}, query: {} }, res);
      assert.equal(res.code, 400);
    }
    for (const query of [{ status: 'closed' }, { status: [] }, { severity: 'urgent' }, { search: {} }]) {
      await controller.getProjectIssues({ user: { id: 'user' }, query, params: {} }, res);
      assert.equal(res.code, 400);
    }
    assert.equal(db.mock.calls.length, 0);
    assert.equal(connect.mock.calls.length, 0);
  } finally { mock.restoreAll(); }
});

test('only project owners, admins and assigned engineers/managers/supervisors can write', () => {
  const project = { owner_id: 'owner', is_member: true };
  for (const role of ['Site Engineer', 'Project Manager', 'Supervisor', 'Admin']) {
    assert.doesNotThrow(() => service.requireWrite(project, { id: 'member', role }));
  }
  assert.doesNotThrow(() => service.requireWrite(project, { id: 'owner', role: 'Member' }));
  assert.throws(() => service.requireWrite(project, { id: 'member', role: 'Member' }), { status: 403 });
  assert.throws(() => service.requireWrite({ ...project, is_member: false }, { id: 'outsider', role: 'Site Engineer' }), { status: 403 });
});

test('resolving requires summary, meaningful steps and final remarks on every update route', async () => {
  const connect = mock.method(pool, 'connect', async () => { throw new Error('Unexpected database access'); });
  const res = { status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  const valid = { resolution_summary: 'Hazard removed', resolution_steps: ['Inspected', 'Removed hazard'], final_remarks: 'Safe now' };
  try {
    for (const body of [
      {}, { ...valid, resolution_summary: '' }, { ...valid, resolution_summary: '  ' },
      { ...valid, resolution_summary: 42 }, { ...valid, resolution_steps: undefined },
      { ...valid, resolution_steps: 'Inspected' }, { ...valid, resolution_steps: [] },
      { ...valid, resolution_steps: ['  '] }, { ...valid, resolution_steps: [null] },
      { ...valid, resolution_steps: ['Inspected', 12] }, { ...valid, final_remarks: undefined },
      { ...valid, final_remarks: '  ' },
    ]) {
      for (const fn of [controller.updateIssue, controller.resolveIssue]) {
        await fn({ user: { id: 'user' }, params: {}, body: { ...body, status: 'Resolved' } }, res);
        assert.equal(res.code, 400);
      }
    }
    await controller.resolveIssue({ user: { id: 'user' }, params: {}, body: { ...valid, status: 'open' } }, res);
    assert.equal(res.code, 400);
    assert.equal(connect.mock.calls.length, 0);
  } finally { mock.restoreAll(); }
});

test('only admins and project managers with project access can resolve issues', () => {
  const project = { owner_id: 'owner', is_member: true };
  for (const role of ['Admin', 'Project Manager', 'project_manager']) {
    assert.doesNotThrow(() => service.requireResolve(project, { id: 'member', role }));
  }
  for (const role of ['Site Engineer', 'Supervisor', 'Member']) {
    assert.throws(() => service.requireResolve(project, { id: 'member', role }), { status: 403 });
    assert.throws(() => service.requireResolve(project, { id: 'owner', role }), { status: 403 });
  }
  assert.throws(() => service.requireResolve({ ...project, is_member: false }, { id: 'outsider', role: 'Project Manager' }), { status: 403 });
  assert.doesNotThrow(() => service.requireResolve({ ...project, is_member: false }, { id: 'owner', role: 'Project Manager' }));
});

test('the issue socket namespace requires a valid JWT and joins only the authenticated user room', () => {
  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'project-issue-socket-test-secret';
  let middleware;
  let connected;
  const namespace = { use(fn) { middleware = fn; }, on(name, fn) { assert.equal(name, 'connection'); connected = fn; } };
  const io = { of(name) { assert.equal(name, '/project-issues'); return namespace; } };
  try {
    service.initializeIssueSocket(io);
    const id = '00000000-0000-4000-8000-000000000001';
    const valid = jwt.sign({ id, role: 'Site Engineer' }, process.env.JWT_SECRET);
    for (const token of [undefined, 'invalid', jwt.sign({ id }, 'wrong-secret'), jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: -1 })]) {
      const socket = { handshake: { auth: { token } }, data: {} };
      middleware(socket, error => assert.equal(error.message, 'Authentication required.'));
      assert.equal(socket.data.user, undefined);
    }
    let room;
    const socket = { handshake: { auth: { token: valid, user_id: 'spoofed-user' } }, data: {}, join(value) { room = value; } };
    middleware(socket, error => assert.equal(error, undefined));
    connected(socket);
    assert.equal(room, `user:${id}`);
  } finally {
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
  }
});

test.after(() => pool.end());
