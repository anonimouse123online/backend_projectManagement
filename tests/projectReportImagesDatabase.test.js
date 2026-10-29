'use strict';
const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const pool = require('../db');

test('project daily report images upload, persist, retrieve, and serve only to project members', async () => {
  const client = await pool.connect();
  const schema = `project_report_images_${randomUUID().replaceAll('-', '')}`;
  const projectId = randomUUID();
  const ownerId = randomUUID();
  const outsiderId = randomUUID();
  const uploadDir = path.resolve(__dirname, '..', 'uploads', 'project-reports', projectId);
  let server;
  try {
    await client.query('BEGIN');
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET LOCAL search_path TO "${schema}"`);
    await client.query(`CREATE TABLE users (id UUID PRIMARY KEY, full_name TEXT, email TEXT UNIQUE, role TEXT,
      is_active BOOLEAN DEFAULT TRUE, email_verified BOOLEAN DEFAULT TRUE);
      CREATE TABLE projects (id UUID PRIMARY KEY, code TEXT UNIQUE, name TEXT, location TEXT, status TEXT,
        owner_id UUID, start_date DATE, end_date DATE);
      CREATE TABLE project_members (project_id TEXT, user_id UUID, user_name TEXT);
      CREATE TABLE tasks (id UUID PRIMARY KEY, project_id UUID, assignee_id UUID);
      CREATE TABLE project_reports (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), project_code TEXT NOT NULL,
        task_id UUID, title TEXT NOT NULL, report_type TEXT NOT NULL DEFAULT 'Daily Site Log', report_date DATE NOT NULL DEFAULT CURRENT_DATE,
        prepared_by UUID, summary TEXT NOT NULL, key_activities TEXT, issues_highlighted TEXT,
        manpower_count INTEGER DEFAULT 0, equipment_on_site TEXT, weather TEXT DEFAULT 'Clear',
        image_paths JSONB NOT NULL DEFAULT '[]'::jsonb, status TEXT DEFAULT 'Final', created_at TIMESTAMPTZ DEFAULT NOW());`);
    await client.query(`INSERT INTO users(id,full_name,email,role) VALUES
      ($1,'Report owner','owner@example.test','Admin'),($2,'Outside user','outsider@example.test','Site Engineer')`, [ownerId, outsiderId]);
    await client.query("INSERT INTO projects(id,code,name,status,owner_id) VALUES ($1,'REPORT-IMAGES','Image project','Active',$2)", [projectId, ownerId]);
    await client.query("INSERT INTO projects(id,code,name,status,owner_id) VALUES ($1,'REPORT-OTHER','Other project','Active',$2)", [randomUUID(), outsiderId]);

    mock.method(pool, 'query', (statement, values) => client.query(statement, values));
    mock.method(pool, 'connect', async () => ({
      async query(statement, values) {
        if (statement === 'BEGIN') return client.query('SAVEPOINT project_report_request');
        if (statement === 'COMMIT') return client.query('RELEASE SAVEPOINT project_report_request');
        if (statement === 'ROLLBACK') return client.query('ROLLBACK TO SAVEPOINT project_report_request');
        return client.query(statement, values);
      },
      release() {},
    }));
    mock.method(console, 'log', () => {});
    mock.method(console, 'error', () => {});

    const app = express();
    app.use(express.json());
    app.use('/projects', require('../routes/project'));
    app.use('/uploads', require('../middlewares/projectFileAccess'), express.static(path.resolve(__dirname, '..', 'uploads')));
    app.use((error, _req, res, _next) => res.status(error.status || 500).json({ message: error.message }));
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
    const root = `http://127.0.0.1:${server.address().port}`;
    const tokenFor = id => jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: '5m' });
    async function request(url, id = ownerId, method = 'GET', body) {
      const headers = id ? { Authorization: `Bearer ${tokenFor(id)}` } : {};
      let payload = body;
      if (body && !(body instanceof FormData)) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
      const response = await fetch(root + url, { method, headers, body: payload });
      return { response, body: response.headers.get('content-type')?.includes('json') ? await response.json() : await response.arrayBuffer() };
    }

    const form = new FormData();
    form.append('images', new Blob([Buffer.from('report image one')], { type: 'image/png' }), 'one.png');
    form.append('images', new Blob([Buffer.from('report image two')], { type: 'image/png' }), 'two.png');
    const uploaded = await request('/projects/REPORT-IMAGES/reports/images', ownerId, 'POST', form);
    assert.equal(uploaded.response.status, 201);
    assert.equal(uploaded.body.data.length, 2);
    const imageReferences = uploaded.body.data;
    assert.deepEqual(uploaded.body.images.map(image => image.url), imageReferences);

    const wrongProjectReference = await request('/projects/REPORT-IMAGES/reports', ownerId, 'POST', {
      title: 'Wrong attachment', summary: 'Foreign reference',
      images: [`/uploads/project-reports/${randomUUID()}/foreign.png`],
    });
    assert.equal(wrongProjectReference.response.status, 400);
    const negativeManpower = await request('/projects/REPORT-IMAGES/reports', ownerId, 'POST', {
      title: 'Invalid manpower', summary: 'Negative count', manpower_count: -1,
    });
    assert.equal(negativeManpower.response.status, 400);

    const created = await request('/projects/REPORT-IMAGES/reports', ownerId, 'POST', {
      title: 'Daily site report', summary: 'Concrete placement complete', report_date: '2026-10-29', manpower_count: 23,
      images: imageReferences,
    });
    assert.equal(created.response.status, 201, JSON.stringify(created.body));
    const report = created.body.data;
    assert.equal(report.manpower_count, 23);
    assert.deepEqual(report.images.map(image => image.url), imageReferences);
    assert.deepEqual((await client.query('SELECT image_paths FROM project_reports WHERE id=$1', [report.id])).rows[0].image_paths, imageReferences);

    const list = await request('/projects/REPORT-IMAGES/reports');
    assert.equal(list.response.status, 200);
    assert.deepEqual(list.body.data[0].images.map(image => image.url), imageReferences);
    const detailResponse = await request(imageReferences[0]);
    assert.equal(detailResponse.response.status, 200);
    assert.equal(detailResponse.response.headers.get('content-type'), 'image/png');
    assert.equal(Buffer.from(detailResponse.body).toString(), 'report image one');
    assert.equal((await request(imageReferences[0].replace(/[^/]+$/, 'missing.png'))).response.status, 404);
    assert.equal((await request(imageReferences[0], null)).response.status, 401);
    assert.equal((await request(imageReferences[0], outsiderId)).response.status, 404);

    const noImageReport = await request('/projects/REPORT-IMAGES/reports', ownerId, 'POST', {
      title: 'No photo report', summary: 'Legacy-compatible report', manpower_count: 0,
    });
    assert.equal(noImageReport.response.status, 201);
    assert.deepEqual(noImageReport.body.data.images, []);

    const cleared = await request(`/projects/REPORT-IMAGES/reports/${report.id}`, ownerId, 'PATCH', { images: [] });
    assert.equal(cleared.response.status, 200);
    assert.deepEqual(cleared.body.data.images, []);
    assert.equal((await request('/projects/REPORT-IMAGES/reports', outsiderId)).response.status, 404);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await client.query('ROLLBACK');
    client.release();
    if (fs.existsSync(uploadDir)) fs.rmSync(uploadDir, { recursive: true, force: true });
    await pool.end();
  }
});
