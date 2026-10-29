Admin-created memberships use the existing `POST /projects/:code/members` endpoint:

```json
{ "userId": "<invited-user-uuid>" }
```

The existing owner-only check and active-user/duplicate-member checks remain unchanged. Admin-supplied `role`, `position`, or `designation` values do not assign a project position. New memberships store an empty string in `project_members.role` until the member chooses a position. The live field is `VARCHAR(50) NOT NULL`, permits empty strings, and requires no migration. Existing membership positions are preserved.

For an engineer already added by Admin, Software/Android opens the project and submits:

```http
PATCH /projects/:code/members/me/position
Authorization: Bearer <engineer-token>
Content-Type: application/json
```

```json
{ "position": "Site Engineer" }
```

The backend uses only the authenticated user's ID when selecting the membership to update. Request-supplied member/user IDs never redirect the update. Project access is checked with the existing helper, and the database update requires both the project code and that exact user's membership. Missing authentication returns 401; inaccessible projects return 403; no matching self membership returns 404. Positions must be trimmed nonempty strings of at most 50 characters; invalid positions return 400. Titles remain free-form because the existing database has no position enumeration.

For invite-code acceptance, the existing owner-only `POST /projects/:code/generate-code` endpoint is unchanged. The engineer joins with their own position using:

```http
POST /projects/join
```

```json
{ "invite_code": "<project-invite-code>", "position": "QA/QC Engineer" }
```

This existing acceptance endpoint now requires `position` and stores it for the authenticated joining user. Existing expired/used/invalid-code, owner and duplicate-member checks remain unchanged. Admin-created memberships still use the self-only PATCH endpoint rather than joining a second time; the existing join duplicate-member response remains 409.

`GET /projects/:code/members` continues to expose the membership's position in `role` and the user's global role separately in `system_role`. Empty positions stay empty rather than falling back to a system role. The self-update response returns `data.position`, `data.project_id`, `data.user_id`, and the existing membership ID. `users.role`, authentication middleware, project permissions, task assignment and all other modules are unchanged.

Validation uses a temporary PostgreSQL schema matching the installed membership constraints and rolls all fixtures back:

```powershell
node --test --test-isolation=none tests/projectMemberPositionDatabase.test.js
```
