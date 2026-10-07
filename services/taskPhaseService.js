const pool = require('../db');

const PHASES = [
  'Site Development', 'Structural', 'Electrical & Utilities', 'Plumbing & MEP',
  'Architectural', 'Construction Phase', 'Turnover Phase',
];
const LEGACY_PHASES = new Map([
  ['Foundation', 'Site Development'], ['Phase 1 - Foundation', 'Site Development'],
  ['Phase 2 - Structural', 'Structural'],
  ['Phase 3 - Electrical & Utilities', 'Electrical & Utilities'],
  ['Phase 4 - Plumbing & MEP', 'Plumbing & MEP'],
  ['Finishing', 'Architectural'], ['Phase 5 - Finishing', 'Architectural'],
]);
const own = (body, key) => Object.prototype.hasOwnProperty.call(body, key);

class PhaseError extends Error {
  constructor(message = 'Please select at least one valid construction phase category.') {
    super(message);
    this.status = 400;
  }
}

function normalizeLegacy(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return PHASES.includes(trimmed) ? trimmed : LEGACY_PHASES.get(trimmed) || null;
}

function phasesOf(body, required = false) {
  const arrayKey = own(body, 'construction_phase_categories') ? 'construction_phase_categories' : 'phases';
  if (!own(body, arrayKey)) {
    // Existing single-select callers remain accepted during migration.
    if (own(body, 'phase')) {
      const phase = normalizeLegacy(body.phase);
      if (!phase) throw new PhaseError();
      return [phase];
    }
    if (required) throw new PhaseError();
    return null; // Partial updates must not remove existing relations.
  }
  if (!Array.isArray(body[arrayKey]) || !body[arrayKey].length) throw new PhaseError();
  const phases = body[arrayKey].map(value => {
    if (typeof value !== 'string' || !PHASES.includes(value.trim())) throw new PhaseError();
    return value.trim();
  });
  return [...new Set(phases)];
}

// A correlated aggregate keeps one result row per task, including multi-category tasks.
function selectPhases(alias = 't') {
  return `COALESCE((SELECT jsonb_agg(tp.phase ORDER BY
    CASE WHEN tp.phase = normalize_task_phase(${alias}.phase) THEN 0 ELSE 1 END, tp.phase)
    FROM task_phases tp WHERE tp.task_id = ${alias}.id), '[]'::jsonb) AS phases`;
}

function filterPhases(parameter, alias = 't') {
  return `EXISTS (SELECT 1 FROM task_phases filter_phase
    WHERE filter_phase.task_id = ${alias}.id AND filter_phase.phase ILIKE $${parameter})`;
}

function filterValue(value) {
  if (typeof value !== 'string') throw new PhaseError('Invalid construction phase filter.');
  const trimmed = value.trim();
  // The previous ILIKE filters accepted case variants of legacy names.
  const known = [...PHASES, ...LEGACY_PHASES.keys()].find(name => name.toLowerCase() === trimmed.toLowerCase());
  return `%${known ? normalizeLegacy(known) : trimmed}%`;
}

async function replacePhases(taskId, phases, db) {
  await db.query('DELETE FROM task_phases WHERE task_id = $1', [taskId]);
  await db.query(`INSERT INTO task_phases (task_id, phase)
    SELECT $1::uuid, selected.phase FROM unnest($2::text[]) selected(phase)`, [taskId, phases]);
}

async function withPhases(task, db = pool) {
  if (!task) return task;
  const { rows } = await db.query(`SELECT ${selectPhases()} FROM tasks t WHERE t.id = $1`, [task.id]);
  return { ...task, phases: rows[0]?.phases || [] };
}

module.exports = { PHASES, PhaseError, normalizeLegacy, phasesOf, selectPhases, filterPhases, filterValue, replacePhases, withPhases };
