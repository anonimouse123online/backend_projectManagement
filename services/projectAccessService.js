const pool = require('../db');

class AccessError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// SQL identifiers below are internal constants, never request values.
function membership(member = 'pm', parameter = 1) {
  return `(${member}.user_id = $${parameter}::uuid OR (${member}.user_id IS NULL AND EXISTS (
    SELECT 1 FROM users membership_user WHERE membership_user.id = $${parameter}::uuid
      AND membership_user.is_active = TRUE
      AND to_jsonb(membership_user)->>'email_verified' = 'true'
      AND lower(trim(membership_user.email)) = lower(trim(${member}.user_name)))))`;
}

function projectScope(project = 'p', parameter = 1) {
  return `(${project}.owner_id = $${parameter}::uuid OR EXISTS (
    SELECT 1 FROM project_members pm WHERE pm.project_id = ${project}.code
      AND ${membership('pm', parameter)}) OR EXISTS (
    SELECT 1 FROM tasks assigned_task WHERE assigned_task.project_id = ${project}.id
      AND assigned_task.assignee_id = $${parameter}::uuid))`;
}

// Names are not unique. Legacy rows are usable only when they identify exactly
// one project. A task FK takes precedence over a resource's display name.
function uniqueProjectName(expression, project = 'p') {
  return `(lower(trim(${project}.name)) = lower(trim(${expression})) AND
    (SELECT count(*) FROM projects name_match
      WHERE lower(trim(name_match.name)) = lower(trim(${expression}))) = 1)`;
}

function resourceProject(resource = 'r', project = 'p') {
  return `((${resource}.task_id IS NOT NULL AND EXISTS (SELECT 1 FROM tasks resource_task
      WHERE resource_task.id = ${resource}.task_id AND resource_task.project_id = ${project}.id))
    OR (${resource}.task_id IS NULL AND
      (SELECT count(*) FROM projects resource_match WHERE
        lower(trim(resource_match.code)) = lower(trim(${resource}.project)) OR
        lower(trim(resource_match.name)) = lower(trim(${resource}.project))) = 1 AND
      (lower(trim(${resource}.project)) = lower(trim(${project}.code)) OR
       lower(trim(${resource}.project)) = lower(trim(${project}.name)))))`;
}

async function getProject(reference, user, db = pool) {
  if (!user?.id) throw new AccessError(401, 'Authentication required.');
  if (typeof reference !== 'string' || !reference.trim()) throw new AccessError(400, 'Project is required.');
  const { rows } = await db.query(`SELECT p.*,
    EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.code AND ${membership('pm', 2)}) AS is_member,
    EXISTS (SELECT 1 FROM tasks assigned_task WHERE assigned_task.project_id = p.id
      AND assigned_task.assignee_id = $2::uuid) AS is_assigned
    FROM projects p WHERE (p.id::text = $1 OR lower(p.code) = lower($1))
      AND ${projectScope('p', 2)}`, [reference.trim(), user.id]);
  if (rows.length !== 1) throw new AccessError(404, 'Project not found or access denied.');
  return rows[0];
}

function requireManage(project, user) {
  // Member position is self-editable display data, not an authority source.
  // Preserve existing owner-only management and allow scoped admin members.
  if (project.owner_id === user.id || (project.is_member &&
      ['admin', 'project manager', 'project_manager', 'supervisor'].includes(user.role?.trim().toLowerCase()))) return;
  throw new AccessError(403, 'Project management permission required.');
}

async function getTask(id, user, db = pool) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id || '')) {
    throw new AccessError(400, 'Invalid task ID.');
  }
  const { rows } = await db.query('SELECT id, project_id, assignee_id FROM tasks WHERE id::text = $1', [id]);
  if (!rows.length) throw new AccessError(404, 'Task not found.');
  return { ...rows[0], project: await getProject(rows[0].project_id, user, db) };
}

async function getNamedProject(name, user, db = pool) {
  if (typeof name !== 'string' || !name.trim()) throw new AccessError(400, 'Project name is required.');
  const { rows } = await db.query(`SELECT p.id FROM projects p WHERE ${uniqueProjectName('$1')}`, [name]);
  if (rows.length !== 1) throw new AccessError(404, 'Project name is missing or ambiguous. Use a unique project name.');
  return getProject(rows[0].id, user, db);
}

module.exports = { AccessError, membership, projectScope, uniqueProjectName, resourceProject,
  getProject, getTask, getNamedProject, requireManage };
