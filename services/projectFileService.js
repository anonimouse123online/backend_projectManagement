const path = require('node:path');
const fs = require('node:fs/promises');
const { createHash } = require('node:crypto');

const uploadRoot = path.resolve(__dirname, '..', 'uploads');
const mimeTypes = {
  '.pdf': 'application/pdf', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp',
  '.txt': 'text/plain', '.csv': 'text/csv', '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

function fileReference(storedPath, folder) {
  if (typeof storedPath !== 'string' || !storedPath) return null;
  let relative;
  const httpPath = storedPath.replaceAll('\\', '/');
  if (httpPath.startsWith('/uploads/')) {
    try { relative = decodeURIComponent(httpPath.slice('/uploads/'.length)); }
    catch { return null; }
  } else {
    const localPath = path.isAbsolute(storedPath) ? storedPath : path.resolve(__dirname, '..', storedPath);
    relative = path.relative(uploadRoot, localPath).replaceAll('\\', '/');
  }
  const segments = relative.split('/');
  if (segments.length !== 2 || segments[0] !== folder || !segments[1] || segments[1].startsWith('.') ||
      segments[1].includes('\\') || segments[1].includes('\0')) return null;
  const filename = segments[1];
  return { url: `/uploads/${folder}/${encodeURIComponent(filename)}`, filename,
    mime_type: mimeTypes[path.extname(filename).toLowerCase()] || 'application/octet-stream',
    localPath: path.join(uploadRoot, folder, filename) };
}

function documentResponse(document) {
  const file = fileReference(document.file_path, 'documents');
  return { ...document, file_path: file?.url || null, mime_type: file?.mime_type || null };
}

function imageReferences(imagePaths) {
  if (!Array.isArray(imagePaths)) return [];
  const images = new Map();
  for (const value of imagePaths) {
    const file = fileReference(value, 'issues');
    if (file && /^image\/(jpeg|png|webp|gif)$/.test(file.mime_type)) {
      images.set(file.url, { url: file.url, filename: file.filename });
    }
  }
  return [...images.values()];
}

function issueResponse(issue) {
  if (!issue) return issue;
  const { image_paths, ...fields } = issue;
  return { ...fields, images: imageReferences(image_paths) };
}

function inlineHeaders(res, file) {
  res.setHeader('Content-Type', file.mime_type);
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.vary('Authorization');
  if (file.mime_type === 'application/pdf' || file.mime_type.startsWith('image/') || file.mime_type.startsWith('text/')) {
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(file.filename)}`);
  }
}

async function discardIssueFiles(files = []) {
  for (const file of files) {
    if (file.reusedIssueImage) continue;
    const reference = fileReference(file.path, 'issues');
    if (reference) {
      try { await fs.unlink(reference.localPath); }
      catch (error) { if (error.code !== 'ENOENT') console.error('Failed to clean up an unsubmitted issue image:', error.code); }
    }
  }
}

// Called under the existing project mutation lock. Identical retries by the same
// reporter/project reuse committed images; document storage/naming is unchanged.
async function prepareIssueFiles(files = [], project, user, db) {
  const prepared = new Set();
  for (const file of files) {
    const temporary = fileReference(file.path, 'issues');
    const digest = createHash('sha256').update(await fs.readFile(temporary.localPath)).digest('hex');
    const extension = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' }[temporary.mime_type];
    const stored = fileReference(`/uploads/issues/${project.id}-${user.id}-${digest}${extension}`, 'issues');
    const registered = prepared.has(stored.url) ? { rows: [{}] } : await db.query(
      'SELECT id FROM project_issues WHERE project_id = $1 AND reported_by = $2 AND image_paths @> $3::jsonb LIMIT 1',
      [project.id, user.id, JSON.stringify([stored.url])]
    );
    let exists = false;
    try { await fs.access(stored.localPath); exists = true; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (registered.rows.length && exists) {
      await fs.unlink(temporary.localPath);
      file.reusedIssueImage = true;
    } else {
      await fs.rename(temporary.localPath, stored.localPath);
    }
    file.path = stored.localPath;
    file.filename = stored.filename;
    prepared.add(stored.url);
  }
}

module.exports = { fileReference, documentResponse, imageReferences, issueResponse, inlineHeaders, discardIssueFiles, prepareIssueFiles };
