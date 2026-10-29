'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..', 'uploads', 'project-reports');

function referenceFor(file) {
  return `/uploads/project-reports/${encodeURIComponent(file.projectId)}/${encodeURIComponent(file.filename)}`;
}

function imagesForReport(paths, projectId) {
  if (!Array.isArray(paths)) return [];
  const prefix = `/uploads/project-reports/${encodeURIComponent(projectId)}/`;
  const result = [];
  for (const url of [...new Set(paths.filter(value => typeof value === 'string' && value.startsWith(prefix)))]) {
    try {
      const filename = decodeURIComponent(url.slice(prefix.length));
      if (filename && !filename.includes('/') && !filename.includes('\\') && filename !== '.' && filename !== '..') result.push({ url, filename });
    } catch { /* Ignore malformed legacy references. */ }
  }
  return result;
}

function validateReferences(values, projectId) {
  if (values === undefined) return undefined;
  if (!Array.isArray(values) || values.length > 20) throw Object.assign(new Error('images must be an array of at most 20 uploaded references.'), { status: 400 });
  const allowedPrefix = `/uploads/project-reports/${encodeURIComponent(projectId)}/`;
  const output = [];
  for (const raw of values) {
    const value = typeof raw === 'string' ? raw : raw?.url;
    if (typeof value !== 'string' || !value.startsWith(allowedPrefix)) throw Object.assign(new Error('An image does not belong to this project.'), { status: 400 });
    let filename;
    try { filename = decodeURIComponent(value.slice(allowedPrefix.length)); } catch { filename = ''; }
    if (!filename || filename.includes('/') || filename.includes('\\') || filename === '.' || filename === '..') {
      throw Object.assign(new Error('Invalid project report image reference.'), { status: 400 });
    }
    const filePath = path.resolve(root, projectId, filename);
    if (!filePath.startsWith(root + path.sep) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      throw Object.assign(new Error('The image was not uploaded for this project.'), { status: 400 });
    }
    output.push(value);
  }
  return [...new Set(output)];
}

module.exports = { root, referenceFor, imagesForReport, validateReferences };
