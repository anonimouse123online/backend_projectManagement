const pool = require('../db');
const access = require('./projectAccessService');

const STATUSES = ['open', 'in_progress', 'resolved'];
const SEVERITIES = ['low', 'medium', 'high', 'critical'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const normalize = value => typeof value === 'string'
  ? value.trim().toLowerCase().replace(/[ -]+/g, '_') : null;
const roleOf = user => normalize(user.role) || '';
const isAdmin = user => roleOf(user) === 'admin';

// Pre-aggregate once in SQL, avoiding member-join multiplication and N+1 queries.
const countColumns = `COALESCE(issue_counts.active_issue_count, 0)::int AS active_issue_count,
  (COALESCE(issue_counts.active_issue_count, 0) > 0) AS has_active_issues`;
const countJoin = `LEFT JOIN (
  SELECT project_id, COUNT(*)::int AS active_issue_count
  FROM project_issues WHERE status IN ('open', 'in_progress') GROUP BY project_id
) issue_counts ON issue_counts.project_id = p.id`;

class IssueError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function getProject(reference, user, db = pool) {
  try { return await access.getProject(reference, user, db); }
  catch (error) {
    if (error instanceof access.AccessError) throw new IssueError(error.status, error.message);
    throw error;
  }
}

function requireWrite(project, user) {
  const role = roleOf(user);
  if ((isAdmin(user) && project.is_member) || project.owner_id === user.id || ((project.is_member || project.is_assigned) &&
    (role === 'project_manager' || role === 'supervisor' || role.includes('engineer')))) return;
  throw new IssueError(403, 'Only project managers and assigned engineers or supervisors can submit or update issues.');
}

async function getCounts(projectId, db = pool) {
  const { rows } = await db.query(`SELECT COUNT(*)::int AS active_issue_count,
    (COUNT(*) > 0) AS has_active_issues FROM project_issues
    WHERE project_id = $1 AND status IN ('open', 'in_progress')`, [projectId]);
  return rows[0];
}

async function getResolver(id, db = pool) {
  if (!UUID.test(id || '')) throw new IssueError(401, 'Authentication required.');
  const { rows } = await db.query(`SELECT id, full_name, email, role FROM users
    WHERE id = $1 AND is_active = TRUE FOR SHARE`, [id]);
  if (!rows.length) throw new IssueError(401, 'An active authenticated user is required.');
  return rows[0];
}

function requireResolve(project, user) {
  if ((isAdmin(user) && (project.owner_id === user.id || project.is_member)) || (roleOf(user) === 'project_manager' &&
    (project.owner_id === user.id || project.is_member))) return;
  throw new IssueError(403, 'Only admins and project managers with project access can resolve issues.');
}

// This namespace authenticates independently; existing chat sockets keep their behavior.
function initializeIssueSocket(io) {
  const jwt = require('jsonwebtoken');
  const namespace = io.of('/project-issues');
  namespace.use((socket, next) => {
    try {
      const user = jwt.verify(socket.handshake.auth?.token, process.env.JWT_SECRET);
      if (!UUID.test(user.id || '')) throw new Error('Invalid user');
      socket.data.user = user;
      next();
    } catch {
      next(new Error('Authentication required.'));
    }
  });
  namespace.on('connection', socket => socket.join(`user:${socket.data.user.id}`));
}

async function authorizedRecipients(project) {
  const { rows } = await pool.query(`SELECT DISTINCT u.id FROM projects p
    JOIN users u ON u.is_active = TRUE
    WHERE ${project.id ? 'p.id = $1::uuid' : 'p.code = $1'} AND (u.id = p.owner_id OR EXISTS (
      SELECT 1 FROM project_members pm WHERE pm.project_id = p.code
      AND (pm.user_id = u.id OR (pm.user_id IS NULL AND to_jsonb(u)->>'email_verified' = 'true' AND lower(trim(pm.user_name)) = lower(trim(u.email))))
    ) OR EXISTS (SELECT 1 FROM tasks assigned_task WHERE assigned_task.project_id = p.id
      AND assigned_task.assignee_id = u.id))`, [project.id || project.code]);
  return new Set(rows.map(user => user.id));
}

async function revokeProjectAccess(io, project) {
  if (!io) return;
  const authorized = await authorizedRecipients(project);
  const rooms = [...new Set([project.code, project.id].filter(Boolean).map(id => `project:${id}`))];
  for (const name of ['/', '/project-issues']) {
    const sockets = await io.of(name).in(rooms).fetchSockets();
    for (const socket of sockets) {
      if (!authorized.has(socket.data.user?.id)) {
        for (const room of rooms) await socket.leave(room);
      }
    }
  }
}

async function publishChange(req, project, counts, notification) {
  const io = req.app.get('io');
  if (!io) return;
  // Validate every recipient against current ownership, membership and assignment.
  const authorized = await authorizedRecipients(project);
  const namespace = io.of('/project-issues');
  const rooms = [...authorized].map(id => `user:${id}`);
  if (rooms.length) namespace.to(rooms).emit('project_issues_updated', { project_id: project.id, project_code: project.code, ...counts });
  for (const item of Array.isArray(notification) ? notification : notification ? [notification] : []) {
    const notificationRooms = item.audience === 'individual'
      ? authorized.has(item.target_user_id) ? [`user:${item.target_user_id}`] : []
      : rooms;
    if (notificationRooms.length) namespace.to(notificationRooms).emit('new_notification', { ...item, project_name: project.name });
  }
}

module.exports = {
  STATUSES, SEVERITIES, UUID, normalize, isAdmin, countColumns, countJoin,
  IssueError, getProject, requireWrite, requireResolve, getResolver, getCounts, initializeIssueSocket, publishChange, revokeProjectAccess,
};
