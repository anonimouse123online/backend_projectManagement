# Time Logs without incidents

Time Logs record work and time on site. Issues and incidents continue through the
dedicated Issue Reporting APIs; submitting a Time Log does not create an issue,
notification, or field report.

## Inspected implementation

The API is mounted at `/timelogs` by `routes/index.js`. Previously,
`routes/timelog.js` exposed only GET (list) and POST (create), with validation and
SQL directly in `controllers/timelogController.js` and no Time Log model/service.
Creation defaulted an omitted `has_incident` to false rather than requiring it,
but create/list SQL, responses, logging, and setup data still used the flag.

The configured PostgreSQL database has `public.time_logs`, not `timelogs`.
Inspection found 32 rows, an integer primary key, and a `has_incident BOOLEAN
NOT NULL DEFAULT false` column. The repository setup script instead uses UUID
primary keys; the API and database tests support both configurations.

The full backend search found the old flag only in the Time Log controller and
`setup_new_db.sql`. PostgreSQL dependency inspection found only the flag's default
and NOT NULL constraint, which are removed with the column. No Time Log incident
CHECK, view, materialized view, stored procedure, or function reference was found.
The existing update trigger only assigns `updated_at` and remains unchanged.

## API

Existing Bearer JWT authentication remains in place. Detail/update/delete use the
list endpoint's project scope: project owner or project member. Missing or
inaccessible records return 404. Moving a Time Log to a project also requires
access to that project.

| Method | URL | Behavior |
| --- | --- | --- |
| GET | `/timelogs` | Existing scoped list and search/date/engineer filters |
| POST | `/timelogs` | Create; no incident fields required or processed |
| GET | `/timelogs/:id` | Read one accessible Time Log |
| PATCH / PUT | `/timelogs/:id` | Update supplied work/time fields, retaining omitted fields |
| DELETE | `/timelogs/:id` | Delete one accessible Time Log |

Example create request (the existing `project_name` and `date` requirements remain):

```json
{
  "project_name": "MATIMCO FENCE",
  "engineer_name": "Kurt Paul Perocillo",
  "date": "2026-10-07",
  "work_on_site": 5,
  "supervisors": 1,
  "sub_contractors": 2,
  "total_work_hours": 8,
  "weather": "Sunny",
  "temperature": 31,
  "work_completed": "Fence foundation preparation",
  "materials_delivered": "Cement",
  "equipment_used": "Mixer",
  "additional_notes": "Work completed as planned"
}
```

`work_on_site`, `supervisors`, and `sub_contractors` remain integer headcounts,
as in both the existing database and setup script. Work descriptions belong in
`work_completed`. Hours retain their existing varchar storage and accept numeric
input; temperature retains the existing Celsius string formatting. This incident
separation does not migrate unrelated field types.

Update example:

```json
{
  "total_work_hours": 9,
  "additional_notes": "Foundation preparation completed"
}
```

Legacy incident keys are ignored when sent alongside supported Time Log fields.
An update with only unknown/obsolete fields returns 400 (`No Time Log fields
provided.`). Responses contain the explicit work/time fields, ID and timestamps;
they never expose incident fields, even before the migration is applied.

## Database migration

Exact executable statement in `migrations/timelog_remove_incidents.sql`:

```sql
ALTER TABLE time_logs DROP COLUMN IF EXISTS has_incident;
```

The migration removes only the obsolete flag and its column constraints/default.
Existing Time Log rows, IDs, timestamps, and work/time values are retained. It uses
no CASCADE, so an unexpected external dependency blocks the migration instead of
being deleted. It is safe to rerun. The runner wraps execution in BEGIN/COMMIT
and rolls back failures.

Deploy the updated backend first; its queries work with or without the old column.
Then apply the migration to the configured application database:

```sh
npm run migrate:timelog-incidents
```

The migration has been tested in rolled-back schemas, including a blocking view
dependency and historical records with `has_incident = true`. It has **not** been
committed to the application database. `setup_new_db.sql` no longer creates or
seeds the flag for new installations.

## Verification

On environments where test subprocess creation is restricted, run each suite
separately (each suite closes its own connection pool):

```sh
node --test --test-isolation=none tests/timelogs.test.js
node --test --test-isolation=none tests/timelogsDatabase.test.js
node --test --test-isolation=none tests/projectIssues.test.js
node --test --test-isolation=none tests/projectIssuesDatabase.test.js
npm run lint
```

The Time Log suites verify incident-free create/list/detail/update/delete, ignored
legacy incident input, omitted-field preservation, project access, integer and UUID
IDs, migration idempotency, historical-record preservation and dependency protection.
The existing Issue Reporting suites verify issue creation, authorization, resolution,
counts, notifications, socket updates and concurrent resolution. Issue Reporting
source files and migrations remain unchanged.
