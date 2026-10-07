const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const money = require('../services/moneyService');
const pool = require('../db');
const projects = require('../controllers/projectController');
const resources = require('../controllers/resourceController');
const tasks = require('../controllers/taskController');

const response = () => ({
  code: 200,
  status(code) { this.code = code; return this; },
  json(body) { this.body = body; return this; },
});
const projectBody = {
  code: 'MONEY-TEST', name: 'Project', location: 'Site', scope: 'Build', client: 'Client',
  start_date: '2099-01-01', end_date: '2099-12-31',
};

test('money accepts numbers and decimal strings, zero and the full budget range without rounding input', () => {
  for (const [value, expected] of [
    [10000, '10000.00'], [1500.5, '1500.50'], [999.99, '999.99'],
    ['10000', '10000.00'], ['1500.5', '1500.50'], ['999.99', '999.99'],
    [0, '0.00'], [' 00012.30 ', '12.30'], ['9999999999999.99', '9999999999999.99'],
  ]) assert.equal(money.moneyValue(value, 'budget', 13), expected);
  assert.equal(money.quantityValue('2.125', 'quantity'), '2.125');
  assert.equal(money.quantityValue('-2.125', 'quantity'), '-2.125');
  assert.equal(money.moneyValue('99999999999999999.99', 'unitPrice'), '99999999999999999.99');
});

test('money rejects invalid types, nonfinite, negative, excess decimals and overflowing budgets', () => {
  for (const value of [undefined, null, '', ' ', true, false, [], {}, NaN, Infinity, -Infinity,
    -1, '-0.01', '12oops', '1,500.50', '1.234', 1.234, '10000000000000']) {
    assert.throws(() => money.moneyValue(value, 'budget', 13), money.MoneyError);
  }
  assert.throws(() => money.moneyValue(100000000000000, 'unitPrice'), /decimal string/);
});

test('project/resource writes pass exact decimal strings to PostgreSQL and preserve response shapes', async () => {
  const query = mock.method(pool, 'query', async (sql, values) => {
    if (/INSERT INTO projects/.test(sql)) return { rows: [{ budget: values[5] }] };
    if (/INSERT INTO resources|UPDATE resources/.test(sql)) {
      return { rows: [{ unitPrice: values[6], quantity: values[3] }] };
    }
    return { rows: [] };
  });
  try {
    for (const amount of [10000, 1500.5, 999.99, 0]) {
      const expected = money.moneyValue(amount, 'budget');
      let res = response();
      await projects.createProject({ user: { id: 'owner' }, body: { ...projectBody, budget: amount } }, res);
      assert.equal(res.code, 201, JSON.stringify(res.body));
      assert.equal(res.body.data.budget, expected);
      for (const handler of [resources.createResource, resources.updateResource]) {
        res = response();
        await handler({ params: { id: '1' }, body: {
          name: 'Material', category: 'Material', unitPrice: amount, quantity: '2.125',
        } }, res);
        assert.equal(res.code, handler === resources.createResource ? 201 : 200);
        assert.deepEqual(res.body, { success: true, data: { unitPrice: expected, quantity: '2.125' } });
      }
    }
    assert.ok(query.mock.calls.length > 0);
  } finally { mock.restoreAll(); }
});

test('invalid money fails with HTTP 400 before project, resource or task writes', async () => {
  const query = mock.method(pool, 'query', () => { throw new Error('Unexpected query'); });
  const connect = mock.method(pool, 'connect', () => { throw new Error('Unexpected connection'); });
  mock.method(console, 'log', () => {});
  try {
    for (const amount of [-1, '1.234', '12oops', true, Infinity]) {
      let res = response();
      await projects.createProject({ user: { id: 'owner' }, body: { ...projectBody, budget: amount } }, res);
      assert.equal(res.code, 400);
      for (const handler of [resources.createResource, resources.updateResource]) {
        res = response();
        await handler({ params: { id: '1' }, body: { unitPrice: amount } }, res);
        assert.equal(res.code, 400);
      }
      for (const priceField of ['unitPrice', 'unit_price']) {
        res = response();
        await tasks.createTask({ user: { id: 'owner' }, body: {
          taskName: 'Task', phase: 'Structural', projectId: 'MONEY-TEST', assigneeId: 'engineer',
          dueDate: '2099-01-01', priority: 'Medium', materialsRequired: 'Material', siteInstructions: 'Install',
          allocatedMaterials: [{ name: 'Material', [priceField]: amount }],
        } }, res);
        assert.equal(res.code, 400);
      }
    }
    assert.equal(query.mock.calls.length, 0);
    assert.equal(connect.mock.calls.length, 0);
  } finally { mock.restoreAll(); }
});

test.after(() => pool.end());
