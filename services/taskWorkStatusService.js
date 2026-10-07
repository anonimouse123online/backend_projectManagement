const taskPhases = require('./taskPhaseService');
const { randomUUID } = require('node:crypto');
const TERMINAL_STATUSES = new Set(['completed', 'done', 'approved', 'verified', 'closed', 'cancelled']);
const keyOf = value => typeof value === 'string' ? value.trim().toLowerCase() : '';

class WorkStatusError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function workStatus(value) {
  const key = keyOf(value);
  if (key === 'pending') return 'pending';
  if (['ongoing', 'in progress', 'in-progress'].includes(key)) return 'ongoing';
  throw new WorkStatusError(400, 'Work status must be Pending or Ongoing.');
}

function statusValue(value) {
  const key = keyOf(value);
  if (TERMINAL_STATUSES.has(key)) return key;
  return workStatus(value);
}

// Task column storage follows the existing PostgreSQL lifecycle; API values stay normalized.
function databaseStatus(value) {
  const status = statusValue(value);
  if (status === 'pending') return 'Pending';
  if (status === 'ongoing') return 'In Progress';
  return status === 'done' ? 'Completed' : status[0].toUpperCase() + status.slice(1);
}

function displayStatus(value, completed = false) {
  if (completed) return 'completed';
  if (!keyOf(value)) return 'pending';
  const key = keyOf(value);
  return ['in progress', 'in-progress'].includes(key) ? 'ongoing' : key;
}

function progressValue(value) {
  if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '' ||
      !Number.isInteger(Number(value)) || Number(value) < 0 || Number(value) > 100) {
    throw new WorkStatusError(400, 'Progress must be an integer from 0 to 100.');
  }
  return Number(value);
}

async function requireWrite(task, user, db) {
  if (String(task.owner_id) === String(user.id)) return;
  const role = keyOf(user.role || user.system_role || (await db.query('SELECT role FROM users WHERE id = $1::uuid', [user.id])).rows[0]?.role);
  if (role.includes('engineer') && String(task.assignee_id) !== String(user.id)) {
    throw new WorkStatusError(403, 'Engineers can only update tasks assigned to them.');
  }
}

function subtaskFields(item) {
  return {
    ...item,
    status: displayStatus(item.status, item.completed),
    progress: item.progress ?? item.progress_pct ?? (item.completed ? 100 : 0),
  };
}

function taskFields(task) {
  if (!task) return task;
  return {
    ...task,
    status: displayStatus(task.status),
    progress: task.progress_pct ?? task.progress ?? 0,
    subtasks: (Array.isArray(task.subtasks) ? task.subtasks : []).map(subtaskFields),
  };
}

function mergeSubtasks(current, incoming) {
  if (!Array.isArray(incoming)) throw new WorkStatusError(400, 'subtasks must be an array.');
  const existing = new Map((Array.isArray(current) ? current : []).map(item => [String(item.id), item]));
  const ids = new Set();
  return incoming.map((input, index) => {
    if (!input || typeof input !== 'object' || typeof input.title !== 'string' || typeof input.completed !== 'boolean') {
      throw new WorkStatusError(400, 'Each subtask requires a title and completion flag.');
    }
    // Older full-array callers omit IDs; retain positional IDs or assign new ones.
    const item = { ...input, id: String(input.id || current?.[index]?.id || randomUUID()) };
    if (ids.has(item.id)) throw new WorkStatusError(400, 'Subtask IDs must be unique.');
    ids.add(item.id);
    const saved = existing.get(item.id) || {};
    const merged = subtaskFields({ ...saved, ...item,
      status: item.status ?? saved.status,
      progress: item.progress ?? item.progress_pct ?? saved.progress ?? saved.progress_pct,
    });
    if (item.status != null) merged.status = statusValue(item.status);
    if (!Number.isInteger(merged.progress) || merged.progress < 0 || merged.progress > 100) {
      throw new WorkStatusError(400, 'Subtask progress must be an integer from 0 to 100.');
    }
    // Completing/unchecking retains the existing binary completion workflow.
    if (item.completed || (existing.has(item.id) && item.completed !== saved.completed)) {
      merged.progress = item.completed ? 100 : 0;
      merged.status = item.completed ? 'completed' : 'pending';
    }
    return merged;
  });
}

