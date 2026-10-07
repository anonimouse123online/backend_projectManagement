# Task and Subtask work status

Task and Subtask work status use the same `status` property for Web and Android.
`pending` and `ongoing` coexist with progress; status-only requests preserve all
stored percentages, parent/child progress, sibling data and project progress.

## Existing implementation inspected

- The live `public.tasks` table has a UUID primary key, `status VARCHAR(50) NOT NULL
  DEFAULT 'Pending'`, `progress_pct INTEGER NOT NULL DEFAULT 0`, and
  `subtasks JSONB NOT NULL DEFAULT '[]'`.
- The exact live lifecycle check was:
  `CHECK (status IN ('Pending', 'In Progress', 'Completed', 'Cancelled'))`.
  The percentage check requires `progress_pct BETWEEN 0 AND 100`.
- There is no Subtasks table, separate Subtask controller, or separate router.
  Each embedded Subtask previously stored `id`, `title`, and `completed`.
  Legacy completion implied progress 100/0 but had no independent work status.
- Existing update routes are `PATCH /tasks/:id/status`,
  `PATCH /tasks/:id/subtasks`, and `PATCH /tasks/:id/complete`.
- Legacy status handling coupled Pending to 0%, and In Progress/Ongoing to an
  inferred 50% in some paths. Checkbox completion calculated parent progress
  from the count of completed Subtasks. That completion workflow is retained.
- Task access permits project owners, project members, and assigned engineers.
  The new work mutation checks additionally restrict engineers to their assigned
  tasks. Project owners and authorized Admin/PM members retain access.

## Storage and normalization

New work-state writes persist lowercase `pending` or `ongoing` in the existing
Task `status` column. Existing lifecycle writes keep their compatible storage
values (for example `Completed`/`Cancelled`), and Task responses normalize status
to lowercase. Old rows are not rewritten. Missing/null statuses return `pending`.
No duplicate work-status column or separate Subtask table was introduced.

Each newly created Subtask stores `status` and `progress` in its own JSON object.
The existing `completed` property remains. Historical Subtasks normalize on read:
missing status/progress becomes `pending`/0, or `completed`/100 for a checked item.
Explicit partial progress remains independent of a pending/ongoing status.

Input is case-insensitive and trimmed. Deliberate legacy aliases `In Progress`
and `in-progress` normalize to `ongoing`; unknown values such as `working123`
return 400. Percentages must be integers from 0 through 100. Task `progress` is
an alias for the existing `progress_pct`; responses preserve both names with
the same value. If a request supplies both names, they must agree.

## Update routes and example requests

Task work status, without changing progress:

```http
PATCH /tasks/<task-uuid>/status
Authorization: Bearer <jwt>
Content-Type: application/json

{"status":"ongoing"}
```

Subtask work status on the existing route:

```http
PATCH /tasks/<task-uuid>/subtasks
Authorization: Bearer <jwt>
Content-Type: application/json

{"subtask_id":"a","status":"ongoing"}
```

The same routes accept `{"progress":35}` for a Task and
`{"subtask_id":"a","progress":60}` for a Subtask, preserving work status.
Task/Subtask status and progress can also be supplied together.

The legacy `{"subtasks":[...]}` checkbox array remains accepted. Missing child
status/progress is merged with the saved values, with IDs retained or generated
for old clients that omit them. Status-only changes in such an array do not
recalculate parent progress. Checkbox completion changes and adding/removing
children retain the existing count-based parent progress workflow; completed
children receive `completed: true`, `status: "completed"`, and progress 100.
Unchecking a completed child resets it to Pending and progress 0.

The existing completion endpoint still marks the Task and all children completed
and sets progress to 100. Finished/cancelled Tasks and completed Subtasks reject
new Pending/Ongoing work-state changes with 409. Activation checks for work on
Planning/Draft/Pending projects remain. Explicit parent progress and completion
updates retain the existing project-progress synchronization behavior.

Mutations lock the Task row and merge stored JSON transactionally, so an update
to one child cannot replace sibling data. Authentication remains the existing
Bearer JWT middleware. Inaccessible tasks return 404; a project-member engineer
who is not assigned to the task receives 403 on work mutation routes.

## Responses and Web/mobile compatibility

Task list (`GET /tasks`), detail (`GET /tasks/:id`), create/edit/assignment/action
responses, and project active-task metadata include normalized status, existing
`progress_pct`, the matching `progress` alias, and nested child status/progress.
Project/assigned filters on GET /tasks use the same serializer. Ongoing filters
include old `In Progress` rows. Dashboard gauge/progress APIs return aggregates;
their existing case-insensitive Pending/Ongoing counting accepts the new storage.
The project Pending counter was updated to recognize lowercase writes.

Example detail/action response (unrelated existing fields omitted):

```json
{
  "success": true,
  "data": {
    "id": "00000000-0000-4000-8000-000000000123",
    "task_name": "Fence Foundation",
    "status": "ongoing",
    "progress": 45,
    "progress_pct": 45,
    "subtasks": [
      {"id":"a","title":"Excavation","completed":false,"status":"ongoing","progress":60},
      {"id":"b","title":"Rebar preparation","completed":false,"status":"pending","progress":0}
    ]
  }
}
```

The sibling Web implementation's existing work-status components were inspected
and its 14 status-display tests passed. They read saved status independently of
progress/date, show each child's status/progress, preserve completion displays,
and retrieve fresh values through the same Task API. This backend change did not
edit the frontend. Android uses the same JWT routes and response properties; no
Android runtime or device was available for on-device testing.

## Exact database migration

The complete executable SQL is [task_work_status.sql](../migrations/task_work_status.sql).
It reads each existing status-only CHECK expression and extends it with
`OR status IN ('pending','ongoing')`, retaining its old lifecycle values and
validation state. A migration comment makes reruns idempotent. Checks involving
other fields, NOT NULL constraints, triggers, and progress constraints are untouched.
Databases with no status CHECK remain compatible without inventing a restrictive
constraint that could reject unknown historical states.

For the inspected live constraint, the resulting expression is equivalent to:

```sql
CHECK (status IN ('Pending', 'In Progress', 'Completed', 'Cancelled')
       OR status IN ('pending', 'ongoing'))
```

The SQL also executes:

```sql
ALTER TABLE tasks ALTER COLUMN status SET DEFAULT 'pending';
```

No Subtask schema migration is needed because child data is JSONB. Existing
Task/Subtask data and timestamps are retained; missing fields normalize on read.
Fresh-install setup scripts use the new Task default.

Apply the migration **before deploying the updated backend** to databases with
the original title-case status constraint:

```sh
npm run migrate:task-work-status
```

The migration was tested in rolled-back PostgreSQL schemas and has **not** been
committed to the configured application database.

## Verification

Run suites separately in environments that disable subprocess isolation:

```sh
node --test --test-isolation=none tests/taskWorkStatus.test.js
node --test --test-isolation=none tests/taskWorkStatusDatabase.test.js
node --test --test-isolation=none tests/taskWorkStatusMigration.test.js
node --test --test-isolation=none tests/taskPhases.test.js
node --test --test-isolation=none tests/taskPhasesDatabase.test.js
npm run lint
```

Tests exercise both directions of Pending/Ongoing transitions, progress-only
updates, preserved parent/sibling/project percentages, Task GET/list/project and
assigned filters, dashboard counts, invalid inputs, genuine JWT requests, denied
project-member engineers, retained PM/Admin/owner permissions, completion,
cancelled states, historical/null reads, migration idempotency and unchanged
progress/lifecycle validation. Database fixtures and migration writes roll back.
