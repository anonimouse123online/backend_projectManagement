const FIELDS = [
  'project_name', 'engineer_name', 'date', 'work_on_site', 'supervisors',
  'sub_contractors', 'total_work_hours', 'weather', 'temperature', 'work_completed',
  'materials_delivered', 'equipment_used', 'additional_notes',
];
const own = (body, key) => Object.prototype.hasOwnProperty.call(body, key);

class TimelogError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function fieldsOf(body = {}) {
  return Object.fromEntries(FIELDS.filter(field => own(body, field)).map(field => [field, body[field]]));
}

function changesOf(body = {}) {
  const selected = fieldsOf(body);
  for (const [field, value] of Object.entries(selected)) {
    const invalid = () => { throw new TimelogError(400, `Invalid ${field}.`); };
    if (['work_on_site', 'supervisors', 'sub_contractors'].includes(field)) {
      if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '' ||
        !Number.isInteger(Number(value)) || Number(value) < 0 || Number(value) > 2147483647) invalid();
      selected[field] = Number(value);
    } else if (field === 'date') {
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) invalid();
      const date = new Date(`${value}T00:00:00Z`);
      if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) invalid();
    } else if (field === 'total_work_hours') {
      if ((typeof value !== 'string' && typeof value !== 'number') || !String(value).trim() ||
        (typeof value === 'number' && (!Number.isFinite(value) || value < 0))) invalid();
      selected[field] = String(value).trim();
    } else if (field === 'temperature') {
      if (value === null || value === '') selected[field] = null;
      else {
        if (typeof value !== 'string' && (typeof value !== 'number' || !Number.isFinite(value))) invalid();
        const temperature = String(value).trim();
        selected[field] = temperature ? (temperature.includes('°C') ? temperature : `${temperature}°C`) : null;
      }
    } else {
      const required = ['project_name', 'engineer_name'].includes(field);
      if (value === null && !required) continue;
      if (typeof value !== 'string' || (required && !value.trim())) invalid();
      const max = ['project_name', 'engineer_name'].includes(field) ? 255 : field === 'weather' ? 50 : Infinity;
      if (value.length > max) invalid();
      selected[field] = value.trim();
    }
  }
  if (!Object.keys(selected).length) throw new TimelogError(400, 'No Time Log fields provided.');
  return selected;
}

// Matches GET /timelogs: access through project ownership or membership.
function projectScope(projectName, userParameter) {
  return `EXISTS (SELECT 1 FROM projects p WHERE p.name = ${projectName} AND
    (p.owner_id = $${userParameter}::uuid OR EXISTS (SELECT 1 FROM project_members pm
      WHERE pm.project_id = p.code AND pm.user_id = $${userParameter}::uuid)))`;
}

function selectFields(alias = 'tl') {
  return ['id', ...FIELDS, 'created_at', 'updated_at'].map(field =>
    field === 'date' ? `TO_CHAR(${alias}.date, 'YYYY-MM-DD') AS date` : `${alias}.${field}`).join(', ');
}

module.exports = { FIELDS, TimelogError, fieldsOf, changesOf, projectScope, selectFields };
