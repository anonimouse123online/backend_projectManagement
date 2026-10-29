const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const pool = require('../db');

test('existing upload -> AI -> submission -> Admin flow retains the exact stored images', async () => {
  const client = await pool.connect();
  const schema = `report_images_test_${randomUUID().replaceAll('-', '')}`;
  const taskId = randomUUID();
  const otherTask = randomUUID();
  const projectId = randomUUID();
  const owner = { id: randomUUID(), email: 'owner@example.test', role: 'Admin' };
  const engineer = { id: randomUUID(), email: 'engineer@example.test', role: 'Site Engineer' };
  const outsider = { id: randomUUID(), email: 'outsider@example.test', role: 'Site Engineer' };
  const date = new Date().toISOString().slice(0, 10);
  const uploadDir = path.resolve(__dirname, '..', 'uploads', 'tasks', taskId, date);
  let server;
  try {
    await client.query('BEGIN');
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET LOCAL search_path TO "${schema}"`);
    await client.query(`CREATE TABLE users (id UUID PRIMARY KEY, full_name TEXT, email TEXT, role TEXT);
      CREATE TABLE projects (id UUID PRIMARY KEY, code VARCHAR(50) UNIQUE, name TEXT, location TEXT, status TEXT, owner_id UUID);
      CREATE TABLE project_members (project_id VARCHAR(50), user_id UUID, user_name TEXT);
      CREATE TABLE tasks (id UUID PRIMARY KEY, task_name TEXT, project_id UUID REFERENCES projects(id), assignee_id UUID,
        site_instructions TEXT);`);
    const setup = fs.readFileSync(path.join(__dirname, '..', 'setup_new_db.sql'), 'utf8');
    const projectReportTable = setup.match(/CREATE TABLE IF NOT EXISTS project_reports \([\s\S]*?\n\);/)[0];
    await client.query(projectReportTable.replace('uuid_generate_v4()', 'gen_random_uuid()'));
    await client.query("INSERT INTO users (id,full_name,email,role) VALUES ($1,'Owner',$2,$3),($4,'Engineer',$5,$6),($7,'Outsider',$8,$9)",
      [owner.id, owner.email, owner.role, engineer.id, engineer.email, engineer.role, outsider.id, outsider.email, outsider.role]);
    await client.query("INSERT INTO projects VALUES ($1,'REPORT-TEST','Report project','Test site','Active',$2)", [projectId, owner.id]);
    await client.query("INSERT INTO tasks VALUES ($1,'Image task',$2,$3,'Inspect'),($4,'Other task',$2,$3,'Inspect')",
      [taskId, projectId, engineer.id, otherTask]);
    await client.query("INSERT INTO project_reports (project_code,title,summary) VALUES ('REPORT-TEST','Legacy','Existing text')");
    const migration = fs.readFileSync(path.join(__dirname, '..', 'migrations', 'report_images.sql'), 'utf8');
    await client.query(migration);
    await client.query(migration);
    assert.deepEqual((await client.query("SELECT summary,image_paths FROM project_reports WHERE title='Legacy'")).rows[0],
      { summary: 'Existing text', image_paths: [] });
    // Teammate data and already existing columns survive repeated/partial upgrades.
    await client.query("INSERT INTO reports (task_id,report_date,report_text,image_paths) VALUES ($1,'2026-01-02','Teammate text','[]')", [otherTask]);
    await client.query('SAVEPOINT partial_upgrade');
    await client.query('ALTER TABLE reports RENAME COLUMN image_paths TO saved_image_paths');
    await client.query(migration);
    assert.equal((await client.query('SELECT report_text FROM reports WHERE task_id=$1', [otherTask])).rows[0].report_text, 'Teammate text');
    assert.deepEqual((await client.query(`SELECT table_name,data_type FROM information_schema.columns WHERE table_schema=$1
      AND table_name IN ('task_images','reports','project_reports') AND column_name='image_paths' ORDER BY table_name`, [schema])).rows,
    [{ table_name: 'project_reports', data_type: 'jsonb' }, { table_name: 'reports', data_type: 'jsonb' }, { table_name: 'task_images', data_type: 'jsonb' }]);
    await client.query('ROLLBACK TO SAVEPOINT partial_upgrade');
    await client.query(migration);
    assert.equal((await client.query('SELECT report_text FROM reports WHERE task_id=$1', [otherTask])).rows[0].report_text, 'Teammate text');
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;
      ALTER TABLE project_members ADD COLUMN IF NOT EXISTS user_name TEXT;
      CREATE TABLE IF NOT EXISTS tasks (id UUID PRIMARY KEY, project_id UUID, assignee_id UUID);
      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS assignee_id UUID;`);
    mock.method(pool, 'query', (statement, values) => client.query(statement, values));
    let migrationReleases = 0;
    let failMigration = false;
    mock.method(pool, 'connect', async () => ({
      async query(statement) {
        if (statement.includes('CREATE TABLE') && failMigration) throw new Error('Injected migration failure');
        return client.query(statement === 'BEGIN' ? 'SAVEPOINT migration_runner' :
          statement === 'COMMIT' ? 'RELEASE SAVEPOINT migration_runner' :
          statement === 'ROLLBACK' ? 'ROLLBACK TO SAVEPOINT migration_runner' : statement);
      },
      release() { migrationReleases++; },
    }));
    mock.method(console, 'log', () => {});
    mock.method(console, 'error', () => {});
    mock.method(console, 'warn', () => {});
    const { migrate } = require('../migrations/report_images');
    await migrate();
    await migrate();
    failMigration = true;
    await assert.rejects(migrate(), /Injected migration failure/);
    failMigration = false;
    assert.equal(migrationReleases, 3, 'Migration runner must release clients on success and failure');
    const realFetch = global.fetch;
    let aiPayload;
    mock.method(global, 'fetch', async (url, options) => {
      if (String(url).endsWith('/generate-report')) {
        aiPayload = JSON.parse(options.body);
        return { ok: true, status: 200, async json() { return { report: 'AI report\nTotal: 5', observations: ['Site observed'] }; } };
      }
      return realFetch(url, options);
    });
    const app = express();
    app.use('/uploads', express.static(path.resolve(__dirname, '..', 'uploads')));
    app.use(express.json());
    app.use(require('../middlewares/authMiddleware').verifyToken);
    app.use('/tasks', require('../routes/task'));
    app.get('/projects/:code/reports', require('../controllers/projectController').getProjectReports);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    let root = `http://127.0.0.1:${server.address().port}`;
    async function request(url, method = 'GET', body, user = engineer) {
      const response = await realFetch(root + url, { method, headers: {
        ...(user ? { Authorization: `Bearer ${jwt.sign(user, process.env.JWT_SECRET)}` } : {}),
        ...(body instanceof globalThis.FormData ? {} : { 'Content-Type': 'application/json' }),
      }, ...(body === undefined ? {} : { body: body instanceof globalThis.FormData ? body : JSON.stringify(body) }) });
      return { status: response.status, body: await response.json() };
    }
    async function upload(filename) {
      const form = new globalThis.FormData();
      form.append('images', new globalThis.Blob([Buffer.from('retained image bytes')], { type: 'image/jpeg' }), filename);
      const response = await request(`/tasks/${taskId}/images`, 'POST', form);
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.equal(response.body.images.length, 1);
      assert.ok(response.body.images[0].startsWith(`/uploads/tasks/${taskId}/`));
      return response.body.images[0];
    }
    const originalUrl = await upload('original photo.jpg');
    const stored = (await client.query('SELECT image_paths FROM task_images WHERE task_id=$1', [taskId])).rows[0].image_paths;
    assert.equal(stored.length, 1);
    assert.ok(fs.existsSync(stored[0]));
    const imageList = await request(`/tasks/${taskId}/images?date=${date}`);
    assert.deepEqual(imageList.body.images, [originalUrl]);
    assert.ok(!JSON.stringify(imageList.body).includes(path.resolve(__dirname, '..')));
    assert.equal((await request(`/tasks/${taskId}/images`, 'GET', undefined, outsider)).status, 404);
    assert.equal((await request(`/tasks/${taskId}/generate-report`, 'POST', {})).status, 200);
    let source;
    for (let attempt = 0; attempt < 100; attempt++) {
      source = (await client.query('SELECT id,image_paths FROM reports WHERE task_id=$1', [taskId])).rows[0];
      if (source) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(source, 'Background AI report should be saved');
    assert.equal(aiPayload.images[0], fs.readFileSync(stored[0]).toString('base64'));
    assert.equal(source.image_paths.length, 1);
    assert.ok(fs.existsSync(stored[0]), 'Analysis must preserve the file');
    const laterUrl = await upload('later.jpg');
    const beforeSubmitFiles = fs.readdirSync(uploadDir);
    const submission = { report_text: 'AI report\nTotal: 5', report_id: source.id };
    const submitted = await request(`/tasks/${taskId}/reports`, 'POST', submission);
    assert.equal(submitted.status, 201, JSON.stringify(submitted.body));
    assert.equal(submitted.body.data.images.length, 1, 'Later uploads must not join an earlier AI report');
    assert.equal(submitted.body.data.images[0].filename, path.basename(stored[0]));
    assert.deepEqual(fs.readdirSync(uploadDir), beforeSubmitFiles, 'Submission must not upload a second copy');
    assert.deepEqual((await client.query('SELECT image_paths FROM project_reports WHERE id=$1', [submitted.body.data.id])).rows[0].image_paths,
      source.image_paths);
    const admin = await request('/projects/REPORT-TEST/reports', 'GET', undefined, owner);
    assert.equal(admin.status, 200, JSON.stringify(admin.body));
    const report = admin.body.data.find(row => row.id === submitted.body.data.id);
    assert.deepEqual(report.images, submitted.body.data.images);
    assert.equal(report.summary, 'AI report\nTotal: 5');
    assert.equal('image_paths' in report, false);
    assert.ok(!JSON.stringify(report).includes(path.resolve(__dirname, '..')));
    const served = await realFetch(root + report.images[0].url);
    assert.equal(served.status, 200);
    assert.equal(Buffer.from(await served.arrayBuffer()).toString(), 'retained image bytes');
    assert.deepEqual(admin.body.data.find(row => row.title === 'Legacy').images, []);
    assert.equal((await request('/projects/REPORT-TEST/reports', 'GET', undefined, outsider)).status, 403);
    assert.equal((await request(`/tasks/${taskId}/reports`, 'POST', submission, null)).status, 401);
    assert.equal((await request(`/tasks/${taskId}/reports`, 'POST', submission, outsider)).status, 404);
    assert.equal((await request(`/tasks/${otherTask}/reports`, 'POST', submission)).status, 400);
    assert.equal((await request(`/tasks/${taskId}/reports`, 'POST', { ...submission, images: [`/uploads/tasks/${otherTask}/${date}/other.jpg`] })).status, 400);
    assert.equal((await request(`/tasks/${taskId}/reports`, 'POST', { ...submission, images: [source.image_paths[0].replace(/[^/]+$/, 'later.jpg')] })).status, 400);
    // No explicit image/source reference must remain image-less, even with uploads that day.
    const automatic = await request(`/tasks/${taskId}/reports`, 'POST', { report_text: 'AI report' });
    assert.equal(automatic.status, 201);
    assert.deepEqual(automatic.body.data.images, []);
    assert.equal((await request(`/tasks/${taskId}/reports`, 'POST', { report_text: 'Empty selection', images: [], report_date: date })).status, 201);
    assert.equal((await request('/tasks/not-a-uuid/reports', 'POST', submission)).status, 400);
    assert.equal((await request(`/tasks/${taskId}/reports`, 'POST', { report_text: 42 })).status, 400);
    assert.equal((await request(`/tasks/${taskId}/reports`, 'POST')).status, 400);
    for (const images of [null, 'bad', {}, [null], [42], ['/uploads/../secret.jpg'], ['https://example.test/photo.jpg']]) {
      assert.equal((await request(`/tasks/${taskId}/reports`, 'POST', { report_text: 'Malformed', report_date: date, images })).status, 400);
    }
    // Android's exact images + report_date contract works independently of an older daily AI snapshot.
    const androidBody = { report_text: 'Android image report', report_date: date, images: [laterUrl] };
    const android = await request(`/tasks/${taskId}/reports`, 'POST', androidBody);
    assert.equal(android.status, 201, JSON.stringify(android.body));
    assert.deepEqual(android.body.data.images, [{ url: laterUrl, filename: path.basename(decodeURIComponent(laterUrl)) }]);
    const multiple = await request(`/tasks/${taskId}/reports`, 'POST', { ...androidBody, images: [originalUrl, laterUrl] });
    assert.equal(multiple.status, 201);
    assert.deepEqual(multiple.body.data.images.map(image => image.url), [originalUrl, laterUrl]);
    const retry = await request(`/tasks/${taskId}/reports`, 'POST', androidBody);
    assert.equal(retry.status, 201);
    assert.deepEqual(retry.body.data.images, android.body.data.images);
    assert.deepEqual(fs.readdirSync(uploadDir), beforeSubmitFiles, 'Retries must reuse files');
    // Previous-day reports carry their own upload date when submitted later.
    await client.query("UPDATE reports SET report_date='2026-01-01' WHERE id=$1", [source.id]);
    const delayed = await request(`/tasks/${taskId}/reports`, 'POST', submission);
    assert.equal(delayed.status, 201);
    assert.equal((await client.query("SELECT TO_CHAR(report_date,'YYYY-MM-DD') AS date FROM project_reports WHERE id=$1",
      [delayed.body.data.id])).rows[0].date, '2026-01-01');
    assert.deepEqual(delayed.body.data.images, report.images);
    await require('../services/schedulerService').processPendingReports();
    const scheduled = (await client.query('SELECT image_paths FROM reports WHERE task_id=$1 AND report_date=$2', [taskId, date])).rows[0];
    assert.equal(scheduled.image_paths.length, 2, 'Scheduled AI generation must save its own image snapshot');
    const afterRegeneration = await request('/projects/REPORT-TEST/reports', 'GET', undefined, owner);
    assert.deepEqual(afterRegeneration.body.data.find(row => row.id === report.id).images, report.images,
      'Regenerating AI must not change an already submitted report');
    assert.deepEqual(afterRegeneration.body.data.find(row => row.id === android.body.data.id).images, android.body.data.images);
    assert.deepEqual(afterRegeneration.body.data.find(row => row.id === multiple.body.data.id).images, multiple.body.data.images);
    assert.deepEqual(afterRegeneration.body.data.find(row => row.id === automatic.body.data.id).images, []);
    assert.equal((await request('/projects/UNKNOWN-PROJECT/reports', 'GET', undefined, owner)).status, 403);
    await new Promise(resolve => server.close(resolve));
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    root = `http://127.0.0.1:${server.address().port}`;
    const afterRestart = await request('/projects/REPORT-TEST/reports', 'GET', undefined, owner);
    const retained = afterRestart.body.data.find(row => row.id === android.body.data.id);
    assert.deepEqual(retained.images, android.body.data.images);
    assert.equal((await realFetch(root + retained.images[0].url)).status, 200);
    process.stdout.write(JSON.stringify({ verifiedPost: { path: `/tasks/${taskId}/reports`, body: androidBody },
      verifiedGet: { path: '/projects/REPORT-TEST/reports', report: { id: retained.id, task_id: retained.task_id, images: retained.images } } }) + '\n');
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    mock.restoreAll();
    await client.query('ROLLBACK');
    client.release();
    await pool.end();
    // Only remove files inside this test's freshly generated task directory.
    const taskRoot = path.resolve(__dirname, '..', 'uploads', 'tasks', taskId);
    assert.equal(path.dirname(uploadDir), taskRoot);
    if (fs.existsSync(uploadDir)) {
      for (const filename of fs.readdirSync(uploadDir)) fs.unlinkSync(path.join(uploadDir, filename));
      fs.rmdirSync(uploadDir);
      fs.rmdirSync(taskRoot);
    }
  }
});
