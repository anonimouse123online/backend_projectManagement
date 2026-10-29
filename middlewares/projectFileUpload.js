const multer = require('multer');
const path = require('node:path');
const fs = require('node:fs');

const docUploadDir = path.join(__dirname, '..', 'uploads', 'documents');
fs.mkdirSync(docUploadDir, { recursive: true });

// Share the existing document disk storage/naming implementation with issue images.
const storage = multer.diskStorage({
  destination: (req, _file, cb) => {
    const directory = req.issueImageUpload ? path.join(__dirname, '..', 'uploads', 'issues') : docUploadDir;
    try { fs.mkdirSync(directory, { recursive: true }); cb(null, directory); }
    catch (error) { cb(error); }
  },
  filename: (_req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `${unique}${path.extname(file.originalname)}`);
  },
});

const uploadDocuments = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });
const uploadImages = multer({ storage, limits: { fileSize: 15 * 1024 * 1024, files: 20 },
  fileFilter: (_req, file, cb) => {
    const extension = path.extname(file.originalname).toLowerCase();
    const expected = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
      '.webp': 'image/webp', '.gif': 'image/gif' }[extension];
    if (expected && (file.mimetype === expected || expected === 'image/jpeg' && file.mimetype === 'image/jpg')) cb(null, true);
    else cb(Object.assign(new Error('Only JPEG, PNG, WEBP or GIF images are allowed.'), { status: 400 }));
  },
}).array('images', 20);

async function parseIssueImages(req, res) {
  req.issueImageUpload = true;
  await new Promise((resolve, reject) => uploadImages(req, res, error => {
    if (error) reject(error instanceof multer.MulterError || error.status === 400
      ? Object.assign(error, { status: 400 }) : error);
    else resolve();
  }));
}

module.exports = { uploadDocuments, parseIssueImages };
