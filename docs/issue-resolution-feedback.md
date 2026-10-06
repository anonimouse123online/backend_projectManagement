# Issue resolution feedback

## Database setup

The inspected live schema and active routes use `project_issues.id` and `users.id` (UUID),
`users.full_name`, `users.role`, `users.is_active`, and `notifications.target_user_id`.
The server mounts routes at `/`, so the endpoint has no `/api` prefix.

Run before restarting the updated backend:

```sh
npm run migrate:project-issues
npm run migrate:issue-resolutions
```

The first command is the existing prerequisite and can be skipped if already applied.
The second runs `migrations/issue_resolutions.sql` inside a transaction. Both migrations
can be rerun. The new migration adds `issue_resolutions`, with UUID foreign keys to
`project_issues` (cascade on issue deletion) and `users` (restrict resolver deletion),
nonblank summary and remarks checks, validated JSONB steps, backend timestamps, and
indexes for latest resolution lookup and resolver lookup. No existing columns are removed
or renamed. Resolution records are immutable through the API; `updated_at` initially
equals `created_at`. Deactivate users through `is_active` to retain their resolution attribution.

Existing resolved issues remain resolved, including their `resolution_notes`, and return
`resolution: null` until reopened and resolved using this workflow. Historical feedback
is not fabricated. Reopening clears `project_issues.resolved_at` and returns
`resolution: null`; previous resolution records remain in the table. A later resolution
adds a new record, and the details API returns the latest one.

Implementation tests used isolated schemas; the application database migration has
not been applied by this change.

## Endpoints and authorization

- `PATCH /issues/:id/resolve`
- `PATCH /projects/:code/issues/:issueId/resolve` (`:code` accepts project code or UUID)
- Existing `PATCH`/`PUT /issues/:id` and `/projects/:code/issues/:issueId` still work.
  When their body includes `status: "resolved"` (including legacy `"Resolved"`), they
  use the same resolution validation, authorization, transaction, and notifications.
- `GET /issues/:id` and `GET /projects/:code/issues/:issueId` return issue details with
  `data.resolution`. Existing project issue lists include the same field per issue.

All routes require `Authorization: Bearer <token>`. Resolution loads the authenticated
user from `users`, requires `is_active = TRUE`, and uses the current database role and
email for authorization. Admins can resolve any project issue; project managers can
resolve issues in owned or joined projects. Engineers, supervisors, and other members
retain their existing report, read, and ordinary update permissions, including reopening,
but cannot resolve issues. Existing owner/admin deletion permissions are preserved.

Do not send `resolved_by`, `resolved_at`, `admin_id`, or `role`. These request fields are
ignored. The resolver UUID comes from the authenticated identity, the name from the
database, and the timestamp from PostgreSQL. The issue timestamp and resolution
timestamp are identical in PostgreSQL; the JSON strings may differ in timezone notation
and precision, so compare parsed dates rather than strings.

## Request and response

Send JSON; all three fields are required:

```json
{
  "resolution_summary": "The safety hazard has been removed.",
  "resolution_steps": [
    "Site engineer inspected the affected area",
    "Safety perimeter was established",
    "Contractor removed the obstruction",
    "Final site inspection was performed"
  ],
  "final_remarks": "Area is now safe for construction activities."
}
```

Summary and final remarks must be nonblank strings. Steps must be a nonempty array;
every entry must be a nonblank string. Values are trimmed. The dedicated endpoint sets
status automatically; a conflicting supplied status is rejected. Existing update endpoints
need `status: "resolved"` in addition to the feedback and can also update their existing
editable fields in the same request.

Successful resolution returns HTTP 200 in the existing envelope. Example (other existing
issue fields omitted):

```json
{
  "success": true,
  "message": "Issue resolved successfully.",
  "project_id": "00000000-0000-4000-8000-000000000012",
  "active_issue_count": 0,
  "has_active_issues": false,
  "data": {
    "id": "00000000-0000-4000-8000-000000000123",
    "title": "Big tree",
    "status": "resolved",
    "resolved_at": "2026-10-06T08:30:00.000Z",
    "resolution": {
      "resolution_summary": "The safety hazard has been removed.",
      "resolution_steps": [
        "Site engineer inspected the affected area",
        "Safety perimeter was established",
        "Contractor removed the obstruction",
        "Final site inspection was performed"
      ],
      "final_remarks": "Area is now safe for construction activities.",
      "resolved_by": {
        "id": "00000000-0000-4000-8000-000000000001",
        "name": "System Admin"
      },
      "resolved_at": "2026-10-06T08:30:00.000+00:00"
    }
  }
}
```

Controller errors use `{ "success": false, "message": "..." }`. The existing JWT
middleware retains its `{ "error": "..." }` format. HTTP statuses:

