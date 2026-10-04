# SitePulse login security audit

## Existing architecture and scope

The backend uses Express 5, PostgreSQL, bcryptjs, and a seven-day JWT containing
`id`, `email`, and `role`. The existing `/auth/login` response, password comparison,
role redirects, and JWT expiry remain intact. Security fields are additive.
Engineers use the same login endpoint and may omit `security_context`.

The inspected live `users.id` is UUID, with `full_name`, `email`, and `role` fields.
A `sessions` table exists, but the current authentication code does not read or
write it. It contains token data and is not used as an audit-history source.
No Audit Trail table or implementation was found in this backend. Existing
project/task/report behavior is unchanged. Session expiry events are not added.

## Files and functions

Modified:

- `controllers/authController.js`: `login` validates metadata and records failures
  or successful credential validation before completing the existing JWT flow.
- `routes/auth.js`: authenticated `/logout` endpoint.
- `routes/index.js`: mounts `/security`.
- `server.js`: configures trusted proxies before request middleware.
- `.env.example`: documents `TRUSTED_PROXY_CIDRS`.
- `package.json`: migration and test commands.

Created:

- `configuration/trustedProxy.js`: `configureTrustedProxy`.
- `services/loginSecurityContext.js`: `validateSecurityContext`, `getClientIp`,
  `normalizeIp`, and validation error helper `invalid`.
- `services/loginSecurityService.js`: `recordLoginSecurityEvent`,
  `recordLoginSecurityEventSafely`, `evaluateSecurity`, and `distanceKm`.
- `controllers/loginSecurityController.js`: `getLoginSecurityLogs`,
  `getLoginSecurityLog`, `logout`, `requireActiveSecurityUser`,
  `requireCurrentAdmin`, and `parseLogFilters`.
- `routes/security.js`: protected Security Logs routes.
- `migrations/login_security_logs.sql`: table, constraints, and indexes.
- `migrations/login_security_logs.js`: transactional migration runner `migrate`.
- `tests/loginSecurity.test.js`: API and unit regression tests.
- `tests/loginSecurityDatabase.test.js`: real PostgreSQL integration test.
- `docs/login-security-audit.md`: this contract and testing guide.

## Migration

Run against each deployment's configured database before deploying the code:

```sh
npm run migrate:login-security
```

The runner applies `migrations/login_security_logs.sql` in a transaction. It creates
`login_security_logs` with a BIGSERIAL event ID, UUID foreign key to `users`, account
identity snapshots, INET IP, optional location/device fields, security verdict,
and TIMESTAMPTZ timestamp. It adds indexes for recent events, account history,
failed attempts, and status. The migration can be rerun and does not modify users
or sessions. Deleting a user sets the audit foreign key to null while retaining
identity snapshots. Run this migration after either existing database setup script
for a new installation; those setup scripts are not rewritten.

## IP and reverse proxies

The backend gets the address from Express `req.ip`, with a socket-address fallback
if the selected value is not a valid IP. IPv4-mapped IPv6 becomes IPv4; other IPv6
addresses are canonicalized. IP fields in the request body are ignored, including
those inside `security_context`. The backend does not directly read arbitrary
`X-Forwarded-For` or `CF-Connecting-IP` headers.

No Render, Cloudflare, Nginx, or other inbound proxy configuration was found in the
repository. `TRUSTED_PROXY_CIDRS` defaults to empty, which explicitly sets Express
`trust proxy` to false. Direct requests use the socket peer and ignore forwarded
IP headers. If deployed behind an unconfigured proxy, the recorded IP will be the
proxy address until the verified deployment configuration is supplied.

After verifying the actual proxy chain, set a comma-separated list of the exact
proxy IP addresses or CIDRs. For example, **only if Nginx is the verified local
proxy**, `TRUSTED_PROXY_CIDRS=127.0.0.1/32,::1/128`. Boolean values, hop counts,
named broad ranges, and `/0` subnets are rejected at startup. No provider's proxy
ranges are guessed or enabled automatically.

