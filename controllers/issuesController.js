const pool = require('../db');
const service = require('../services/projectIssueService');

const issueSelect = `SELECT i.*, ru.full_name AS reporter_name, ru.role AS reporter_role,
  au.full_name AS assignee_name, au.role AS assignee_role,
  CASE WHEN i.status = 'resolved' THEN latest.resolution ELSE NULL END AS resolution
  FROM project_issues i LEFT JOIN users ru ON ru.id = i.reported_by
  LEFT JOIN users au ON au.id = i.assigned_to
  LEFT JOIN LATERAL (
    SELECT jsonb_build_object('resolution_summary', r.resolution_summary,
      'resolution_steps', r.resolution_steps, 'final_remarks', r.final_remarks,
      'resolved_by', jsonb_build_object('id', r.resolved_by, 'name', resolver.full_name),
      'resolved_at', r.resolved_at) AS resolution
    FROM issue_resolutions r LEFT JOIN users resolver ON resolver.id = r.resolved_by
    WHERE r.issue_id = i.id ORDER BY r.resolved_at DESC, r.id DESC LIMIT 1
  ) latest ON TRUE`;
const referenceOf = req => req.params.projectId || req.params.code;
const idOf = req => req.params.issueId || req.params.id;
const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

function fail(res, error) {
  if (error instanceof service.IssueError) return res.status(error.status).json({ success: false, message: error.message });
  console.error('Project issue error:', error);
  return res.status(500).json({ success: false, message: 'Failed to process project issue.' });
}

function authenticated(req) {
  if (!req.user?.id) throw new service.IssueError(401, 'Authentication required.');
}

function text(value, field, required = false, max = Infinity) {
  if (typeof value !== 'string' || (required && !value.trim()) || value.length > max) {
    throw new service.IssueError(400, `Invalid ${field}.`);
  }
  return value.trim();
}

function enumValue(value, values, field) {
  const normalized = service.normalize(value);
  if (!values.includes(normalized)) throw new service.IssueError(400, `Invalid ${field}. Must be one of: ${values.join(', ')}.`);
  return normalized;
}

function severityOf(body, fallback) {
  if (own(body, 'severity') && own(body, 'priority') && service.normalize(body.severity) !== service.normalize(body.priority)) {
    throw new service.IssueError(400, 'severity and priority must agree.');
  }
  return enumValue(own(body, 'severity') ? body.severity : own(body, 'priority') ? body.priority : fallback,
    service.SEVERITIES, 'severity');
}

async function validateAssignee(assignedTo, project, db) {
  if (assignedTo === null) return;
  if (!service.UUID.test(assignedTo || '')) throw new service.IssueError(400, 'Invalid assigned_to.');
  const { rows } = await db.query(`SELECT u.id FROM users u WHERE u.id = $1 AND
    (u.id = $2 OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = $3
      AND (pm.user_id = u.id OR lower(trim(pm.user_name)) = lower(trim(u.email)))))`,
  [assignedTo, project.owner_id, project.code]);
  if (!rows.length) throw new service.IssueError(400, 'Assignee must belong to the project.');
}

async function locateIssue(req, db, user = req.user) {
  const id = idOf(req);
  if (!service.UUID.test(id || '')) throw new service.IssueError(400, 'Invalid issue ID.');
  let project;
  if (referenceOf(req)) project = await service.getProject(referenceOf(req), user, db);
  const { rows } = await db.query(`${issueSelect} WHERE i.id = $1${project ? ' AND i.project_id = $2' : ''}`,
    project ? [id, project.id] : [id]);
  if (!rows.length) throw new service.IssueError(404, 'Issue not found.');
  project ||= await service.getProject(rows[0].project_id, user, db);
  return { issue: rows[0], project };
}

// Socket errors must never turn a committed issue into a failed HTTP response.
async function publish(req, project, counts, notification) {
  try { await service.publishChange(req, project, counts, notification); }
  catch (error) { console.warn('Project issue socket update failed:', error.message); }
}

