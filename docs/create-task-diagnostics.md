# CREATE TASK PostgreSQL 428C9 diagnosis

The configured live connection was inspected on 2026-10-06:

```text
current_database(): sitepulse
current_schema(): public
search_path: "$user", public
```

## Exact table and column

The generated column is **public.resources.status**, not `public.tasks.status`.
`pg_attribute.attgenerated` is `s` (stored generated column) on `resources.status`.
Its type is `character varying(50)`, and its expression derives status from category,
quantity, and min_threshold:

```sql
CASE
  WHEN category = 'Material' AND quantity <= min_threshold THEN 'Low stock'
  WHEN category = 'Material' AND quantity > min_threshold THEN 'In stock'
  WHEN category = 'Equipment' AND quantity <= min_threshold THEN 'Low Availability'
  WHEN category = 'Equipment' AND quantity > min_threshold THEN 'Available'
  ELSE NULL
END
```

`public.tasks.status` is ordinary `character varying(50)` with default `Pending`.
`public.projects.status` is also ordinary varchar. Their writes remain intact.
`task_phases` has no status column.

## Exact rejected SQL

Both existing CREATE TASK inventory INSERT branches were reproduced against the live
database using `EXPLAIN`, without executing the writes. The supplied failing request body
is not available, so the original branch cannot be distinguished retrospectively; both
produce the identical error and the new runtime logs identify the actual branch's SQL.

Allocated-materials INSERT:

```sql
INSERT INTO resources
  (name, supplier, category, quantity, unit, min_threshold, unit_price,
   project, status, created_at, updated_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW());
```

Materials-text fallback INSERT:

```sql
INSERT INTO resources
  (name, supplier, category, quantity, unit, min_threshold, unit_price,
   project, status, created_at, updated_at)
VALUES ($1, 'General Supplier', 'Material', $2, $3, 10, 0,
        $4, $5, NOW(), NOW());
```

The existing-row branches also reject explicit status assignment:

```sql
UPDATE resources
SET quantity = $1, status = $2, updated_at = NOW()
WHERE id = $3;
```

Observed PostgreSQL INSERT error:

```text
message: cannot insert a non-DEFAULT value into column "status"
code: 428C9
detail: Column "status" is a generated column.
routine: rewriteTargetListIU
```

The UPDATE error is `column "status" can only be updated to DEFAULT`, with the same
code/detail/routine. PostgreSQL left table, schema, column, constraint, and where fields
unset for these rewrite errors. The exact target is established by the SQL and catalog
inspection, rather than guessed from missing error metadata.

## Creation operations and triggers inspected

The complete CREATE TASK database path is:

1. Connection metadata, project access/date lookup, assignee lookup, and membership lookup.
2. BEGIN; INSERT into tasks, including task status and embedded JSONB subtasks.
3. Task phase relation deletion/insertion and inspection of the resolved resource status column.
4. Resource lookup and INSERT or UPDATE for each material/equipment item.
5. Task reads and UPDATE of projects.progress, progress_pct, status, and updated_at.
6. Read created-task phases; COMMIT, or ROLLBACK on failure.

There is no separate subtask INSERT, notification INSERT, audit/history INSERT, or
resource-service call in createTask. Existing subtasks live in `tasks.subtasks`.

The live user-defined task triggers are:

- `task_phase_legacy_sync`: AFTER INSERT/UPDATE OF phase; calls
  `sync_legacy_task_phase()`, which inserts only task_id and phase into public.task_phases.
- `trg_tasks_updated_at`: BEFORE UPDATE; sets only NEW.updated_at.

Other task triggers are foreign-key checks/cascades. The inspected phase/resource/project
triggers and rules add no status write explaining this error. The error is raised while
PostgreSQL rewrites the explicit resource status assignment, before the resource write.

## Minimal fix and logging

CREATE TASK now checks the resource status column on the **same connection/search_path**
used for all creation queries. When generated, both inventory INSERT branches omit status,
and both UPDATE branches omit its assignment; PostgreSQL calculates it from the inputs.
For older databases with ordinary resource status columns, existing explicit values and
placeholder numbering remain supported. No database migration or tasks.status change
is required for this fix.

Every query in createTask, including queries inside its phase and progress helpers,
logs a short `[CREATE TASK] ...` label before execution. A request UUID correlates
concurrent requests. Database name/schema/search_path are queried and logged once per
creation attempt that reaches the database. The resolved resource relation and generated
flag are also logged.

The controller catch logs message, code, table, schema, column, constraint, detail, where,
and routine, plus the failed operation, exact parameterized SQL, and request ID. A rollback
failure does not overwrite the original failing statement. Query parameters are excluded
from diagnostic logging. The HTTP response keeps its existing format.

Changed in this fix:

- `controllers/taskController.js`: shared traced connection, full catch diagnostics,
  generated-aware inventory writes; tasks.status unchanged.
- `services/taskCreationDiagnostics.js`: query labels and exact failing SQL/error context.
- `tests/taskPhases.test.js`: error context retained through rollback failure.
- `tests/taskPhasesDatabase.test.js`: generated/ordinary resource status, both creation
  INSERT/UPDATE branches, and query/connection logging.
- `docs/create-task-diagnostics.md`, `docs/task-phase-categories.md`: diagnosis and updated contract notes.

Tests pass using `node --test --test-isolation=none` with the two task test files.
