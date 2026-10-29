const pool = require('../db');
const access = require('../services/projectAccessService');
const { guard } = require('./projectAccess');

const resource = guard(async req => {
  if (req.method === 'GET') return;
  if (req.params.id) {
    const { rows } = await pool.query(`SELECT p.id FROM resources r JOIN projects p
      ON ${access.resourceProject()} WHERE r.id::text = $1`, [req.params.id]);
    if (rows.length !== 1) throw new access.AccessError(404, 'Resource not found or project is ambiguous.');
    req.resourceProject = await access.getProject(rows[0].id, req.user);
    access.requireManage(req.resourceProject, req.user);
  }
  if (req.method === 'DELETE') return;
  const { project, taskId } = req.body || {};
  let target;
  if (taskId && taskId !== 'none') {
    target = (await access.getTask(taskId, req.user)).project;
    if (![target.name, target.code].includes(project)) throw new access.AccessError(400, 'Task and project must match.');
  } else {
    const { rows } = await pool.query(`SELECT id FROM projects WHERE
      lower(trim(code)) = lower(trim($1)) OR lower(trim(name)) = lower(trim($1))`, [project]);
    if (rows.length !== 1) throw new access.AccessError(400, 'Select an unambiguous project code.');
    target = await access.getProject(rows[0].id, req.user);
  }
  access.requireManage(target, req.user);
});

const software = guard(async req => {
  if (req.params.id) {
    const { rows } = await pool.query('SELECT project_id FROM software WHERE id::text = $1', [req.params.id]);
    if (!rows[0]?.project_id) throw new access.AccessError(404, 'Software not found.');
    const project = await access.getProject(rows[0].project_id, req.user);
    if (req.method !== 'GET') access.requireManage(project, req.user);
  }
  if (req.params.projectId) await access.getProject(req.params.projectId, req.user);
  if (req.method === 'POST' || Object.hasOwn(req.body || {}, 'project_id')) {
    const project = await access.getProject(req.body?.project_id, req.user);
    access.requireManage(project, req.user);
  }
});

const timelog = guard(async req => {
  if (req.params.id) {
    if (!/^(?:[1-9][0-9]*|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(req.params.id)) {
      throw new access.AccessError(400, 'Invalid time log ID.');
    }
    const { rows } = await pool.query('SELECT project_name FROM time_logs WHERE id::text = $1', [req.params.id]);
    if (!rows.length) throw new access.AccessError(404, 'Time log not found.');
    await access.getNamedProject(rows[0].project_name, req.user);
  }
  if (req.method === 'POST' || Object.hasOwn(req.body || {}, 'project_name')) {
    await access.getNamedProject(req.body?.project_name, req.user);
  }
});

module.exports = { resource, software, timelog };
