# Task construction phase categories

## Inspected database and callers

The configured live PostgreSQL database was inspected before implementation:

- `tasks.id`: UUID, primary key, default `gen_random_uuid()`.
- `tasks.phase`: `character varying(100) NOT NULL`, retained as a deprecated compatibility field.
- Existing rows: 29 `Phase 1 - Foundation`, 2 `Phase 2 - Structural`, and 2 `Phase 5 - Finishing`.
- No `task_phases` table or task-phase tests existed. Task logic resides in
  `controllers/taskController.js`; there was no separate task repository/service.
- `POST /tasks` is the existing create endpoint. Existing edits had dedicated `/status`,
  `/subtasks`, `/assign`, and `/complete` routes, with no generic task edit endpoint.
  PATCH/PUT were added on the existing `/tasks/:id` resource URL for category and metadata edits.
- Task list/detail, dashboard category filters, report metadata, active-task responses,
  and project task-category summaries read the old scalar field. Those callers now
  include or query the normalized relation. Project-level `projects.phase` and project
  phase-transition logic are separate concepts and retain their existing behavior.
- No frontend source was present; this document defines the frontend contract.

The exact pre-migration `tasks_phase_check` definition returned by PostgreSQL is:

```sql
CHECK (((phase)::text = ANY ((ARRAY['Phase 1 - Foundation'::character varying, 'Phase 2 - Structural'::character varying, 'Phase 3 - Electrical & Utilities'::character varying, 'Phase 4 - Plumbing & MEP'::character varying, 'Phase 5 - Finishing'::character varying])::text[])))
```

## Exact migration and setup

The complete SQL is [migrations/task_phases.sql](../migrations/task_phases.sql).
The existing migration-runner convention is followed in
[migrations/task_phases.js](../migrations/task_phases.js).

Before restarting the updated backend, run:

```sh
npm run migrate:task-phases
```

The runner applies the SQL inside BEGIN/COMMIT and rolls back on failure. Implementation
tests used a rolled-back schema; the migration has **not** been applied to the application
database. Run it after existing database setup scripts on new installations too.

The migration creates:

```sql
CREATE TABLE IF NOT EXISTS task_phases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  phase VARCHAR(100) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT task_phases_phase_check CHECK (phase IN (
    'Site Development', 'Structural', 'Electrical & Utilities', 'Plumbing & MEP',
    'Architectural', 'Construction Phase', 'Turnover Phase'
  )),
  CONSTRAINT task_phases_task_phase_key UNIQUE (task_id, phase)
);
```

The unique index supports task-ID lookups; a separate `(phase, task_id)` index supports
category queries. `normalize_task_phase(text)` maps known legacy values:

| Legacy value | Category |
| --- | --- |
| Foundation / Phase 1 - Foundation | Site Development |
| Structural / Phase 2 - Structural | Structural |
| Electrical & Utilities / Phase 3 - Electrical & Utilities | Electrical & Utilities |
| Plumbing & MEP / Phase 4 - Plumbing & MEP | Plumbing & MEP |
| Finishing / Phase 5 - Finishing | Architectural |

The seven canonical names map to themselves. Existing task rows, IDs, and scalar phase
values are preserved. Tasks without relations are backfilled once; migration reruns
retain existing multi-category selections and do not re-add previously removed categories.
An unrecognized nonblank historical phase aborts the migration with an explicit error
so mappings can be reviewed before retrying. No guessed categories are inserted.
Historical blank/null phases, where the old schema allows them, have no backfilled
relations and return `phases: []`; new API creation requires a valid selection.