async function rollback(client) {
  try { await client.query('ROLLBACK'); }
  catch (error) { console.error('Project issue rollback failed:', error.message); }
}

exports.getProjectIssues = async (req, res) => {
  try {
    authenticated(req);
    const query = req.query;
    // Keep the legacy unfiltered response; status=active returns unresolved issues.
    const status = query.status === undefined ? 'all' : service.normalize(query.status);
    if (!['all', 'active', ...service.STATUSES].includes(status)) throw new service.IssueError(400, 'Invalid status filter.');
    const filters = [];
    const params = [];
    if (status === 'active') filters.push("i.status IN ('open', 'in_progress')");
    else if (status !== 'all') { params.push(status); filters.push(`i.status = $${params.length + 1}`); }
    if (query.category !== undefined && query.category !== 'All') {
      params.push(text(query.category, 'category', true, 100));
      filters.push(`lower(i.category) = lower($${params.length + 1})`);
    }
    if ((query.severity !== undefined || query.priority !== undefined) && query.severity !== 'All' && query.priority !== 'All') {
      params.push(severityOf(query)); filters.push(`i.severity = $${params.length + 1}`);
    }
    if (query.search !== undefined) {
      params.push(`%${text(query.search, 'search')}%`);
      filters.push(`(i.title ILIKE $${params.length + 1} OR i.description ILIKE $${params.length + 1} OR i.location ILIKE $${params.length + 1})`);
    }
    const project = await service.getProject(referenceOf(req), req.user);
    // One statement gives issues and the unfiltered active count the same snapshot.
    const { rows } = await pool.query(`SELECT
      (SELECT COUNT(*)::int FROM project_issues WHERE project_id = $1 AND status IN ('open', 'in_progress')) AS active_issue_count,
      COALESCE((SELECT jsonb_agg(to_jsonb(found) ORDER BY found.status_order, found.created_at DESC, found.id)
        FROM (SELECT enriched.*, CASE enriched.status WHEN 'open' THEN 1 WHEN 'in_progress' THEN 2 ELSE 3 END AS status_order
          FROM (${issueSelect} WHERE i.project_id = $1 ${filters.map(filter => `AND ${filter}`).join(' ')}) enriched) found), '[]'::jsonb) AS issues`,
    [project.id, ...params]);
    const issues = rows[0].issues.map(({ status_order, ...issue }) => issue);
    return res.status(200).json({ success: true, project_id: project.id,
      active_issue_count: rows[0].active_issue_count, has_active_issues: rows[0].active_issue_count > 0,
      issues, data: issues });
  } catch (error) { return fail(res, error); }
};