async function saveWorkStatus({ taskId, userId, user = { id: userId }, status, progress, subtaskId }, pool, getAccessibleTask) {
  const requested = status === undefined ? undefined : subtaskId === undefined ? statusValue(status) : workStatus(status);
  const requestedProgress = progress === undefined ? undefined : progressValue(progress);
  if (requested === undefined && requestedProgress === undefined) throw new WorkStatusError(400, 'A status or progress value is required.');
  if (subtaskId !== undefined && (typeof subtaskId !== 'string' || !subtaskId.trim())) {
    throw new WorkStatusError(400, 'A subtask ID is required.');
  }
  const client = await pool.connect();
  let transaction = false;
  try {
    await client.query('BEGIN'); transaction = true;
    const accessible = await getAccessibleTask(taskId, userId, client);
    if (!accessible) throw new WorkStatusError(404, 'Task not found or you do not have access.');
    if ((subtaskId !== undefined || ['pending', 'ongoing'].includes(requested)) &&
        ['planning', 'draft', 'pending'].includes(keyOf(accessible.project_status))) {
      throw new WorkStatusError(400, 'Work status cannot be changed before the project is activated.');
    }
    const current = (await client.query('SELECT * FROM tasks WHERE id = $1::uuid FOR UPDATE', [taskId])).rows[0];
    if (!current) throw new WorkStatusError(404, 'Task not found.');
    await requireWrite({ ...accessible, assignee_id: current.assignee_id }, user, client);
    if (['pending', 'ongoing'].includes(requested) && TERMINAL_STATUSES.has(keyOf(current.status))) {
      throw new WorkStatusError(409, 'Finished or cancelled tasks cannot change work status.');
    }
    let result;
    if (subtaskId === undefined) {
      const stored = requested === undefined ? null : databaseStatus(requested);
      const completed = ['completed', 'done'].includes(requested);
      const subtasks = completed ? JSON.stringify((Array.isArray(current.subtasks) ? current.subtasks : [])
        .map(item => ({ ...item, completed: true, status: 'completed', progress: 100 }))) : null;
      result = await client.query(
        `UPDATE tasks SET status = COALESCE($1, status), progress_pct = COALESCE($2, progress_pct),
          subtasks = COALESCE($3::jsonb, subtasks), updated_at = NOW() WHERE id = $4::uuid RETURNING *`,
        [stored, completed ? 100 : requestedProgress ?? null, subtasks, taskId]);
    } else {
      const subtasks = Array.isArray(current.subtasks) ? current.subtasks : [];
      const item = subtasks.find(subtask => String(subtask.id) === subtaskId);
      if (!item) throw new WorkStatusError(404, 'Subtask not found.');
      if (item.completed || TERMINAL_STATUSES.has(keyOf(item.status))) {
        throw new WorkStatusError(409, 'Completed subtasks cannot change work status.');
      }
      // Lock and merge the stored array, so updating one item cannot overwrite siblings.
      const updated = subtasks.map(subtask => String(subtask.id) === subtaskId
        ? { ...subtaskFields(subtask), ...(requested === undefined ? {} : { status: requested }),
          ...(requestedProgress === undefined ? {} : { progress: requestedProgress,
            ...(Object.hasOwn(subtask, 'progress_pct') ? { progress_pct: requestedProgress } : {}) }) } : subtask);
      result = await client.query(
        'UPDATE tasks SET subtasks = $1::jsonb, updated_at = NOW() WHERE id = $2::uuid RETURNING *',
        [JSON.stringify(updated), taskId]);
    }
    const data = await taskPhases.withPhases(result.rows[0], client);
    await client.query('COMMIT'); transaction = false;
    return taskFields(data);
  } catch (error) {
    if (transaction) {
      try { await client.query('ROLLBACK'); }
      catch (rollbackError) { console.error('Task status rollback failed:', rollbackError.message); }
    }
    throw error;
  } finally { client.release(); }
}

async function saveSubtasks({ taskId, user, subtasks }, pool, getAccessibleTask) {
  if (!Array.isArray(subtasks)) throw new WorkStatusError(400, 'subtasks must be an array.');
  const client = await pool.connect();
  let transaction = false;
  try {
    await client.query('BEGIN'); transaction = true;
    const accessible = await getAccessibleTask(taskId, user.id, client);
    if (!accessible) throw new WorkStatusError(404, 'Task not found or you do not have access.');
    const current = (await client.query('SELECT * FROM tasks WHERE id = $1::uuid FOR UPDATE', [taskId])).rows[0];
    if (!current) throw new WorkStatusError(404, 'Task not found.');
    await requireWrite({ ...accessible, assignee_id: current.assignee_id }, user, client);
    if (['planning', 'draft', 'pending'].includes(keyOf(accessible.project_status))) {
      throw new WorkStatusError(400, 'Subtasks cannot be modified before the project is activated.');
    }
    const saved = Array.isArray(current.subtasks) ? current.subtasks : [];
    const merged = mergeSubtasks(saved, subtasks);
    const existing = new Map(saved.map(item => [String(item.id), item]));
    const completionChanged = saved.length !== merged.length || merged.some(item => existing.get(item.id)?.completed !== item.completed);
    const pct = completionChanged ? (merged.length ? Math.round(merged.filter(item => item.completed).length / merged.length * 100) : 0)
      : current.progress_pct;
    const status = completionChanged ? (pct === 100 ? 'Completed' : pct > 0 ? 'ongoing' : 'pending') : current.status;
    const { rows } = await client.query(`UPDATE tasks SET subtasks = $1::jsonb,
      progress_pct = $2, status = $3, updated_at = NOW() WHERE id = $4::uuid RETURNING *`,
    [JSON.stringify(merged), pct, status, taskId]);
    const data = await taskPhases.withPhases(rows[0], client);
    await client.query('COMMIT'); transaction = false;
    return { data: taskFields(data), completionChanged };
  } catch (error) {
    if (transaction) {
      try { await client.query('ROLLBACK'); }
      catch (rollbackError) { console.error('Subtask rollback failed:', rollbackError.message); }
    }
    throw error;
  } finally { client.release(); }
}

module.exports = { WorkStatusError, workStatus, statusValue, databaseStatus, displayStatus, progressValue, requireWrite, subtaskFields, taskFields, mergeSubtasks, saveWorkStatus, saveSubtasks };