`tasks_phase_check` retains its existing expression and additionally permits the seven
canonical names. This is required because `tasks.phase` remains NOT NULL in the live
schema and new writes store the first selected canonical category there. Its migration
comment prevents repeatedly nesting the expression on reruns. If no old check exists
(as in the repository's setup SQL), a compatibility check permits known legacy/new names
and existing blank/null values. The authoritative seven-category check is on
`task_phases.phase`.

An AFTER INSERT/UPDATE OF phase trigger seeds the mapped category for legacy scalar SQL
writes, so an old backend can create tasks during rollout. Scalar SQL edits **add** their
mapped category without deleting extra selections. Updated API edits replace the full
relation set inside a transaction. Direct SQL consumers that need to remove categories
must use the API or synchronize the relation explicitly in their own transaction.

## Create-task contract

The frontend sends `construction_phase_categories: string[]`. Create and metadata
edit accept this field as an alias for `phases`, using the same nonempty-array
validation and persistence. If both array names are supplied,
`construction_phase_categories` takes precedence, including when invalid. Existing
`phases` clients and response arrays retain their contract; task responses still
return `phases`. No additional database migration is required for this alias.

`POST /tasks` requires the existing Bearer JWT and preserves the existing project-access,
active-assignee, membership, date, resource, and subtask rules. New clients send:

```json
{
  "task_name": "Perimeter Fence Installation",
  "phases": ["Site Development", "Structural", "Construction Phase"],
  "project_id": "<project-uuid-or-code>",
  "assignee_id": "<joined-active-engineer-uuid>",
  "due_date": "2026-12-01",
  "priority": "Medium",
  "materials_required": "20 bags Cement",
  "site_instructions": "Inspect the perimeter before installation.",
  "subtasks": ["Inspect the site", "Install the fence"]
}
```

Use a due date within the project's date range and not in the past. Existing camelCase
aliases remain supported: `taskName`, `projectId`, `assigneeId`, `dueDate`,
`materialsRequired`, `siteInstructions`; optional `startDate`/`start_date`, subtasks, and
`allocatedMaterials`/`allocated_materials` retain their existing behavior. Other existing
required fields still apply. The example's date must be changed for later testing.

`phases` is required for new clients, must be an array of at least one category, and
accepts only the seven exact names above. Every item must be a nonblank string; values
are trimmed and duplicate values removed. Invalid arrays are rejected, even if a valid
legacy scalar `phase` is supplied alongside them. Case variants and legacy names such
as `Foundation` inside the **new array** are rejected.

As a temporary compatibility exception, a request omitting `phases` can still send a
valid scalar `phase`, including the old short or prefixed names. It becomes one mapped
category. When both fields are present, `phases` is authoritative and the supplied
scalar is ignored. Do not use the scalar for new frontend code.

Task insertion, selected-phase insertion, existing inventory synchronization, and project
progress synchronization now use one transaction/connection. Subtasks remain in the
existing task JSONB column. If a phase, resource, or progress write fails, all creation
changes roll back. The old resource best-effort behavior is intentionally replaced by
atomic creation; inventory failures now return 500 instead of partial success. No new
task audit/notification infrastructure or duplicate notifications were introduced.

CREATE TASK detects whether the connected database generates `resources.status`. If so,
inventory writes omit that column and PostgreSQL computes it; ordinary resource-status
schemas retain the existing explicit values. Every creation query now has a correlated
diagnostic label, and failures log exact SQL and complete PostgreSQL context. See
[CREATE TASK diagnostics](create-task-diagnostics.md) for the verified 428C9 diagnosis.

## Update-task contract

`PATCH /tasks/:id` and `PUT /tasks/:id` both use partial-update semantics:

```json
{
  "phases": ["Architectural", "Turnover Phase"]
}
```

When `phases` is supplied, it is validated, replaces all phase relations, and sets the
deprecated scalar to the first selected category. The task row is locked to serialize
phase edits; changes commit or roll back together. Omit `phases` to keep current
selections during other edits:

```json
{
  "task_name": "Updated Perimeter Fence Installation"
}
```

The metadata edit supports `task_name`/`taskName`, `priority` (`High`, `Medium`, `Low`),
`materials_required`/`materialsRequired`, and `site_instructions`/`siteInstructions`.
These fields must be nonblank strings. Metadata edits do not run create-time inventory
allocation again. Existing status/progress, assignment, completion, and subtask action
routes retain their behavior and now include `phases` in returned task data.

Legacy scalar `phase` edits of a single-category task remain accepted and mapped.
A scalar-only edit of a task with multiple categories returns 400, requiring `phases`,
so a stale single-select client cannot silently discard the additional categories.
An unrelated update does not issue phase-delete/insert queries. Missing/inaccessible
tasks retain the existing 404 behavior; authentication is required (401). Access follows
the existing task rule: project owner, project member, or assigned engineer. There is
no new role expansion.

## Responses and filters

Create returns 201; edit, details, and lists return 200. The existing
`{ "success": true, "data": ... }` envelope remains. Example detail response
(other existing task fields omitted):

```json
{
  "success": true,
  "data": {
    "id": "00000000-0000-4000-8000-000000000123",
    "task_name": "Perimeter Fence Installation",
    "phase": "Site Development",
    "phases": ["Site Development", "Construction Phase", "Structural"]
  }
}
```

The authoritative `phases` property is always an array. Its first item matches the
mapped scalar compatibility category; remaining categories are ordered alphabetically.
Categories form a set, so callers must not rely on the input ordering of later items.
Previously stored `phase` strings remain untouched and may still contain prefixed legacy
names. New writes store the first canonical selected name. Keep `phase` only for old
consumers; new clients must read/edit `phases`. Do not drop the old column until all
remaining callers and external consumers have migrated.

`GET /tasks` (array under `data`) and `GET /tasks/:id` (object under `data`) include the
array. Existing `GET /tasks?phase=...` filters search **any** selected category; known
legacy short/prefixed filter values map to the canonical names. Existing project, status,
priority, assignee, and search filters retain their contracts. No new comma-separated
input or output is used.

Dashboard `/dashboard/gauge?category=...` and `/dashboard/progress?category=...` match
any selected category using EXISTS, so a task is counted only once per query. Project
progress `taskBreakdown` groups by canonical category; a multi-category task appears
once in each selected category, so category totals can overlap. Overall task totals
and progress calculation remain based on tasks, without category multiplication.
Report list/detail and project active-task metadata also include `phases`.

Phase-validation errors return HTTP 400:

```json
{
  "success": false,
  "message": "Please select at least one valid construction phase category."
}
```

Existing non-phase validation/authentication/error formats remain in place. Unexpected
database failures return 500; failed creation/phase edits leave no partial changes.

## Frontend changes and compatibility risks

Replace the single-select Construction Phase input with a multi-select or checkbox group
using the seven exact category strings. Keep selected values as a string array, require
at least one category, and send `phases` in create/edit JSON. Use the existing field names
for every other create value; valid project/assignee IDs and the existing required fields
are still needed. Parse `data.phases`, display all categories, and submit the complete
desired selection when replacing it. Omit the field during unrelated partial edits.
Handle the 400 `message` and refetch details after task edits.

Older code must map legacy strings when displaying categories and tolerate canonical
scalar values on new writes. Dashboard/category labels now use the seven categories;
old group labels such as Foundation and Finishing must be updated. Project-level phase
selectors are separate and should not be changed as part of this task feature.

Deploy the migration before the code, and update any additional databases using this
backend. The trigger supports temporary legacy scalar writes during rollout; unknown
historical names require an explicit mapping decision. The legacy column remains a
compatibility value and must not become authoritative again through frontend parsing.

## Verification and files

```sh
npm run test:task-phases
npm run test:task-phases:db
npm run lint
```

On Node 24 where the sandbox blocks test subprocess creation, use:

```sh
node --test --test-isolation=none tests/taskPhases.test.js
node --test --test-isolation=none tests/taskPhasesDatabase.test.js
```

The tests cover single/multiple creation, invalid/missing phases, trimming/deduplication,
phase replacement, omitted phases on partial/action updates, Foundation/Finishing and
all prefixed mappings, GET arrays, filtering/counts, constraints/idempotency, deletion
cascade, unknown-legacy migration failure, and rollback on phase/resource/progress failures.
The database suite creates its own schema inside a transaction and rolls everything back.

Changed for this feature:

- `controllers/taskController.js`, `routes/task.js`: task API, transactions and phase-aware responses.
- `services/taskPhaseService.js`: validation, compatibility mapping, relation queries and synchronization.
- `controllers/dashboardController.js`: filters across all selected task categories.
- `controllers/projectController.js`: category breakdown and active-task metadata.
- `controllers/reportController.js`: category arrays in report metadata.
- `migrations/task_phases.sql`, `migrations/task_phases.js`: exact migration and runner.
- `package.json`: migration and test commands.
- `tests/taskPhases.test.js`, `tests/taskPhasesDatabase.test.js`: new coverage.
- `docs/task-phase-categories.md`: frontend/database/API contract.

Verification: the task unit suite (7 tests) and database workflow suite (1 test) pass.
All issue and login-security regression suites pass (20 tests), using the same
`--test-isolation=none` workaround. Repository syntax validation checked 61 JavaScript
files with no failures before the additional diagnostics module. `npm run lint` passes with 0 errors and 26 existing unused-variable
warnings. No build script is configured, so there is no backend build command to run.
