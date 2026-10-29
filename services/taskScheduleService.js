'use strict';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function dateOnlyString(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    // pg may decode DATE as a local-midnight Date. Use its calendar fields so
    // serializing the value never shifts the database date across timezones.
    const pad = part => String(part).padStart(2, '0');
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  }
  return typeof value === 'string' ? value : null;
}

function parseDate(value) {
  const normalized = dateOnlyString(value);
  if (typeof normalized !== 'string' || !DATE.test(normalized)) return null;
  const date = new Date(`${normalized}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === normalized ? date : null;
}

function dateString(date) { return date.toISOString().slice(0, 10); }
function nextWorkingDay(date, holidays) {
  const next = new Date(date);
  do { next.setUTCDate(next.getUTCDate() + 1); }
  while (next.getUTCDay() === 0 || next.getUTCDay() === 6 || holidays.has(dateString(next)));
  return next;
}

function completionDate(start, duration, holidays) {
  const day = new Date(start);
  let completed = 0;
  while (completed < duration) {
    if (day.getUTCDay() !== 0 && day.getUTCDay() !== 6 && !holidays.has(dateString(day))) completed++;
    if (completed < duration) day.setUTCDate(day.getUTCDate() + 1);
  }
  return day;
}

function workingDays(start, end, holidays) {
  let count = 0;
  for (const day = new Date(start); day <= end; day.setUTCDate(day.getUTCDate() + 1)) {
    if (day.getUTCDay() !== 0 && day.getUTCDay() !== 6 && !holidays.has(dateString(day))) count++;
  }
  return count;
}

class ScheduleError extends Error {
  constructor(message, result) { super(message); this.result = result; this.status = 400; }
}

async function validateSchedule({ db, project, taskId = null, taskName = 'This task', startDate, dueDate, assigneeId = null,
  estimatedDurationDays = null, predecessorIds = [] }) {
  const result = { status: 'VALID', warnings: [], errors: [], suggestions: [] };
  const invalid = message => { result.status = 'INVALID'; result.errors.push(message); };
  const warn = message => { if (result.status !== 'INVALID') result.status = 'WARNING'; result.warnings.push(message); };

  const start = startDate == null || startDate === '' ? null : parseDate(startDate);
  const due = dueDate == null || dueDate === '' ? null : parseDate(dueDate);
  if ((startDate && !start) || (dueDate && !due)) invalid('Task dates must use a valid YYYY-MM-DD date.');
  if (start && due && start > due) invalid('Task start date cannot be after its due date.');
  const projectStart = project.start_date && parseDate(project.start_date);
  const projectEnd = project.end_date && parseDate(project.end_date);
  if (start && projectStart && start < projectStart) invalid(`Task start date cannot be before project start date (${dateString(projectStart)}).`);
  if (due && projectStart && due < projectStart) invalid(`Task due date cannot be before project start date (${dateString(projectStart)}).`);
  if (start && projectEnd && start > projectEnd) invalid(`Task start date cannot be after project end date (${dateString(projectEnd)}).`);
  if (due && projectEnd && due > projectEnd) invalid(`Task due date cannot be after project end date (${dateString(projectEnd)}).`);

  if (!start || !due) {
    result.status = result.status === 'INVALID' ? 'INVALID' : 'INSUFFICIENT_DATA';
    result.warnings.push('Both task start and due dates are needed for schedule validation.');
  }

  const holidaysResult = await db.query('SELECT TO_CHAR(holiday_date, \'YYYY-MM-DD\') AS day FROM project_holidays WHERE project_id = $1', [project.id]);
  const holidays = new Set(holidaysResult.rows.map(row => row.day));

  const duration = estimatedDurationDays == null || estimatedDurationDays === '' ? null : Number(estimatedDurationDays);
  if (duration !== null && (!Number.isInteger(duration) || duration < 1 || duration > 3650)) {
    invalid('Estimated duration must be a positive whole number of working days.');
  } else if (start && due && duration !== null) {
    const available = workingDays(start, due, holidays);
    result.availableWorkingDays = available;
    result.estimatedDurationDays = duration;
    if (available < duration) {
      invalid(`Potentially Unrealistic Schedule: ${taskName} requires an estimated ${duration} working days, but only ${available} working days are available.`);
      const suggested = completionDate(start, duration, holidays);
      result.suggestions.push({ dueDate: dateString(suggested), reason: 'Earliest completion from the proposed start using the configured working calendar.' });
    }
  } else if (result.status !== 'INVALID') {
    result.status = 'INSUFFICIENT_DATA';
    result.warnings.push('No estimated task duration is recorded; feasibility cannot be calculated reliably.');
  }

  const predecessors = [...new Set(predecessorIds)];
  if (predecessors.length) {
    const found = await db.query(`SELECT id::text, task_name, due_date::text FROM tasks
      WHERE project_id = $1 AND id = ANY($2::uuid[]) AND ($3::uuid IS NULL OR id <> $3::uuid)`,
    [project.id, predecessors, taskId]);
    if (found.rows.length !== predecessors.length) invalid('Every predecessor must be an existing task in the same project.');
    for (const predecessor of found.rows) {
      const predecessorDue = parseDate(predecessor.due_date);
      if (!predecessorDue) {
        warn(`Predecessor ${predecessor.task_name} has no due date; dependency timing could not be checked.`);
      } else if (start && predecessorDue >= start) {
        invalid(`Schedule Conflict: ${taskName} cannot begin on ${startDate} because ${predecessor.task_name} is scheduled to finish on ${predecessor.due_date}.`);
        const earliest = nextWorkingDay(predecessorDue, holidays);
        result.suggestions.push({ startDate: dateString(earliest), reason: `After predecessor ${predecessor.task_name} completes.` });
      }
    }
    if (found.rows.length) {
      const cycle = taskId ? await db.query(`WITH RECURSIVE upstream(id) AS (
        SELECT unnest($2::uuid[])
        UNION
        SELECT d.predecessor_task_id FROM task_dependencies d JOIN upstream x ON d.task_id = x.id
      ) SELECT 1 FROM upstream WHERE id = $1::uuid LIMIT 1`, [taskId, predecessors]) : { rows: [] };
      if (cycle.rows.length) invalid('Task dependencies cannot create a scheduling cycle.');
    }
  }

  if (start && due && assigneeId) {
    const overlap = await db.query(`SELECT task_name, due_date::text FROM tasks
      WHERE project_id = $1 AND assignee_id = $2 AND due_date IS NOT NULL
        AND ($3::uuid IS NULL OR id <> $3::uuid)
        AND COALESCE(start_date, due_date) <= $4::date AND due_date >= $5::date LIMIT 5`,
    [project.id, assigneeId, taskId, dueDate, startDate]);
    for (const row of overlap.rows) warn(`Assigned person also has overlapping task “${row.task_name}” (due ${row.due_date}); review resource availability.`);
  }

  return result;
}

async function persistDependencies(db, taskId, predecessorIds) {
  const ids = [...new Set(predecessorIds || [])];
  await db.query('DELETE FROM task_dependencies WHERE task_id = $1', [taskId]);
  if (ids.length) await db.query(`INSERT INTO task_dependencies (task_id, predecessor_task_id)
    SELECT $1, unnest($2::uuid[])`, [taskId, ids]);
}

module.exports = { ScheduleError, dateOnlyString, parseDate, workingDays, completionDate, validateSchedule, persistDependencies };
