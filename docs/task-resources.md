# Engineer task resources and instructions

The Android app currently calls `GET /tasks` with `assignee_id` and optional
`project_id`; its detail view uses the retrieved task. The backend also has
`GET /tasks/:id`. Both existing GET endpoints now return the same resource fields.
No new route, schema, migration, storage, or inventory write was added.

Existing task fields `materials_required` (TEXT) and `site_instructions` (nullable
TEXT) retain their values and types. Existing task status/progress serialization
and owner/member/assignee access conditions are unchanged.

- `resources` contains existing resource records explicitly linked by `task_id`,
  plus legacy records with no task ID whose project and `task_name` match.
  Item fields reuse the resource API's `id`, `name`, `category`, `quantity`, `unit`,
  `supplier`, `unitPrice`, `taskId`, and `taskName` names. Materials and Equipment
  are returned together. Prices are already exposed by the JWT-protected existing
  resource GET API, without an additional role restriction.
- `allocated_materials` reuses the existing Create Task request field name for a
  response derived from `materials_required`. Text formatted as `20 bags Cement`
  yields the task's quantity/unit/name. Existing JSON arrays are supported on read.
  Available category/supplier/price metadata is taken from linked resources or
  unlinked resources with the same item name and project. Resources tied to a
  different task are excluded. Project stock quantities never become allocations.
- Missing resources/materials produce empty arrays. Missing instructions remain
  null. Unknown material details remain null rather than being guessed.

Create Task currently updates project inventory without storing a task link or
the original structured allocation object. Historical supplier/category/price
details that were never saved cannot be reconstructed exactly. The GET response
returns available current metadata and the preserved task material text; inventory
and creation behavior are unchanged.

Resource lookups run only after the existing task authorization query succeeds.
List enrichment uses a single batched resource query for its authorized tasks.

The inspected Android `TaskResponse` DTO and local `TaskEntity` currently omit
materials/instructions/resources. The backend HTTP response contains the fields,
but Android must map and display them to make them visible. No Android code or
local database was changed by this backend update.

Verification: `node --test --test-isolation=none tests/taskResources.test.js`.
The JWT HTTP test executes the real controller SQL against PostgreSQL with SELECT
CTE fixtures inside `BEGIN READ ONLY`. It creates no tables or persisted records,
runs no migrations, and checks task/project scoping, material/equipment data,
null/empty cases, unchanged status/progress, and unauthorized access.
