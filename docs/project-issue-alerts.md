# Project issue alerts

The backend uses the existing `project_issues` table. Projects and issues use UUID IDs. The separate, unused `issues` table is left untouched; all issue routes now use `project_issues`.

## Database setup

Run `npm run migrate:project-issues` and then `npm run migrate:issue-resolutions` before starting the updated backend. Run these after either existing database setup script for new installations too. The migrations are transactional and can be rerun. The alerts migration backfills `project_id` from `projects.code`, severity from priority, and canonical statuses from the existing values. Existing resolved records without a resolution timestamp use their last update or creation timestamp. See [Issue resolution feedback](issue-resolution-feedback.md) for the additional schema and API requirements.

The table retains `project_code`, `priority`, location, assignment and resolution notes. A trigger synchronizes UUID/code and severity/priority, normalizes legacy status values, updates `updated_at`, sets `resolved_at` on resolution, and clears it on reopening. Status and severity have database constraints. A partial index supports active issue lookups.

## HTTP API

All endpoints require the existing `Authorization: Bearer <token>` authentication.

`GET /projects` keeps its `{ "success": true, "data": [...] }` response and existing filters. Every project includes integer `active_issue_count` and boolean `has_active_issues`. `/projects/joined` and `/projects/:code` also include these fields. Counts use a single SQL statement with a grouped aggregate joined by `project_id`, count only `open` and `in_progress`, and apply even to completed projects.

`GET /projects/:projectId/issues?status=active` returns unresolved issues and the project's total active count:

```json
{
  "success": true,
  "project_id": "00000000-0000-4000-8000-000000000012",
  "active_issue_count": 1,
  "has_active_issues": true,
  "issues": [
    {
      "id": "00000000-0000-4000-8000-000000000051",
      "project_id": "00000000-0000-4000-8000-000000000012",
      "title": "Hollow blocks not delivered",
      "description": "Expected delivery did not arrive",
      "category": "delivery",
      "severity": "high",
      "status": "open",
      "reported_by": "00000000-0000-4000-8000-000000000001",
      "reporter_name": "Engineer Name"
    }
  ]
}
```

In real responses `data` contains the same issue array as `issues`, retaining the existing response field. Issues also include timestamps and existing location, assignment, reporter and resolution metadata. `reported_by` is the authenticated user's UUID; `reporter_name` provides the display name.

Project code URLs remain supported. Omitting `status` returns all issues, preserving the existing issue page. Supported status filters are `active`, `all`, `open`, `in_progress`, and `resolved`. Category, severity and search filters are optional. Legacy `All`, `Open`, `In Progress`, `Resolved`, and `priority=High` inputs remain accepted. Additional filters never change the project's total `active_issue_count`.

`POST /projects/:projectId/issues` accepts:

```json
{
  "title": "Hollow blocks not delivered",
  "description": "Expected delivery did not arrive",
  "category": "delivery",
  "severity": "high"
}
```

Title and description are required. Category defaults to `other` and severity to `medium`. Categories are extensible, including `materials`, `delivery`, `manpower`, `weather`, `supplier`, `equipment`, `safety`, `schedule`, and `other`; existing categories remain valid. Severity supports `low`, `medium`, `high`, `critical`. New issues always start `open`; attempts to create resolved/in-progress issues return 400. The project comes from the URL and the reporter from authentication. Optional `assigned_to` must be a project owner or member. Client-supplied `reported_by` is ignored, and a conflicting `project_id` is rejected.

Creation returns 201 with `data` containing the issue plus top-level `project_id`, `active_issue_count`, and `has_active_issues`. A project-scoped **New Project Issue** notification is saved in the same transaction; failed notification writes roll back issue creation. Notifications retain their existing code-based `project_id` contract.

`PATCH /projects/:projectId/issues/:issueId` updates status, severity, title, description, category, location, assignment or resolution notes. `PUT` is also accepted. Changing status to `resolved` now requires `resolution_summary`, a nonempty array of nonblank `resolution_steps`, and `final_remarks`, and only admins or project managers with project access may resolve. `PATCH /issues/:id/resolve` and `PATCH /projects/:projectId/issues/:issueId/resolve` accept the same feedback and set resolved status automatically. Resolution removes the issue from counts and sets `resolved_at`; reopening clears that timestamp and retains past feedback in `issue_resolutions`. Issue project reassignment is rejected. Updates return 200 with the issue, its current `resolution` (or null), and counts. A valid attempt to resolve a currently resolved issue returns 409.

Existing `GET /issues/:id`, `PUT /issues/:id`, `PATCH /issues/:id`, and `DELETE /issues/:id` use the same records and authorization. Project-scoped DELETE is also supported.

Admins can view and manage all project issues. Project managers can access owned or joined projects. Assigned engineers and supervisors can submit/update issues in their joined projects; owners can also submit/update. Existing project members retain read access. Only admins or project owners may delete issues. Unauthenticated requests return 401, unauthorized requests 403, missing projects/issues 404, malformed input 400, and unexpected database/server failures 500.

## Frontend realtime integration

Use the authenticated Socket.IO namespace `/project-issues` with the existing JWT:

```js
const socket = io(`${backendUrl}/project-issues`, {
  auth: { token: accessToken }
});

socket.on('project_issues_updated', ({ project_id }) => {
  // Invalidate/refetch the project list and the selected project's issue list.
  // Refetching handles concurrent edits and event ordering using current DB state.
  refreshProjects();
  if (selectedProjectId === project_id) refreshActiveIssues(project_id);
});
socket.on('connect', refreshProjects); // Catch changes missed while disconnected.
```

`project_issues_updated` includes `project_id`, `project_code`, `active_issue_count`, and `has_active_issues`. A new issue also emits `new_notification` in this namespace. No subscription event is needed: the server joins the authenticated user's room automatically and recomputes project recipients for each mutation. Removed members receive no subsequent issue events. Existing chat/notification sockets remain unchanged. Counts are always read from PostgreSQL; clients can also refresh/poll the HTTP endpoints.

## Verification

Run `npm run test:project-issues` and `npm run test:project-issues:db`. The database test uses the configured PostgreSQL connection and rolls back its temporary schema and fixtures. It covers migration reruns and constraints, legacy writes, count aggregation, filtering, HTTP authentication and project isolation, notifications and rollback, resolution/reopening, and authorized socket recipients. If the environment prevents subprocess spawning, use `node --test --test-isolation=none tests/projectIssues.test.js` and the same command for `tests/projectIssuesDatabase.test.js` (Node 24).
