# Backend CI

`.github/workflows/backend-ci.yml` runs on pull requests targeting `main` and pushes
to `main`. Its single required check is named **Backend CI**.

## Checks and runtime

- Node.js 24, using `actions/checkout` and `actions/setup-node` with npm caching.
  There is currently no `engines.node`, `.nvmrc` or `.node-version` declaration.
  The old `readme` recommends Node 18, but locked `firebase-admin` 14.3.0 requires
  Node 22 or newer. CI uses Node 24 to match a compatible runtime.
- `npm ci` installs the committed `package-lock.json`. Keep this file committed;
  dependency or lockfile mismatches fail CI.
- Every project `.js`, `.cjs` and `.mjs` file is checked with `node --check`, excluding
  dependencies, Git metadata and uploads.
- `npm run lint` uses the CommonJS flat config in `eslint.config.js` and ESLint's
  recommended rules. Console logging is allowed. Unused variables are warnings;
  intentionally unused names beginning with `_` are exempt. Lint errors fail CI.
  Build runs only if a build script exists; none is configured currently.
- Existing `test` / `test:*` scripts run, excluding empty scripts and the standard
  npm "no test specified" placeholder. Currently these are `test:project-issues`,
  `test:project-issues:db`, `test:login-security`, and `test:login-security:db`.
  Each script has a two-minute limit. Keep these scripts finite (no watch mode).
  With no test scripts, CI explicitly reports that tests are skipped; it does not
  create substitute tests.
- A separate startup validation launches `server.js`, which loads the route,
  controller, service and Socket.IO modules and connects to the CI database. It
  requires HTTP 200 and the expected JSON from `/health` within 20 seconds, then
  terminates the child server. Import errors, startup failures and timeouts fail
  the check. This validates startup, not every API's business behavior.

## CI environment and secrets

**No GitHub repository secrets or variables are required for the current checks.**
The workflow supplies the following test-only configuration:

| Variable | CI value / source |
| --- | --- |
| `NODE_ENV` | `test` |
| `DB_HOST`, `DB_PORT` | `127.0.0.1`, `5432` (disposable PostgreSQL 18 service) |
| `DB_NAME`, `DB_USER` | `backend_ci`, `backend_ci` |
| `DB_PASSWORD` | Empty; the disposable service uses trust authentication |
| `JWT_SECRET` | Random 32-byte value generated and masked on each run |
| `PORT` | `5001` |
| `CORS_ORIGIN` | `http://localhost:5173` |
| `TRUSTED_PROXY_CIDRS` | Empty; no reverse proxy is needed |
| `AI_SERVICE_URL` | `http://127.0.0.1:8000`; the checks do not call the AI service |

The PostgreSQL service is created for the job and discarded afterward. Trust
authentication is only for this temporary CI service; it is not a production
configuration. Both database suites create their own fixture schemas and roll
back their transactions, so CI does not run production database setup scripts
or copy production data. The startup check only needs a successful connection.

The repository currently tracks `.env`. CI removes it from the runner's checkout
before executing npm scripts or application code to prevent dotenv from loading
production settings. This does not modify developers' local `.env` files. CI also
removes `configuration/firebase-service-account.json` from its checkout. The
existing Firebase configuration disables push delivery when that file is absent;
no application logic changes are needed. These checks do not exercise real push
delivery, EmailJS or the Python AI service.

Do not supply production database, Firebase, JWT or API credentials to this
workflow. If future tests need an external service, use a dedicated test account
and GitHub **Settings → Secrets and variables → Actions → Repository secrets**.
Reference secrets with `${{ secrets.SECRET_NAME }}` rather than committing values.
For example, EmailJS integration would require test-only `EMAILJS_SERVICE_ID`,
`EMAILJS_PUBLIC_KEY`, `EMAILJS_PRIVATE_KEY` (if required by that account), and the
relevant template IDs. They are not required or injected by this workflow.
Fork pull requests can run the current checks without access to repository secrets.

Commit the existing test files, migrations and supporting application changes
together with this workflow so the checkout contains everything the npm scripts
reference.

## Protect `main`

After the first CI run, open **Settings → Branches → Add branch protection rule**
for `main` (or create an active ruleset targeting `main`):

1. Require a pull request before merging and at least one approving review.
2. Dismiss stale approvals when new commits are pushed.
3. Require status checks before merging. Select the check **Backend CI**, with
   **GitHub Actions** as its expected source where offered. The workflow and job
   are both named Backend CI; select the actual job check shown after a run.
4. Require branches to be up to date before merging.
5. Require conversation resolution before merging.
6. Apply the rule to administrators and disallow bypassing these requirements;
   for a ruleset, leave the bypass list empty.
7. Keep force pushes and branch deletion disabled.

The workflow provides a failing status; branch protection enforces the merge
restriction. These repository settings must be configured in GitHub separately.
The workflow intentionally has no path filters or job-level skip condition, so
every pull request targeting `main` produces the required check.

References: [GitHub protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches),
[PostgreSQL service containers](https://docs.github.com/en/actions/tutorials/use-containerized-services/create-postgresql-service-containers),
and [setup-node npm caching](https://github.com/actions/setup-node#caching-global-packages-data).
