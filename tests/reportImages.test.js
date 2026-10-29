const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { imagesForReport, submissionImages } = require('../services/reportImageService');

const task = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const url = `/uploads/tasks/${task}/2026-10-07/photo%20one.jpg`;

test('report images expose usable URLs and reject filesystem escapes and other tasks', () => {
  const stored = path.resolve(__dirname, '..', 'uploads', 'tasks', task, '2026-10-07', 'photo one.jpg');
  assert.deepEqual(imagesForReport([stored, url], task), [{ url, filename: 'photo one.jpg' }]);
  if (process.platform === 'win32') {
    assert.deepEqual(imagesForReport([stored.replaceAll('/', '\\')], task), [{ url, filename: 'photo one.jpg' }]);
  }
  assert.deepEqual(imagesForReport([
    path.resolve(__dirname, '..', '.env'), 'https://example.com/photo.jpg',
    `/uploads/tasks/another-task/2026-10-07/photo.jpg`,
    `/uploads/tasks/${task}/2026-10-07/%2e%2e`,
    `/uploads/tasks/${task}/2026-10-07/%2e%2e%2fsecret.jpg`,
    `/uploads/tasks/${task}/2026-10-07/%5csecret.jpg`,
    `/uploads/tasks/${task}/2026-10-07/secret.txt`, null,
  ], task), []);
});

test('explicit source report cannot silently select another task or an invalid date', async () => {
  const db = { async query() { return { rows: [] }; } };
  await assert.rejects(submissionImages(db, task, { report_id: task }), { status: 400 });
  await assert.rejects(submissionImages(db, task, { report_id: 'invalid' }), { status: 400 });
  await assert.rejects(submissionImages(db, task, { report_date: '2026-02-30' }), { status: 400 });
});

test('analyzed snapshot wins over later uploads, including a deliberately empty snapshot', async () => {
  for (const image_paths of [[url], []]) {
    const db = { async query() { return { rows: [{ image_paths, report_date: '2026-10-07' }] }; } };
    const result = await submissionImages(db, task, { report_id: task });
    assert.deepEqual(result.imagePaths, image_paths);
    await assert.rejects(submissionImages(db, task, { report_id: task, images: [url.replace('photo%20one', 'other')] }), { status: 400 });
  }
});

test('legacy reports and clients analyzing uploaded images themselves reuse the existing batch', async () => {
  const stored = path.resolve(__dirname, '..', 'uploads', 'tasks', task, '2026-10-07', 'photo one.jpg');
  for (const sourceRows of [[], [{ image_paths: null, report_date: '2026-10-07' }]]) {
    const db = { async query(sql, values) {
      if (sql.includes('FROM reports')) return { rows: sourceRows };
      assert.deepEqual(values, [task]);
      return { rows: [{ image_paths: [stored] }] };
    } };
    const result = await submissionImages(db, task, { report_date: '2026-10-07', images: [{ url }] });
    assert.deepEqual(result.images, [{ url, filename: 'photo one.jpg' }]);
    assert.deepEqual(result.imagePaths, [url]);
  }
});

test('image-less submissions must not inherit a task/date batch or another report snapshot', async () => {
  const db = { async query() { return { rows: [{ image_paths: [url], report_date: '2026-10-07' }] }; } };
  assert.deepEqual((await submissionImages(db, task, { report_date: '2026-10-07' })).images, []);
});

test('Android string references select exact stored uploads even when the day has an older AI report', async () => {
  const other = url.replace('photo%20one', 'new');
  const db = { async query(sql) {
    return { rows: sql.includes('FROM reports')
      ? [{ image_paths: [url], report_date: '2026-10-07' }]
      : [{ image_paths: [url, other] }] };
  } };
  assert.deepEqual((await submissionImages(db, task, { report_date: '2026-10-07', images: [other] })).imagePaths, [other]);
  assert.deepEqual((await submissionImages(db, task, { report_date: '2026-10-08', images: [url] })).imagePaths, [url]);
});
