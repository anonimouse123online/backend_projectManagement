'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { imagesForReport, validateReferences } = require('../services/projectReportImageService');

const projectId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const image = `/uploads/project-reports/${projectId}/photo%20one.jpg`;

test('project report image serialization is project-scoped and tolerates malformed legacy references', () => {
  assert.deepEqual(imagesForReport([image, '/uploads/project-reports/other/photo.jpg', `${image}%ZZ`, 2], projectId),
    [{ url: image, filename: 'photo one.jpg' }]);
});

test('report image references reject external projects and traversal', () => {
  assert.throws(() => validateReferences(['/uploads/project-reports/other/image.jpg'], projectId), { status: 400 });
  assert.throws(() => validateReferences([`/uploads/project-reports/${projectId}/..%2Fsecret.jpg`], projectId), { status: 400 });
});
