const pool = require('../db');

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
  if (!user?.id) throw new IssueError(401, 'Authentication required.');
  if (typeof reference !== 'string' || !reference.trim() || reference.length > 50) {
    throw new IssueError(400, 'A valid project ID or code is required.');
  }
  const { rows } = await db.query(`
    SELECT p.id, p.code, p.name, p.status, p.owner_id,
      EXISTS (
        SELECT 1 FROM project_members pm WHERE pm.project_id = p.code
        AND (pm.user_id = $2::uuid OR ($3::text IS NOT NULL
          AND lower(trim(pm.user_name)) = lower(trim($3::text))))
      ) AS is_member
    FROM projects p WHERE p.id::text = $1 OR p.code = $1 LIMIT 1
  `, [reference.trim(), user.id, user.email || null]);
  const project = rows[0];
  if (!project) throw new IssueError(404, 'Project not found.');
  if (!isAdmin(user) && project.owner_id !== user.id && !project.is_member) {
    throw new IssueError(403, 'You do not have access to this project.');
  }
  return project;
}

function requireWrite(project, user) {
  const role = roleOf(user);
  if (isAdmin(user) || project.owner_id === user.id || (project.is_member &&
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
  if (isAdmin(user) || (roleOf(user) === 'project_manager' &&
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

async function publishChange(req, project, counts, notification) {
  const io = req.app.get('io');
  if (!io) return;
  // Recompute recipients for every change so removed members receive no new data.
  const { rows } = await pool.query(`SELECT DISTINCT u.id FROM users u
    WHERE lower(trim(u.role)) = 'admin' OR u.id = $1::uuid OR EXISTS (
      SELECT 1 FROM project_members pm WHERE pm.project_id = $2
      AND (pm.user_id = u.id OR lower(trim(pm.user_name)) = lower(trim(u.email)))
    )`, [project.owner_id, project.code]);
  const namespace = io.of('/project-issues');
  const rooms = rows.map(user => `user:${user.id}`);
  if (rooms.length) namespace.to(rooms).emit('project_issues_updated', { project_id: project.id, project_code: project.code, ...counts });
  for (const item of Array.isArray(notification) ? notification : notification ? [notification] : []) {
    const notificationRooms = item.audience === 'individual' ? [`user:${item.target_user_id}`] : rooms;
    if (notificationRooms.length) namespace.to(notificationRooms).emit('new_notification', { ...item, project_name: project.name });
  }
}

module.exports = {
  STATUSES, SEVERITIES, UUID, normalize, isAdmin, countColumns, countJoin,
  IssueError, getProject, requireWrite, requireResolve, getResolver, getCounts, initializeIssueSocket, publishChange,
};