exports.createIssue = async (req, res) => {
  let client;
  let transaction = false;
  try {
    authenticated(req);
    const body = req.body || {};
    const title = text(body.title, 'title', true, 255);
    const description = text(body.description, 'description', true);
    // Category names remain extensible, preserving existing report categories.
    const category = body.category === undefined ? 'other' : text(body.category, 'category', true, 100);
    const severity = severityOf(body, 'medium');
    if (own(body, 'status') && enumValue(body.status, service.STATUSES, 'status') !== 'open') {
      throw new service.IssueError(400, 'New issues must have status open.');
    }
    const location = body.location == null ? null : text(body.location, 'location', false, 255);
    client = await pool.connect();
    await client.query('BEGIN'); transaction = true;
    const project = await service.getProject(referenceOf(req), req.user, client);
    service.requireWrite(project, req.user);
    if (['planning', 'draft', 'pending'].includes(service.normalize(project.status))) {
      throw new service.IssueError(400,
        'Cannot report issues because the project is in planning and not yet activated.');
    }
    // Serialize mutations per project so concurrent submissions see committed counts.
    await client.query('SELECT id FROM projects WHERE id = $1 FOR UPDATE', [project.id]);
    if (own(body, 'project_id') && body.project_id !== project.id) throw new service.IssueError(400, 'project_id does not match the URL project.');
    const assignedTo = body.assigned_to ?? null;
    await validateAssignee(assignedTo, project, client);
    const { rows } = await client.query(`INSERT INTO project_issues
      (project_id, project_code, title, description, category, severity, priority, status, reported_by, location, assigned_to)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'open', $8, $9, $10) RETURNING *`,
    [project.id, project.code, title, description, category, severity,
      severity[0].toUpperCase() + severity.slice(1), req.user.id, location, assignedTo]);
    const notificationResult = await client.query(`INSERT INTO notifications
      (title, message, audience, project_id, created_by)
      VALUES ('New Project Issue', $1, 'project', $2, $3) RETURNING *`,
    [`${project.name} has a new issue: ${title}.`, project.code, req.user.id]);
    const counts = await service.getCounts(project.id, client);
    await client.query('COMMIT'); transaction = false;
    client.release(); client = null;
    await publish(req, project, counts, notificationResult.rows[0]);
    return res.status(201).json({ success: true, message: 'Issue reported successfully.',
      project_id: project.id, ...counts, data: rows[0] });
  } catch (error) {
    if (transaction) await rollback(client);
    return fail(res, error);
  } finally { client?.release(); }
};

exports.getIssueById = async (req, res) => {
  try {
    authenticated(req);
    const { issue } = await locateIssue(req, pool);
    return res.status(200).json({ success: true, data: issue });
  } catch (error) { return fail(res, error); }
};

function resolutionOf(body) {
  const summary = text(body.resolution_summary, 'resolution_summary', true);
  if (!Array.isArray(body.resolution_steps) || !body.resolution_steps.length) {
    throw new service.IssueError(400, 'resolution_steps must be a non-empty array of steps.');
  }
  const steps = body.resolution_steps.map(step => text(step, 'resolution_steps entry', true));
  const remarks = text(body.final_remarks, 'final_remarks', true);
  return { summary, steps, remarks };
}

