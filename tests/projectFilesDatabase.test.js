const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const pool = require('../db');
const files = require('../services/projectFileService');

test('project documents view inline and issue images persist with exact associations and existing access checks', async () => {
  const client = await pool.connect();
  const schema = `project_files_test_${randomUUID().replaceAll('-', '')}`;
  const trackedFiles = new Set();
  let server;
  try {
    await client.query('BEGIN');
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET LOCAL search_path TO "${schema}"`);
    await client.query(`CREATE TABLE users (id UUID PRIMARY KEY, full_name TEXT, email TEXT, role TEXT, is_active BOOLEAN DEFAULT TRUE);
      CREATE TABLE projects (id UUID PRIMARY KEY, code VARCHAR(50) UNIQUE NOT NULL, name TEXT, status TEXT, owner_id UUID REFERENCES users(id));
      CREATE TABLE project_members (project_id VARCHAR(50), user_id UUID, user_name TEXT);
      CREATE TABLE documents (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), project_code VARCHAR(50) REFERENCES projects(code),
        name TEXT NOT NULL, type VARCHAR(10) CHECK (type IN ('DWG','PDF','XLS','DOC')), category TEXT,
        uploaded_at TIMESTAMP DEFAULT NOW(), file_path TEXT);
      CREATE TABLE project_issues (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), project_id UUID REFERENCES projects(id),
        project_code VARCHAR(50), title TEXT, description TEXT, category TEXT, severity TEXT, priority TEXT, status TEXT,
        reported_by UUID REFERENCES users(id), assigned_to UUID, location TEXT, resolution_notes TEXT,
        created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW(), resolved_at TIMESTAMP);
      CREATE TABLE issue_resolutions (id UUID PRIMARY KEY, issue_id UUID, resolution_summary TEXT, resolution_steps JSONB,
        final_remarks TEXT, resolved_by UUID, resolved_at TIMESTAMP);
      CREATE TABLE notifications (id SERIAL PRIMARY KEY, title TEXT, message TEXT, audience TEXT, project_id VARCHAR(50), created_by UUID);`);
    const owner = { id: randomUUID(), email: 'owner@example.test', role: 'Admin' };
    const engineer = { id: randomUUID(), email: 'engineer@example.test', role: 'Site Engineer' };
    const peer = { id: randomUUID(), email: 'peer@example.test', role: 'Site Engineer' };
    const viewer = { id: randomUUID(), email: 'viewer@example.test', role: 'Member' };
    const outsider = { id: randomUUID(), email: 'outsider@example.test', role: 'Site Engineer' };
    for (const user of [owner, engineer, peer, viewer, outsider]) {
      await client.query('INSERT INTO users VALUES ($1,$2,$2,$3,TRUE)', [user.id, user.email, user.role]);
    }
    const projects = [randomUUID(), randomUUID()];
    for (const [index, id] of projects.entries()) {
      await client.query("INSERT INTO projects VALUES ($1,$2,'File project','Active',$3)", [id, `FILES-${index}`, owner.id]);
      for (const user of [engineer, peer, viewer]) await client.query('INSERT INTO project_members VALUES ($1,$2,$3)', [`FILES-${index}`, user.id, user.email]);
    }
    await client.query("INSERT INTO project_issues (project_id,project_code,title,description,status) VALUES ($1,'FILES-0','Legacy issue','Existing text','open')", [projects[0]]);
    const migration = fs.readFileSync(path.join(__dirname, '..', 'migrations', 'issue_images.sql'), 'utf8');
    await client.query(migration);
    await client.query(migration);
    assert.deepEqual((await client.query("SELECT description,image_paths FROM project_issues WHERE title='Legacy issue'")).rows[0],
      { description: 'Existing text', image_paths: [] });
    assert.equal((await client.query(`SELECT data_type FROM information_schema.columns WHERE table_schema=$1
      AND table_name='project_issues' AND column_name='image_paths'`, [schema])).rows[0].data_type, 'jsonb');
    let failNotification = false;
    const query = (sql, values) => {
      if (failNotification && sql.includes('INSERT INTO notifications')) { failNotification = false; throw new Error('Injected notification failure'); }
      return client.query(sql, values);
    };
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;
      ALTER TABLE project_members ADD COLUMN IF NOT EXISTS user_name TEXT;
      CREATE TABLE IF NOT EXISTS tasks (id UUID PRIMARY KEY, project_id UUID, assignee_id UUID);
      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS assignee_id UUID;`);
    mock.method(pool, 'query', query);
    mock.method(pool, 'connect', async () => ({
      query: (sql, values) => query(sql === 'BEGIN' ? 'SAVEPOINT file_request' :
        sql === 'COMMIT' ? 'RELEASE SAVEPOINT file_request' : sql === 'ROLLBACK' ? 'ROLLBACK TO SAVEPOINT file_request' : sql, values), release() {},
    }));
    mock.method(console, 'error', () => {});
    const app = express();
    // Use the same guarded /uploads static stack as server.js; no additional serving route.
    app.use('/uploads', require('../middlewares/projectFileAccess'), express.static(path.resolve(__dirname, '..', 'uploads')));
    app.use(express.json());
    app.use(require('../middlewares/authMiddleware').verifyToken);
    app.use((req, res, next) => {
      res.on('finish', () => { for (const file of req.files || []) if (file.path) trackedFiles.add(file.path); });
      next();
    });
    app.use('/projects', require('../routes/project'));
    app.use('/', require('../routes/issuesRoutes'));
    app.use((_req, res) => res.status(404).json({ message: 'Not found' }));
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const root = `http://127.0.0.1:${server.address().port}`;
    async function raw(url, user = engineer, method = 'GET', body, headers = {}) {
      return fetch(root + url, { method, headers: { ...(user ? { Authorization: `Bearer ${jwt.sign(user, process.env.JWT_SECRET)}` } : {}),
        ...(body instanceof globalThis.FormData ? {} : { 'Content-Type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: body instanceof globalThis.FormData ? body : JSON.stringify(body) }) });
    }
    async function request(url, user = engineer, method = 'GET', body) {
      const response = await raw(url, user, method, body);
      return { status: response.status, body: await response.json() };
    }
    function imageForm(names, title = 'Image issue', mimetype = 'image/png') {
      const form = new globalThis.FormData();
      form.append('title', title); form.append('description', 'Captured issue');
      for (const name of names) form.append('images', new globalThis.Blob([Buffer.from('retained image bytes: ' + name)], { type: mimetype }), name);
      return form;
    }
    const documentForm = new globalThis.FormData();
    const pdfBytes = '%PDF-1.4\nDirectly viewable project plan\n%%EOF';
    documentForm.append('file', new globalThis.Blob([pdfBytes], { type: 'application/pdf' }), 'Project Plan.pdf');
    const uploaded = await request('/projects/FILES-0/documents', engineer, 'POST', documentForm);
    assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
    const document = uploaded.body.data[0];
    assert.equal(document.mime_type, 'application/pdf');
    assert.ok(document.file_path.startsWith('/uploads/documents/'));
    const list = await request('/projects/FILES-0/documents');
    assert.equal(list.status, 200);
    assert.equal(list.body.data.find(item => item.id === document.id).file_path, document.file_path);
    assert.equal((await request('/projects/FILES-0/documents', outsider)).status, 404);
    const direct = await raw(document.file_path);
    assert.equal(direct.status, 200);
    assert.ok(direct.headers.get('content-disposition').startsWith('inline;'));
    assert.equal(direct.headers.get('content-type'), 'application/pdf');
    assert.equal(direct.headers.get('cache-control'), 'private, no-store');
    assert.equal(await direct.text(), pdfBytes);
    assert.equal((await raw(document.file_path, null)).status, 401);
    assert.equal((await raw(document.file_path, outsider)).status, 403);
    assert.equal((await raw(document.file_path, viewer)).status, 200);
    assert.equal((await raw(document.file_path.replace('/documents/', '/%64ocuments/'), null)).status, 401,
      'Encoded directory names must not bypass authorization');
    assert.equal((await raw(document.file_path.replace('/documents/', '/%64ocuments/'), outsider)).status, 403);
    assert.equal((await raw(document.file_path, engineer, 'GET', undefined, { Authorization: 'Bearer invalid-token' })).status, 401);
    const range = await raw(document.file_path, engineer, 'GET', undefined, { Range: 'bytes=0-3' });
    assert.equal(range.status, 206);
    assert.equal(await range.text(), '%PDF');
    // A legacy native Windows/absolute file path is normalized without leaking it.
    await client.query('UPDATE documents SET file_path=$1 WHERE id=$2', [files.fileReference(document.file_path, 'documents').localPath, document.id]);
    assert.equal((await request('/projects/FILES-0/documents')).body.data.find(item => item.id === document.id).file_path, document.file_path);
    assert.equal((await raw(document.file_path)).status, 200);
    const metadataOnly = await request('/projects/FILES-0/documents', engineer, 'POST', { name: 'Metadata only', type: 'PDF' });
    assert.equal(metadataOnly.status, 201);
    assert.equal((await request('/projects/FILES-0/documents')).body.data.find(item => item.id === metadataOnly.body.data.id).file_path, null);
    await client.query("INSERT INTO documents (project_code,name,type,category,file_path) VALUES ('FILES-0','Invalid path','PDF','Site Reference',$1)",
      [path.resolve(__dirname, '..', '.env')]);
    assert.ok(!JSON.stringify((await request('/projects/FILES-0/documents')).body).includes(path.resolve(__dirname, '..')));

    const base = `/projects/${projects[0]}/issues`;
    const created = await request(base, engineer, 'POST', imageForm(['one.png', 'two.png']));
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const issue = created.body.data;
    assert.equal(issue.images.length, 2);
    assert.equal('image_paths' in issue, false);
    assert.deepEqual((await client.query('SELECT image_paths FROM project_issues WHERE id=$1', [issue.id])).rows[0].image_paths,
      issue.images.map(image => image.url));
    for (const url of [`/issues/${issue.id}`, `/projects/FILES-0/issues/${issue.id}`]) {
      assert.deepEqual((await request(url)).body.data.images, issue.images);
      assert.equal((await request(url, outsider)).status, 404);
    }
    const issues = await request(base);
    assert.deepEqual(issues.body.data.find(item => item.id === issue.id).images, issue.images);
    assert.deepEqual(issues.body.data.find(item => item.title === 'Legacy issue').images, []);
    const imageUrl = issue.images[0].url;
    const imageFile = await raw(imageUrl);
    assert.equal(imageFile.status, 200); assert.equal(imageFile.headers.get('content-type'), 'image/png');
    assert.equal(await imageFile.text(), 'retained image bytes: one.png');
    assert.equal((await raw(imageUrl, null)).status, 401);
    assert.equal((await raw(imageUrl, outsider)).status, 403);
    assert.equal((await raw(imageUrl, viewer)).status, 200);
    assert.equal((await raw(imageUrl.replace('/issues/', '/%69ssues/'), outsider)).status, 403);
    const imageDirectory = path.resolve(__dirname, '..', 'uploads', 'issues');
    const beforeRetry = fs.readdirSync(imageDirectory).sort();
    const retry = await request(base, engineer, 'POST', { title: 'Retry', description: 'Same selected images', images: issue.images });
    assert.equal(retry.status, 201);
    assert.deepEqual(retry.body.data.images, issue.images);
    assert.deepEqual(fs.readdirSync(imageDirectory).sort(), beforeRetry);
    const multipartRetry = await request(base, engineer, 'POST', imageForm(['one.png', 'two.png'], 'Multipart retry'));
    assert.equal(multipartRetry.status, 201);
    assert.deepEqual(multipartRetry.body.data.images, issue.images);
    assert.deepEqual(fs.readdirSync(imageDirectory).sort(), beforeRetry, 'Identical multipart retries must reuse committed files');
    failNotification = true;
    assert.equal((await request(base, engineer, 'POST', imageForm(['one.png'], 'Failed retry'))).status, 500);
    assert.equal((await raw(imageUrl)).status, 200, 'Rollback must not delete a reused committed image');
    assert.equal((await request(`/projects/${projects[1]}/issues`, engineer, 'POST', { title: 'Wrong project', description: 'Text', images: [imageUrl] })).status, 400);
    assert.equal((await request(base, peer, 'POST', { title: 'Wrong owner', description: 'Text', images: [imageUrl] })).status, 400);
    for (const images of [null, 'not an array', ['/uploads/issues/unknown.png'], ['/uploads/documents/photo.png'], ['https://example.test/image.png']]) {
      assert.equal((await request(base, engineer, 'POST', { title: 'Malformed', description: 'Text', images })).status, 400);
    }
    const noImages = await request(base, engineer, 'POST', { title: 'No photos', description: 'Text' });
    assert.equal(noImages.status, 201); assert.deepEqual(noImages.body.data.images, []);
    const separate = await request(base, engineer, 'POST', imageForm(['separate.png'], 'Separate issue'));
    assert.equal(separate.status, 201); assert.equal(separate.body.data.images.length, 1);
    assert.ok(!issue.images.some(image => image.url === separate.body.data.images[0].url));
    assert.deepEqual((await request(`/issues/${issue.id}`)).body.data.images, issue.images);
    const mixed = imageForm(['mixed.png'], 'Mixed upload and reference');
    mixed.append('images', JSON.stringify([imageUrl]));
    const mixedIssue = await request(base, engineer, 'POST', mixed);
    assert.equal(mixedIssue.status, 201, JSON.stringify(mixedIssue.body));
    assert.equal(mixedIssue.body.data.images.length, 2);
    assert.equal(mixedIssue.body.data.images[0].url, imageUrl);
    const edited = await request(`/issues/${issue.id}`, engineer, 'PATCH', { description: 'Updated details' });
    assert.equal(edited.status, 200); assert.deepEqual(edited.body.data.images, issue.images);
    const beforeFailures = fs.readdirSync(imageDirectory).sort();
    assert.equal((await request(base, outsider, 'POST', imageForm(['unauthorized.png']))).status, 404);
    assert.equal((await request(base, viewer, 'POST', imageForm(['viewer.png']))).status, 403);
    assert.equal((await request(base, engineer, 'POST', imageForm(['bad.txt'], 'Bad file', 'text/plain'))).status, 400);
    assert.equal((await request(base, engineer, 'POST', imageForm(['invalid.png'], ''))).status, 400);
    assert.equal((await request(base, engineer, 'POST', imageForm(Array.from({ length: 21 }, (_, i) => `limit-${i}.png`)))).status, 400);
    failNotification = true;
    assert.equal((await request(base, engineer, 'POST', imageForm(['rollback.png']))).status, 500);
    assert.deepEqual(fs.readdirSync(imageDirectory).sort(), beforeFailures, 'Rejected/rolled-back uploads must leave no orphan files');
    assert.equal((await client.query("SELECT COUNT(*)::int AS count FROM project_issues WHERE title='Image issue'")).rows[0].count, 1);
    assert.ok(!JSON.stringify((await request(base)).body).includes(path.resolve(__dirname, '..')));
    assert.equal((await raw('/uploads/issues/unregistered.png')).status, 404);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    mock.restoreAll();
    await client.query('ROLLBACK'); client.release(); await pool.end();
    const directories = ['documents', 'issues'].map(folder => path.resolve(__dirname, '..', 'uploads', folder));
    for (const filename of trackedFiles) {
      const resolved = path.resolve(filename);
      assert.ok(directories.includes(path.dirname(resolved)), 'Only remove files created by these test requests');
      if (fs.existsSync(resolved)) fs.unlinkSync(resolved);
    }
  }
});
