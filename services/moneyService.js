class MoneyError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

// Keep decimal input as text until PostgreSQL NUMERIC performs arithmetic.
function decimalValue(value, field, { scale, maxWholeDigits, allowNegative = false } = {}) {
  const description = allowNegative ? 'a decimal value' : 'a non-negative decimal value';
  if (!['string', 'number'].includes(typeof value) ||
      (typeof value === 'number' && !Number.isFinite(value))) {
    throw new MoneyError(`${field} must be ${description}.`);
  }
  const match = String(value).trim().match(/^(-?)(\d+)(?:\.(\d+))?$/);
  if (!match || (!allowNegative && match[1]) || (scale !== undefined && (match[3] || '').length > scale)) {
    throw new MoneyError(`${field} must be ${description}${scale === undefined ? '' : ` with at most ${scale} decimal places`}.`);
  }
  const whole = match[2].replace(/^0+(?=\d)/, '');
  if (maxWholeDigits && whole.length > maxWholeDigits) {
    throw new MoneyError(`${field} exceeds the supported amount.`);
  }
  const fraction = scale === undefined ? match[3] : (match[3] || '').padEnd(scale, '0');
  // Large amounts remain exact when supplied as strings, rather than JSON numbers.
  if (typeof value === 'number' && scale === 2 &&
      BigInt(whole + fraction) > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new MoneyError(`${field} must be supplied as a decimal string for this amount.`);
  }
  return match[1] + (fraction ? `${whole}.${fraction}` : whole);
}

const moneyValue = (value, field, maxWholeDigits) => decimalValue(value, field, { scale: 2, maxWholeDigits });
const quantityValue = (value, field) => decimalValue(value, field, { allowNegative: true });

// Match resources by the same project code/name/task rules on every budget endpoint.
// Round the aggregate once; fractional quantities can yield fractions of a cent.
const resourceCost = `ROUND(COALESCE((
  SELECT SUM(COALESCE(r.quantity, 0)::numeric * COALESCE(r.unit_price, 0)::numeric)
  FROM resources r
  WHERE LOWER(TRIM(r.project)) = LOWER(TRIM(p.code))
     OR LOWER(TRIM(r.project)) = LOWER(TRIM(p.name))
     OR r.task_id IN (SELECT id FROM tasks WHERE project_id = p.id)
), 0), 2)`;

const projectBudgetColumns = `ROUND(COALESCE(p.budget, 0)::numeric, 2) AS budget_allocated,
  ${resourceCost} AS total_resource_cost,
  ${resourceCost} AS total_spent,
  ROUND(COALESCE(p.budget, 0)::numeric - ${resourceCost}, 2) AS remaining_budget`;

module.exports = { MoneyError, moneyValue, quantityValue, projectBudgetColumns };