async function updateIssue(req, res, resolve = false) {
  let client;
  let transaction = false;
  try {
    authenticated(req);
    const body = req.body || {};
    const status = resolve ? 'resolved' : own(body, 'status') ? enumValue(body.status, service.STATUSES, 'status') : null;
    if (resolve && own(body, 'status') && enumValue(body.status, service.STATUSES, 'status') !== 'resolved') {
      throw new service.IssueError(400, 'The resolve endpoint only accepts status resolved.');
    }
    const resolving = status === 'resolved';
    const feedback = resolving ? resolutionOf(body) : null;
    const changes = [];
    const values = [];
    const add = (key, value) => { values.push(value); changes.push(`${key} = $${values.length}`); };
    for (const [key, max, required] of [['title', 255, true], ['description', Infinity, true], ['category', 100, true], ['location', 255, false], ['resolution_notes', Infinity, false]]) {
      if (own(body, key)) add(key, body[key] === null && !required ? null : text(body[key], key, required, max));
    }
    if (status) add('status', status);
    if (own(body, 'severity') || own(body, 'priority')) add('severity', severityOf(body));
    if (own(body, 'assigned_to')) add('assigned_to', body.assigned_to);
    if (own(body, 'project_id')) throw new service.IssueError(400, 'An issue cannot be moved to another project.');
    if (!changes.length) throw new service.IssueError(400, 'No update fields provided.');
    client = await pool.connect();
    await client.query('BEGIN'); transaction = true;
    // Resolution permissions use the current database role, not client fields or a stale JWT role.
    const actor = resolving ? await service.getResolver(req.user.id, client) : req.user;
    const { issue, project } = await locateIssue(req, client, actor);
    if (resolving) service.requireResolve(project, actor);
    else service.requireWrite(project, actor);
    await client.query('SELECT id FROM projects WHERE id = $1 FOR UPDATE', [project.id]);
    // Read again under the lock: a concurrent resolver may have committed since locateIssue.
    const locked = await client.query('SELECT status FROM project_issues WHERE id = $1 AND project_id = $2 FOR UPDATE',
      [issue.id, project.id]);
    if (!locked.rows.length) throw new service.IssueError(404, 'Issue not found.');
    if (resolving && locked.rows[0].status === 'resolved') throw new service.IssueError(409, 'Issue is already resolved.');
    if (own(body, 'assigned_to')) await validateAssignee(body.assigned_to, project, client);
    if (resolving) {
      const saved = await client.query(`INSERT INTO issue_resolutions
        (issue_id, resolution_summary, resolution_steps, final_remarks, resolved_by)
        VALUES ($1, $2, $3::jsonb, $4, $5) RETURNING resolved_at::text AS resolved_at`,
      [issue.id, feedback.summary, JSON.stringify(feedback.steps), feedback.remarks, actor.id]);
      add('resolved_at', saved.rows[0].resolved_at);
    } else if (status) add('resolved_at', null);
    values.push(issue.id, project.id);
    const { rows } = await client.query(`UPDATE project_issues SET ${changes.join(', ')}, updated_at = NOW()
      WHERE id = $${values.length - 1} AND project_id = $${values.length} RETURNING *`, values);
    if (!rows.length) throw new service.IssueError(404, 'Issue not found.');
    const notifications = [];
    if (resolving) {
      // Reuse the existing individual notification audience for the reporter and assignee.
      const recipients = [...new Set([rows[0].reported_by, rows[0].assigned_to].filter(Boolean))];
      for (const recipient of recipients) {
        const saved = await client.query(`INSERT INTO notifications
          (title, message, audience, project_id, target_user_id, created_by)
          VALUES ('Issue Resolved', $1, 'individual', $2, $3, $4) RETURNING *`,
        [`${rows[0].title} has been resolved by ${actor.full_name || 'a project manager'}.`, project.code, recipient, actor.id]);
        notifications.push(saved.rows[0]);
      }
    }
    const detail = await client.query(`${issueSelect} WHERE i.id = $1`, [issue.id]);
    const counts = await service.getCounts(project.id, client);
    await client.query('COMMIT'); transaction = false;
    client.release(); client = null;
    await publish(req, project, counts, notifications);
    return res.status(200).json({ success: true, message: resolving ? 'Issue resolved successfully.' : 'Issue updated successfully.',
      project_id: project.id, ...counts, data: detail.rows[0] });
  } catch (error) {
    if (transaction) await rollback(client);
    return fail(res, error);
  } finally { client?.release(); }
}

exports.updateIssue = (req, res) => updateIssue(req, res);
exports.resolveIssue = (req, res) => updateIssue(req, res, true);

exports.deleteIssue = async (req, res) => {
  let client;
  let transaction = false;
  try {
    authenticated(req);
    client = await pool.connect();
    await client.query('BEGIN'); transaction = true;
    const { issue, project } = await locateIssue(req, client);
    if (!service.isAdmin(req.user) && project.owner_id !== req.user.id) {
      throw new service.IssueError(403, 'Only the project owner or admin can delete issues.');
    }
    await client.query('SELECT id FROM projects WHERE id = $1 FOR UPDATE', [project.id]);
    const { rowCount } = await client.query('DELETE FROM project_issues WHERE id = $1 AND project_id = $2', [issue.id, project.id]);
    if (!rowCount) throw new service.IssueError(404, 'Issue not found.');
    const counts = await service.getCounts(project.id, client);
    await client.query('COMMIT'); transaction = false;
    client.release(); client = null;
    await publish(req, project, counts);
    return res.status(200).json({ success: true, message: 'Issue deleted successfully.', project_id: project.id, ...counts });
  } catch (error) {
    if (transaction) await rollback(client);
    return fail(res, error);
  } finally { client?.release(); }
};