The trusted proxy must sanitize/append forwarded headers correctly and deployment
network access must match the trusted chain. Express walks from the socket through
the forwarded chain right to left and stops at the nearest untrusted address.
See [Express proxy configuration](https://expressjs.com/en/guide/behind-proxies/).

## Validation and security rules

`security_context` may be omitted or null. If present, it must be an object.
Only the documented fields are persisted; client-provided account identity,
roles, IP, password, and token fields are ignored.

- Latitude and longitude must be finite JSON numbers in `[-90,90]` and
  `[-180,180]`, respectively, or null/omitted. They must be supplied together.
- Accuracy must be a finite JSON number from 0 through 1,000,000,000 metres,
  or null/omitted; it requires coordinates.
- Permission is `GRANTED`, `DENIED`, `UNAVAILABLE`, or `TIMEOUT`, or null/omitted.
  Non-null location values require `GRANTED`. `GRANTED` can also carry no
  coordinates, and `DENIED`/`UNAVAILABLE`/`TIMEOUT` accept null/omitted location.
- `user_agent`, `platform`, and `language` are strings or null, limited to
  2048, 100, and 35 characters. Control characters are rejected. The HTTP
  User-Agent header is a bounded fallback when a client user-agent is absent.
- Invalid metadata returns HTTP 400 `{ "error": "..." }` before credential
  lookup. JSON numeric strings are rejected. Missing/malformed credentials also
  return 400. Malformed requests and rate-limited requests are not credential
  failures; requests rejected by the existing limiter still return 429.

Names and roles come from `users`. Known active accounts with wrong passwords
retain their account identity in the admin-only log; unknown or inactive accounts
use null identity and the attempted normalized email. Both receive the existing
HTTP 401 `{ "error": "Invalid credentials." }` response, without a security verdict
that could expose account existence.

Rules are evaluated on the backend and do not block an account:

- First successful login is `NORMAL` and establishes a baseline.
- An IP absent from the account's last 90 days of successful history creates
  `NEEDS_REVIEW`; a nonempty user-agent absent from that history does likewise.
  Missing IP or agent is not treated as a new device/address.
- At least five failed attempts for the same normalized email in 15 minutes
  creates `SUSPICIOUS`, including on a subsequent successful login in that window.
  Failed history spans IPs, to cover attempts coming from multiple addresses.
  An advisory transaction lock serializes read/count/insert per email.
- An accurate client location at least 500 km from the last accurate successful
  location within 24 hours, with implied speed above 900 km/h, creates
  `NEEDS_REVIEW`. Both accuracies must be available and no worse than 10 km.
- A logout is stored as `LOGOUT`, `SUCCESS`, `NORMAL`.

Every flagged event has an explanation. Browser agent and location are
client-reported signals, not proof of identity or compromise. Denied permission,
missing location, and poor accuracy do not themselves flag an event. Changing a
browser or using a VPN may create a review signal. No account is labelled hacked.

Audit writes are awaited, but a database/history/write error does not disable the
existing login. The backend emits a server error code without credentials or SQL
parameters, and returns null verdict fields with `security_audit_available: false`.
The frontend should display audit unavailability instead of treating null as NORMAL.
Administrators should monitor this server error so missed audit events are visible.

## Frontend request and response contract

### Login

`POST /auth/login`, `Content-Type: application/json`, no Bearer token required:

```json
{
  "email": "admin@example.com",
  "password": "your-password",
  "security_context": {
    "latitude": 10.123456,
    "longitude": 123.123456,
    "location_accuracy": 25,
    "location_permission_status": "GRANTED",
    "user_agent": "Example Browser",
    "platform": "Win32",
    "language": "en-US"
  }
}
```

HTTP 200 (the existing fields are preserved):

```json
{
  "message": "Login successful.",
  "token": "<existing JWT>",
  "redirectTo": "/admin/dashboard",
  "security_status": "NORMAL",
  "security_flag": false,
  "security_reason": null,
  "security_audit_available": true,
  "user": {
    "id": "11111111-1111-4111-8111-111111111111",
    "name": "Juan Dela Cruz",
    "email": "admin@example.com",
    "role": "admin"
  }
}
```

The security fields can be `NEEDS_REVIEW`/`SUSPICIOUS`, true, and an explanation.
On audit failure, the three verdict fields are null and availability is false.
The engineer redirect remains `/engineer/dashboard`. No audit ID is added to the
login response. Never send an IP as trusted metadata; render log text as text,
not HTML. The backend stores no passwords, JWTs, refresh tokens, session secrets,
or biometric fields in these records.

### Admin Security Logs

Send `Authorization: Bearer <token>` on both routes:

- `GET /security/login-logs?page=1&limit=25`
- `GET /security/login-logs/:id`

Both routes run `verifyToken`, `requireAdmin`, and current database account checks.
Inactive/deleted/demoted accounts are refused even if the JWT still claims admin.
Engineers receive 403; missing/expired tokens receive 401. Responses use
`Cache-Control: no-store`.

List filters: `user_id` (UUID), `status` (`NORMAL`, `SUSPICIOUS`, `NEEDS_REVIEW`),
`from` and `to` (YYYY-MM-DD at midnight UTC, or ISO timestamps with explicit
timezone). Bounds are inclusive; a date-only `to` means midnight, so use
`2026-10-03T23:59:59.999+08:00` to include that whole Philippine calendar day.
URL-encode `+` as `%2B`. `page` defaults to 1, maximum 1,000,000; `limit` defaults
to 25, maximum 100. Invalid IDs, filters, dates, and pagination return 400.
Results are ordered by `created_at DESC, id DESC`. SQL values are parameterized.

HTTP 200 list response:

```json
{
  "success": true,
  "data": [
    {
      "id": "123",
      "user_id": "11111111-1111-4111-8111-111111111111",
      "user_name": "Juan Dela Cruz",
      "email": "admin@example.com",
      "role": "admin",
      "event_type": "LOGIN_SUCCESS",
      "login_status": "SUCCESS",
      "ip_address": "192.0.2.10",
      "latitude": 10.123456,
      "longitude": 123.123456,
      "location_accuracy": 25,
      "location_permission_status": "GRANTED",
      "user_agent": "Example Browser",
      "platform": "Win32",
      "language": "en-US",
      "security_status": "NORMAL",
      "security_flag": false,
      "security_reason": null,
      "created_at": "2026-10-03T12:35:00.000Z"
    }
  ],
  "pagination": { "page": 1, "limit": 25, "total": 100 }
}
```

IDs are decimal strings to preserve BIGINT precision. User IDs are UUID strings.
Coordinates/accuracy are JSON numbers or null. Timestamps are UTC ISO strings;
the frontend can display them in Asia/Manila. The detail response is
`{ "success": true, "data": <same log object> }`; absent IDs return
404 `{ "success": false, "error": "Login security log not found." }`.
Unknown user identity, missing metadata, or deleted account foreign keys may be
null. Database read errors return 500 with a generic message.

### Logout

`POST /auth/logout`, authenticated with the existing Bearer JWT. Body may be
empty or `{ "security_context": { ...same optional metadata... } }`.
HTTP 200:

```json
{
  "success": true,
  "message": "Logout recorded. Clear the token on the client.",
  "security_audit_available": true
}
```

This records the user's requested logout. The existing stateless JWT flow has no
revocation mechanism; the frontend must remove its token. This endpoint does not
invalidate a previously issued JWT on the server or change session handling.

## Testing

Automated tests:

```sh
npm run test:login-security
npm run test:login-security:db
```

The API/unit suite mocks PostgreSQL and tests real HTTP handlers, bcrypt checks,
JWT verification, RBAC, metadata validation, filters, and proxy header handling.
The PostgreSQL suite uses the configured DB, creates an isolated schema inside a
transaction, exercises the actual migration/history/insert/constraints, and rolls
everything back. It requires schema creation permission and does not modify
public users or audit records. In a sandbox that prevents test-worker spawning,
Node 24 can run these with `node --test --test-isolation=none <test-file>`.

Manual checks, using an existing test admin and the returned Bearer token:

1. **Successful login:** send the GRANTED example with valid credentials. Expect
   200, unchanged user/token/redirect fields and a successful audit record. For an
   account with no history expect NORMAL. Fetch logs with the admin token.
2. **Denied location:** send `location_permission_status: "DENIED"` and null
   latitude/longitude/accuracy. Expect 200 and null location in the record. Also
   try UNAVAILABLE/TIMEOUT and a request without `security_context`.
3. **Failed login:** use a wrong password, then an unknown email. Both return the
   same 401 body. Fetch logs as admin and confirm LOGIN_FAILED/FAILED, attempted
   email, server-determined IP, and metadata. Five failures within 15 minutes
   should flag the fifth as SUSPICIOUS. The existing 25-attempt rate limit applies.
4. **New device:** establish a successful baseline, then change `user_agent` to
   a distinct string. Expect a successful login with NEEDS_REVIEW and an unseen
   agent explanation. Repeating the same agent should recognize it as known.
5. **New IP:** log in from a second actual network/peer, or from a verified trusted
   proxy in a test deployment. Expect NEEDS_REVIEW and a new-IP explanation.
   On a direct connection, forging X-Forwarded-For or an IP in JSON must not change
   the recorded IP. Do not enable broad proxy trust just to simulate this case.
6. **RBAC:** call both log endpoints without a token and with an engineer token;
   expect 401/403. With a current active admin expect 200. Deactivate/demote a test
   admin and confirm its old token cannot read the logs.
7. **Location review:** use accurate locations more than 500 km apart within an
   hour for successive successful test logins; expect NEEDS_REVIEW with a location
   explanation. Missing/poor accuracy should skip this check.
8. **Logout:** POST with a valid token, fetch the LOGOUT record as admin, then
   clear the frontend token. Missing authentication must return 401.

IP/location are sensitive admin-only audit data. No retention period or external
export is introduced; set a retention policy for your deployment as needed.
