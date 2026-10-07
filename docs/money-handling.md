# Budget and resource money handling

The inspected PostgreSQL database has `projects.budget NUMERIC(15,2)` and
`resources.unit_price NUMERIC` with no precision/scale restriction. Both support
two decimal places. `resources.quantity` is also unrestricted `NUMERIC` and
supports fractional quantities. Allocated budget, resource cost, total spent
and remaining budget are calculated values, not separate stored columns.
The repository setup scripts already declare budget `NUMERIC(15,2)` and unit
price `NUMERIC(12,2)`. No schema change, migration or data rewrite is needed.

Project creation and resource creation/update accept JSON numbers or decimal
strings such as `10000`, `1500.5` and `999.99`. Monetary inputs must be finite,
non-negative values with at most two decimal places; invalid input returns HTTP
400. Values are normalized to decimal strings before being passed to PostgreSQL.
The project budget limit follows its existing 13 whole digits and 2 fractional
digits. Very large unit prices must be sent as strings to avoid JSON number
precision loss. Zero prices/budgets are accepted.

Task creation validates both `unitPrice` and `unit_price` in allocated materials;
missing task material prices retain the existing zero default. Quantities stay
as decimal text, including fractional quantities. PostgreSQL adds existing stock
quantities rather than JavaScript adding or concatenating PostgreSQL strings.
Existing support for signed stock quantities is retained.

Project list, detail and stats queries use PostgreSQL `NUMERIC` arithmetic:

```sql
total_resource_cost = ROUND(SUM(quantity::numeric * unit_price::numeric), 2)
remaining_budget = ROUND(allocated_budget - total_resource_cost, 2)
```

Empty resource totals default to zero. Costs use the existing project code,
project name and task/project associations. The aggregate is rounded once to
cents, preserving the existing sum-of-products behavior for fractional quantities.
`total_spent`/`totalSpent` remain aliases of the resource cost. Overspent budgets
retain negative remaining balances.

Existing response fields and types are preserved: PostgreSQL decimal results in
project/resource responses remain strings, while project stats retain JSON
numbers. Stats convert only final SQL results to numbers; they perform no money
arithmetic in JavaScript. JSON numbers do not retain trailing zero formatting.

Validation:

```powershell
node --test --test-isolation=none tests/money.test.js
node --test --test-isolation=none tests/moneyDatabase.test.js
```

Run each test file in its own process. Database checks use read-only CTE fixtures
and intercept writes; they create no tables, modify no data and run no migrations.
