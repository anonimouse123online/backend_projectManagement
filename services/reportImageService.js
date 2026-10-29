const path = require('node:path');

const uploadRoot = path.resolve(__dirname, '..', 'uploads');

// Convert only this task's existing local upload references to public URLs.
function imagesForReport(imagePaths, taskId) {
  if (!Array.isArray(imagePaths) || !taskId) return [];
  const taskRoot = `tasks/${taskId}/`;
  const images = new Map();
  for (const storedPath of imagePaths) {
    if (typeof storedPath !== 'string') continue;
    let relative;
    if (storedPath.startsWith('/uploads/')) {
      try { relative = decodeURIComponent(storedPath.slice('/uploads/'.length)); }
      catch { continue; }
    } else {
      const localPath = path.isAbsolute(storedPath)
        ? storedPath : path.resolve(__dirname, '..', storedPath);
      relative = path.relative(uploadRoot, localPath).replaceAll('\\', '/');
    }
    const segments = relative.split('/');
    if (!relative.startsWith(taskRoot) || segments.length !== 4 ||
        segments.some(segment => !segment || segment === '.' || segment === '..' || segment.includes('\\') || segment.includes('\0')) ||
        !/^\d{4}-\d{2}-\d{2}$/.test(segments[2]) || !/\.(jpe?g|png)$/i.test(segments[3])) continue;
    const url = '/uploads/' + segments.map(encodeURIComponent).join('/');
    images.set(url, { url, filename: segments[3] });
  }
  return [...images.values()];
}

function invalidReference(message) {
  return Object.assign(new Error(message), { status: 400 });
}

async function submissionImages(db, taskId, body) {
  const date = body.report_date || new Date().toISOString().split('T')[0];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) {
    throw invalidReference('Invalid report_date. Use YYYY-MM-DD.');
  }
  if (body.report_id && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.report_id)) {
    throw invalidReference('Invalid report_id.');
  }
  const source = body.report_id ? await db.query(
    `SELECT image_paths, TO_CHAR(report_date, 'YYYY-MM-DD') AS report_date
     FROM reports WHERE task_id = $1 AND id = $2::uuid`,
    [taskId, body.report_id]
  ) : { rows: [] };
  if (body.report_id && !source.rows.length) {
    throw invalidReference('The source report does not belong to this task.');
  }
  const reportDate = source.rows[0]?.report_date || date;
  const snapshot = source.rows[0]?.image_paths;
  let images = imagesForReport(snapshot, taskId);
  if (body.images !== undefined) {
    if (!Array.isArray(body.images)) throw invalidReference('images must be an array of stored image references.');
    // An explicit reference identifies the attachment. The date is report metadata,
    // not a reason to add every image in a task's daily batch or select another report.
    if (body.images.length && snapshot == null) {
      const uploads = await db.query('SELECT image_paths FROM task_images WHERE task_id = $1', [taskId]);
      images = uploads.rows.flatMap(row => imagesForReport(row.image_paths, taskId));
    }
    const allowed = new Set(images.map(image => image.url));
    const selected = [];
    for (const reference of body.images) {
      const value = typeof reference === 'string' ? reference : reference?.url;
      const image = imagesForReport([value], taskId)[0];
      if (!image || !allowed.has(image.url)) {
        throw invalidReference('An image does not belong to the source report or task upload batch.');
      }
      selected.push(image.url);
    }
    images = imagesForReport(selected, taskId);
  }
  return { reportDate, imagePaths: images.map(image => image.url), images };
}

module.exports = { imagesForReport, submissionImages };
