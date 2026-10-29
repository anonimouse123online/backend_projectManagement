const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const files = require('../services/projectFileService');

test('document references normalize stored local/Windows paths to usable URLs with actual file MIME types', () => {
  const stored = path.resolve(__dirname, '..', 'uploads', 'documents', 'project plan.pdf');
  const expected = { id: 'doc', file_path: '/uploads/documents/project%20plan.pdf', mime_type: 'application/pdf' };
  assert.deepEqual(files.documentResponse({ id: 'doc', file_path: stored }), expected);
  assert.deepEqual(files.documentResponse({ id: 'doc', file_path: '/uploads/documents/project%20plan.pdf' }), expected);
  assert.equal(files.documentResponse({ type: 'PDF', file_path: '/uploads/documents/photo.png' }).mime_type, 'image/png');
  assert.equal(files.documentResponse({ file_path: '/uploads/documents/notes.txt' }).mime_type, 'text/plain');
  assert.equal(files.documentResponse({ file_path: null }).file_path, null);
  if (process.platform === 'win32') assert.deepEqual(files.documentResponse({ id: 'doc', file_path: stored.replaceAll('/', '\\') }), expected);
});

test('arbitrary filesystem paths, remote URLs, malformed encoding and traversal are not exposed', () => {
  for (const stored of [path.resolve(__dirname, '..', '.env'), 'https://example.test/document.pdf',
    '/uploads/documents/%2e%2e/secret.pdf', '/uploads/documents/%5csecret.pdf',
    '/uploads/documents/%00secret.pdf', '/uploads/documents/%', '/uploads/documents/.secret',
    '/uploads/messages/document.pdf', null, 42]) {
    assert.equal(files.fileReference(stored, 'documents'), null);
  }
});

test('issue responses use only their recorded image references and safely handle empty/legacy values', () => {
  const paths = ['/uploads/issues/photo%20one.jpg', '/uploads/issues/photo%20one.jpg', '/uploads/issues/second.png'];
  const response = files.issueResponse({ id: 'issue', image_paths: paths });
  assert.deepEqual(response.images, [{ url: paths[0], filename: 'photo one.jpg' }, { url: paths[2], filename: 'second.png' }]);
  assert.equal('image_paths' in response, false);
  for (const value of [undefined, null, {}, '[]', []]) assert.deepEqual(files.issueResponse({ image_paths: value }).images, []);
  assert.deepEqual(files.imageReferences(['/uploads/documents/photo.jpg', '/uploads/issues/file.pdf', 'https://example.test/photo.jpg']), []);
});
