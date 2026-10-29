Project documents keep the existing endpoints and `documents.file_path` field:

- `POST /projects/:code/documents` uses the existing multipart upload.
- `GET /projects/:code/documents` returns the existing `data` array, with normalized HTTP `file_path` values and an additive `mime_type` field.
- Fetch `file_path` directly with the same `Authorization: Bearer <token>` header used for the document list. Supported PDF, image and text files are served inline through the existing Express `/uploads` static server, including range requests. No download-first or new viewer endpoint is required.

Example document metadata:

```json
{ "id": "<document-id>", "name": "Project Plan", "file_path": "/uploads/documents/<stored-file>.pdf", "mime_type": "application/pdf" }
```

MIME types reflect the stored filename's extension, including CSV/DOCX/XLSX despite legacy metadata type normalization. Metadata-only records with no uploaded file return `file_path: null` and `mime_type: null`; no contents or links are fabricated. Invalid or out-of-root filesystem references are never exposed.

Before static serving, document requests reuse the same owner/membership/email access helper as the document list. Issue image requests reuse existing issue project read permissions. Authentication middleware and permission rules are unchanged. Project files require a bearer token, use private/no-store responses, and cannot bypass checks through encoded folder names or dot segments. Other upload folders retain their existing serving behavior.

Issue creation retains `POST /projects/:projectId/issues` (project UUID or code). It accepts the existing JSON report without images or multipart fields containing the existing report fields plus up to 20 `images` files (JPEG, PNG, WEBP or GIF, up to 15 MB each). Android can preview selected images using their local URIs before sending multipart; the backend returns persisted preview URLs after submission. No Android or frontend code was modified.

Document and issue uploads share the existing Multer disk storage/naming implementation in `middlewares/projectFileUpload.js`. Documents stay under `uploads/documents`; issue images stay under `uploads/issues`. Permissions are checked before issue files are stored and again inside the original issue transaction. New images are associated with the exact created issue, never inferred from dates or another report.

Example multipart creation:

```powershell
curl.exe -H "Authorization: Bearer <token>" -F "title=Damaged formwork" -F "description=Damage observed during inspection" -F "images=@photo.png" "http://localhost:5001/projects/<project-id-or-code>/issues"
```

Issue create/detail/update responses expose `data.images`; project issue lists expose the same arrays under each item of the existing `data`/`issues` lists:

```json
{ "id": "<issue-id>", "title": "Damaged formwork", "images": [{ "url": "/uploads/issues/<stored-image>.png", "filename": "<stored-image>.png" }] }
```

Existing image references may be submitted as `images: ["/uploads/issues/...png"]` or objects containing `url`; multipart can also send that array as a JSON-encoded `images` field alongside files. References must already be registered to the same authenticated reporter and project. Arbitrary files, another reporter's images, and other projects' images are rejected. Exact supplied references are copied into that issue's snapshot. This is not an unrestricted upload-by-path API or a new standalone upload endpoint.

Identical multipart retries by the same reporter/project reuse already committed image files through content-derived names. JSON reference retries also reuse files. The original API still creates an issue row per successful POST; no issue-row idempotency contract was introduced. Rejected or rolled-back creations clean up their new files while holding the existing project mutation lock; files reused from committed issues stay intact. No notification or socket behavior changed.

Database inspection found no issue image/attachment field or relationship. The minimal idempotent migration only adds `project_issues.image_paths JSONB NOT NULL DEFAULT '[]'`. Existing issue rows return `images: []`. Documents require no migration. Apply before using image attachments:

```powershell
node migrations/issue_images.js
```

The migration was tested with existing data and repeated execution in a temporary PostgreSQL schema, not applied to the application database. No tables were dropped/recreated or unrelated columns changed.

Focused validation:

```powershell
node --test --test-isolation=none tests/projectFiles.test.js tests/projectFilesDatabase.test.js
node --test --test-isolation=none tests/projectIssues.test.js
node --test --test-isolation=none tests/projectIssuesDatabase.test.js
```

Checks cover direct inline/range document fetch, native Windows path normalization, project membership and token checks, exact issue image persistence and retrieval, multiple images, image-less/legacy issues, mixed references/uploads, JSON and multipart retry reuse, rollback cleanup and upload limits. Test records are rolled back and only files created by test requests are removed.

Validation results: all four focused file tests, five existing issue unit tests, two issue database tests, seven prior report-image tests and the prior member-position integration test passed (19 tests total). Full lint has zero errors and 23 existing warnings. Syntax checks and `git diff --check` pass. The application database remains unmigrated and no temporary test schemas remain.

Files changed for document viewing: `controllers/projectController.js`, `routes/project.js`, and the shared file infrastructure below. Files changed for issue attachments: `controllers/issuesController.js`, `migrations/issue_images.js`, `migrations/issue_images.sql`, and the shared file infrastructure. Shared infrastructure: `server.js`, `middlewares/projectFileUpload.js`, `middlewares/projectFileAccess.js`, `services/projectFileService.js`. Tests/docs: `tests/projectFiles.test.js`, `tests/projectFilesDatabase.test.js`, `tests/projectIssuesDatabase.test.js`, this document, and the updated upload-support note in `docs/issue-resolution-feedback.md`.