| Status | Meaning |
| --- | --- |
| 400 | Missing/invalid feedback, malformed UUID, or invalid update fields |
| 401 | Missing/expired authentication or inactive/missing resolver account |
| 403 | Insufficient project/role permission; existing middleware also uses this for invalid JWTs |
| 404 | Missing issue/project, including an issue outside the URL project |
| 409 | Issue is currently resolved (valid resolution request) |
| 500 | Unexpected database/server failure |

## Transaction and notifications

The transaction verifies the issue and current resolver, locks the project then the issue,
rechecks status under the lock, inserts feedback, updates the issue status/timestamp,
saves notifications, and commits. Any failed write rolls back the entire transaction.
Two concurrent resolutions produce one success and one conflict. All SQL values are
parameterized.

Existing `notifications` stores an individual **Issue Resolved** notification for the
original reporter and current assignee, deduplicated if they are the same user:
`Big tree has been resolved by System Admin.` Notifications remain available through
the existing `/notifications` API, using the project code in `project_id` as before.
Missing reporter/assignee IDs are skipped. A failed notification write rolls back the
resolution too.

After commit, the existing `/project-issues` Socket.IO namespace emits
`project_issues_updated` to authorized project recipients with current counts, and
`new_notification` only to each individual recipient's user room. Removed members
receive no project counts; an original reporter can still receive their individual
resolution notice. Socket failure does not undo a committed resolution or change its
successful HTTP response.

There is no general action/activity audit system in the inspected backend; login-security
logs are specific to authentication. No separate audit infrastructure was added. Resolution
records retain issue ID, resolver ID, feedback, and timestamps; issue details provide the
current issue title and resolver name. Issue routes do not currently support uploads, so
this endpoint accepts JSON without attachments.

## Postman / curl

After migrations, start the backend with `npm start` (default port `5001`, or your `PORT`).
Use a real open/in-progress issue UUID and an admin/project-manager JWT from `/auth/login`.

In Postman, select PATCH, enter `http://localhost:5001/issues/<ISSUE_UUID>/resolve`, set
Authorization to Bearer Token, and select Body -> raw -> JSON. Paste the request above.

For Windows PowerShell, save that JSON as `resolution.json`, then run:

```powershell
curl.exe --request PATCH "http://localhost:5001/issues/<ISSUE_UUID>/resolve" --header "Authorization: Bearer <TOKEN>" --header "Content-Type: application/json" --data-binary "@resolution.json"
curl.exe "http://localhost:5001/issues/<ISSUE_UUID>" --header "Authorization: Bearer <TOKEN>"
```

Expect 200 with feedback on the first resolution and 409 if the valid request is repeated.
Remove the summary, omit steps, send steps as a string/empty array/blank entries, or omit
final remarks to verify 400. Use an engineer/supervisor token with valid feedback to verify
403. Remove the token to verify 401; use a well-formed nonexistent UUID to verify 404.

To reopen through the existing PATCH endpoint, send `{ "status": "in_progress" }` to
`/issues/<ISSUE_UUID>`. Resolve again to create a new resolution record.

## Frontend integration and verification

Replace the one-click resolved status update with a form requiring summary, editable
multiple steps, and final remarks. Show it for admins and project managers with project
access; server authorization remains authoritative. Use the dedicated endpoint, or send
the same three fields alongside `status: "resolved"` to the existing update endpoint.
`resolution_notes` alone no longer suffices to mark an issue resolved.

Display `data.resolution` on resolved issue details. Handle null for historical issues or
reopened issues, and show validation messages for 400 and a refresh prompt for 409.
Use `resolution.resolved_by.name` and `resolution.resolved_at` for attribution. Continue
refetching project counts and issue lists on `project_issues_updated`; listen for
`new_notification` in the existing authenticated `/project-issues` namespace and refetch
notifications after reconnect.

```sh
npm run test:project-issues
npm run test:project-issues:db
```

Tests cover input validation, current-role authorization and stale JWTs, transaction
rollback at each write stage, feedback details/lists, reopening and repeated resolution,
private deduplicated reporter/assignee notifications, deletion cascade, and two real
concurrent PostgreSQL connections. The original database suite uses a rolled-back schema;
the concurrency test creates and removes its own uniquely named schema. Run against a
database where the configured user can create schemas. Node 24 environments that prevent
test subprocess spawning can use `node --test --test-isolation=none` with each test filename.

## Files changed

- `controllers/issuesController.js`: shared resolution/update transaction and enriched issue reads.
- `services/projectIssueService.js`: current resolver lookup, resolution permissions, private notification events.
- `routes/issuesRoutes.js`, `routes/project.js`: resolution routes and project-scoped detail route.
- `migrations/issue_resolutions.sql`, `migrations/issue_resolutions.js`: schema and transactional runner.
- `package.json`: `migrate:issue-resolutions` command.
- `tests/projectIssues.test.js`, `tests/projectIssuesDatabase.test.js`: workflow and concurrency coverage.
- `docs/issue-resolution-feedback.md`, `docs/project-issue-alerts.md`: setup and integration documentation.
