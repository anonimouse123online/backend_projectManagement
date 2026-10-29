The existing backend flow is:

1. `POST /tasks/:id/images` accepts multipart `images` through the existing Multer storage.
2. Files stay in `uploads/tasks/<task-id>/<upload-date>/`; `task_images.image_paths` stores their local references.
3. `POST /tasks/:id/generate-report` or the existing scheduler sends those files as base64 to the Python AI service. Analysis does not delete the originals.
4. `reports.image_paths` snapshots public URLs for the files actually sent to AI.
5. `POST /tasks/:id/reports` copies those references to `project_reports.image_paths` alongside the report text.
6. `GET /projects/:code/reports` returns each report in the existing `data` array with `images: [{ "url": "/uploads/tasks/.../photo.jpg", "filename": "photo.jpg" }]`.

Web Admin displays `data[index].images[index].url`, resolved against the backend origin. Internal filesystem paths are not returned in this field. The upload and static-serving mechanisms are unchanged.

Android/Software uploads use multipart field `images`. The upload response now includes `images` as a string array of public URLs; `GET /tasks/:id/images` returns the same safe string format and checks task access. Report JSON accepts `report_text`, `report_date` (`YYYY-MM-DD`), and `images` (a string array of these exact stored references). Objects containing `url` remain accepted for compatibility. Each reference must match an upload registered to the task; another task's images and arbitrary paths/URLs are rejected. The supplied date is report metadata and never selects attachments by itself.

Submissions containing only `report_text` keep working and save no images. Alternatively, send `report_id` (the `id` already returned by `GET /tasks/:id/report`) to copy that specific AI report's recorded snapshot. If `report_id` and `images` are both supplied, selected images must belong to that snapshot. A legacy source report with no snapshot needs explicit `images`; its attachment set is never guessed from a daily batch. Clients doing AI analysis themselves must upload through the existing task image endpoint first. Report submission retries reuse the uploaded files; the existing API still creates a report row on each submission.

Reports with images reuse the existing task access helper. The Admin endpoint keeps its existing project access check. Submitted reports retain their own snapshots when a task receives more uploads or its AI report is regenerated. Image-less reports return `images: []`.

Database inspection found no report image/attachment association. The connected database also lacked `task_images` and `reports`, despite their existing definitions in `setup_new_db.sql`. The scoped, idempotent migration restores those two definitions only when absent and adds `image_paths` to `reports` and `project_reports`; it changes no unrelated tables and deletes no data. Existing Admin reports are not backfilled with guessed images.

Apply before running the changed backend:

```powershell
node migrations/report_images.js
```

The migration was validated in an isolated transaction/schema, not applied to the application database. The Software/Mobile and Web Admin client source code is not present in this repository; the trace above covers the existing backend routes and Python service.

Validation:

```powershell
node --test --test-isolation=none tests/reportImages.test.js tests/reportImagesDatabase.test.js
```

The database test uses the real upload, AI orchestration, submission, Admin query and static-serving code, with an AI response stub. It checks retained file bytes, no duplicate upload, exact source snapshots, both AI generation paths, relationship validation, existing access checks, delayed submission, legacy reports and migration idempotency. Its database changes roll back and its generated upload files are removed.

Verification reproduced and fixed automatic task/date image association, rejection of explicit Android references when an older daily AI snapshot existed, and internal path exposure from task image retrieval. Report submission also now returns 400 for missing/non-string report text and malformed task UUIDs instead of throwing runtime/database errors. Only the image retrieval endpoint gained a task access check, using the existing helper; authentication middleware and other authorization behavior were not changed.

All seven focused report-image tests and eight existing task-phase unit tests pass. The integration test additionally covers explicit string references, one/multiple/image-less reports, malformed references, an HTTP server restart, repeated migration runner calls, a partial upgrade with teammate data, and rollback/client release on migration failure. Full repository lint reports zero errors and 26 existing warnings; syntax checks and `git diff --check` pass. The existing task-phase database test still fails at `tests/taskPhasesDatabase.test.js:180` with both current code and original `HEAD`; it was left untouched.
