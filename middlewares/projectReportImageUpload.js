'use strict';
const multer = require('multer');
const fs = require('node:fs');
const path = require('node:path');
const service = require('../services/projectReportImageService');

const upload = multer({
  storage: multer.diskStorage({
    destination(req, _file, cb) {
      const directory = path.join(service.root, req.project.id);
      try { fs.mkdirSync(directory, { recursive: true }); cb(null, directory); }
      catch (error) { cb(error); }
    },
    filename(_req, file, cb) {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${Date.now()}-${require('node:crypto').randomUUID()}${ext}`);
    },
  }),
  limits: { fileSize: 15 * 1024 * 1024, files: 20 },
  fileFilter(_req, file, cb) {
    const allowed = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed[ext] === file.mimetype || (ext === '.jpg' && file.mimetype === 'image/jpg')) cb(null, true);
    else cb(Object.assign(new Error('Only JPEG, PNG or WEBP images are allowed.'), { status: 400 }));
  },
}).array('images', 20);

module.exports = function projectReportImageUpload(req, res, next) {
  upload(req, res, error => {
    if (error) return next(Object.assign(error, { status: error.status || (error.code === 'LIMIT_FILE_SIZE' ? 413 : 400) }));
    next();
  });
};
