# Project scheduling API

Apply the additive migration with `npm run migrate:project-scheduling`. Roll it back with `npm run rollback:project-scheduling`; rollback drops scheduling-only tables and dependency metadata while retaining existing tasks and legacy dependency rows. The migration does not reset or rewrite task schedules.

The default project calendar is Monday-Friday, timezone `Asia/Manila`, with dates from `project_holidays`. Calendar rows are inserted with defaults for existing projects and do not replace any project fields. The engine returns ISO calendar dates and forecasts incomplete task dates from the project start (or a deterministic fallback with a warning).

All routes require the existing bearer authentication and project-access middleware. Dependency proposals, approvals, reversals, and baselines additionally require project management permission where they write approved project state. Dependency `POST`/`PATCH`/`DELETE` routes now create simulated scenarios; they do not edit the live dependency graph.

## Routes

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/projects/:code/schedule` | CPM forecast, float, critical flags, warnings, calendar |
| GET | `/projects/:code/schedule/capabilities` | Reports enabled simulator features and migration state |
| GET | `/projects/:code/schedule/critical-path` | Critical path IDs, activities, completion, constraints |
| GET | `/projects/:code/schedule/calendar` | Calendar weekdays, timezone, holidays |
| GET | `/projects/:code/schedule/risk` | Deterministic activity and project risk assessment |
| GET | `/projects/:code/schedule/dependencies` | Project dependency edges |
| POST | `/projects/:code/schedule/dependencies` | Add dependency |
| PATCH | `/projects/:code/schedule/dependencies/:id` | Change dependency type or lag |
| DELETE | `/projects/:code/schedule/dependencies/:id` | Remove dependency |
| POST | `/projects/:code/schedule/simulations` | Save an isolated what-if result |
| GET | `/projects/:code/schedule/scenarios` | List saved simulations |
| GET | `/projects/:code/schedule/scenarios/:id` | Read saved simulation |
| POST | `/projects/:code/schedule/scenarios` | Save a draft simulation |
| POST | `/projects/:code/schedule/scenarios/compare` | Compare 2–10 project scenarios |
| GET | `/projects/:code/schedule/baselines` | List approved immutable baselines |
| POST | `/projects/:code/schedule/baselines` | Create a new approved baseline version |
| POST | `/projects/:code/schedule/recovery-options` | Evaluate proposed recovery changes |
| POST | `/projects/:code/schedule/change-requests` | Submit scenario with required reason |
| GET | `/projects/:code/schedule/change-requests` | List approval requests |
| GET | `/projects/:code/schedule/change-requests/:id` | Read request and before/after snapshots |
| POST | `/projects/:code/schedule/change-requests/:id/approve` | Manager approval and transactional apply |
| POST | `/projects/:code/schedule/change-requests/:id/reject` | Reject request |
| POST | `/projects/:code/schedule/change-requests/:id/reverse` | Reverse applied request if no intervening schedule changes |
| GET | `/projects/:code/schedule/history` | Read schedule decision history |

Dependency creation body:

```json
{"successorTaskId":"uuid-of-successor","predecessorTaskId":"uuid-of-predecessor","type":"FS","lag":0,"reason":"Approved sequence proposal for review"}
```

Allowed types are `FS`, `SS`, `FF`, and `SF`; `lag` is an integer working-day offset and may be negative. Duplicate/self/cyclic and cross-project edges are rejected. These endpoints return a saved scenario; submit it for approval before it can change the live graph.

Simulation body (scenario types: `TASK_DELAY`, `TASK_DATE_CHANGE`/`DATE_CHANGE`, `DURATION_CHANGE`, `MATERIAL_DELIVERY_DELAY`/`MATERIAL_DELAY`, `MANPOWER_INCREASE`/`MANPOWER_CHANGE`, `OVERTIME`, `TASK_RESEQUENCING`, `WEATHER_INTERRUPTION`):

```json
{"scenarioType":"TASK_DELAY","taskId":"uuid-of-task","delayWorkingDays":5,"reason":"Material delivery delay","expectedScheduleVersion":"hash-from-GET-schedule"}
```

`expectedScheduleVersion` is required. Read it from `GET /projects/:code/schedule`; a mismatch returns `409 STALE_SCHEDULE_VERSION`. The simulation response exposes both the standard `data` envelope and a `simulation` object with `scenarioId`, `SIMULATED` status, before/after completion, calculated working-day difference, affected task records, critical paths, warnings, recovery choices, and the source schedule version. `GET /projects/:code/schedule/capabilities` returns `migration_required` until the additive migration has been applied; frontend simulator controls should remain disabled in that state.

For `TASK_DATE_CHANGE`/`DATE_CHANGE`, supplying both `startDate` and `endDate` derives the activity duration as the inclusive count of working dates on the project calendar. A `startDate` by itself moves the task while preserving its current duration. Supplying `endDate` alone derives a duration from the existing start. A supplied duration that conflicts with the proposed range is rejected. The engine never changes the approved project end date. Schedule payloads distinguish `approvedTargetCompletion`, `currentForecastCompletion`, `simulatedForecastCompletion`, `scheduleChangeImpactWorkingDays`, and signed `projectDeadlineVarianceWorkingDays` (positive means late). Activity `networkTotalFloat` is measured against the earliest network completion; `deadlineBuffer` is measured against the approved target. `totalFloat` remains an alias for network float.

Repeated identical simulation POSTs by the same author, project, schedule version, reason, and change set return the original scenario instead of adding another permanent record. Send a unique `Idempotency-Key` header (or `idempotencyKey` field) to intentionally save another identical proposal. Each new simulation is stored as `simulated`; submission moves it to `submitted`, and review/application follows the existing approval lifecycle.

Simulation response example:

```json
{"success":true,"simulation":{"scenarioId":"scenario-uuid","projectCode":"PRJ-2026-001","status":"SIMULATED","originalCompletion":"2026-11-06","simulatedCompletion":"2026-11-13","delayWorkingDays":5,"affectedTasks":[],"criticalPathBefore":["task-a"],"criticalPathAfter":["task-a","task-b"],"constraintWarnings":[],"recoveryOptions":[],"scheduleVersion":"sha256-hash"}}
```

Each task change supports `startDate`, `endDate`, `duration`, `delayWorkingDays`, or `blockUntilDate`. Dependency resequencing uses `{ "operation":"add_dependency", "dependency":{"predecessorTaskId":"uuid","successorTaskId":"uuid","type":"FS","lag":0} }`; remove uses `remove_dependency`. Weather uses `{ "operation":"weather_interruption", "nonworkingDates":["2026-11-02"] }` and adds only manually supplied dates to the simulated calendar.

Manpower changes require explicit `currentWorkers`, `proposedWorkers`, `currentTeamOutputPerDay`, `proposedTeamOutputPerDay`, and `remainingQuantity` assumptions. The engine uses measured aggregate team productivity and does not infer output from worker counts. Overtime changes require explicit remaining effort, base/extra productive hours, and overtime days. Cost is returned only when a labor cost rate and currency are supplied. Material delay uses `blockUntilDate` on task IDs explicitly provided by the caller; there is no existing material-to-task relationship to infer blocked tasks from.

The response contains `original`, `proposed`, `affectedTasks`, completion dates, working-day completion difference, critical path changes, constraint warnings, and cost status. A simulation never updates live tasks, dependencies, or holidays.

Typical response envelope:

```json
{"success":true,"data":{"id":"scenario-uuid","originalCompletionDate":"2026-11-06","forecastCompletionDate":"2026-11-13","durationDifferenceWorkingDays":5,"affectedTasks":[],"costImpact":{"status":"not_calculated","amount":null,"currency":null}}}
```

Submit an approval request with `{"scenarioId":"scenario-uuid","reason":"Supplier delivery moved by one week"}`. A manager then posts to the `approve` or `reject` route. Approval locks the project, task rows, and dependency graph, compares the live schedule version with the simulation snapshot, checks project start/end bounds, and applies task dates, dependency edits, and simulated calendar interruptions in one transaction. Every applied activity/dependency/calendar change writes an audit row. Reversal checks that the live calculated schedule still matches the approved after-snapshot before restoring dates, dependencies, and holidays.

Manpower simulation example:

```json
{"name":"Add crew","scenarioType":"MANPOWER_INCREASE","reason":"Recover supplier delay","expectedScheduleVersion":"sha256-hash","taskId":"task-uuid","currentWorkers":2,"proposedWorkers":4,"remainingQuantity":12,"productivityAssumptions":{"currentTeamOutputPerDay":3,"proposedTeamOutputPerDay":4.5,"laborCostPerWorkerDay":1200,"currency":"PHP"}}
```

Scenario comparison accepts `{"scenarioIds":["scenario-1","scenario-2"]}`. Recovery evaluation accepts `{"forecastCompletionDate":"2026-11-13","options":[{"type":"CREW_RECOVERY","changes":[...]}]}` and always includes an accept-revised-completion option. An extension past the approved project deadline is flagged for separate deadline approval. Risk scoring is deterministic; when a baseline exists it compares actual progress with the baseline plan. The scoring method is included in each response and is not an ML forecast.

## Current integration boundary

Baseline creation creates a new approved version and stores task dates, durations, progress, and dependency snapshots; existing versions are never updated. Schedule approvals enforce current project start/end bounds, and `PATCH /projects/:code/due-date` remains the only way to change the project end date. Forecasts with unknown duration are flagged; approval and baseline creation refuse to persist those forecast dates until duration is supplied. Existing task update routes reject direct dependency changes and changed schedule dates/durations; users must submit them through simulation and approval. Task creation still supports ordinary task dates validated against project bounds, but does not accept predecessor dependencies.

The Gantt and Calendar consumers should use `GET /projects/:code/schedule`; it returns the same authoritative forecast, dates, dependency edges, float, critical path, calendar, and warnings. No frontend files were changed in this backend repository.

The database migration is additive and does not modify project/task records. Run `npm run migrate:project-scheduling`; rollback with `npm run rollback:project-scheduling`. The rollback removes new scheduling data and metadata while preserving legacy task and dependency rows.

After applying the migration, verify its objects and existing row availability with:

```sql
SELECT to_regclass('task_dependencies') AS dependencies,
       to_regclass('project_scheduling_calendars') AS calendars,
       to_regclass('schedule_scenarios') AS scenarios,
       to_regclass('schedule_change_requests') AS requests,
       to_regclass('schedule_audit_logs') AS audit;
SELECT count(*) AS projects FROM projects;
SELECT count(*) AS tasks FROM tasks;
SELECT count(*) AS legacy_dependency_rows FROM task_dependencies;
SELECT count(*) AS calendars FROM project_scheduling_calendars;
```
