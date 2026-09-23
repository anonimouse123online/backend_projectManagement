const express = require('express');
const router = express.Router();
const {
  getAllProjects,
  getProjectByCode,
  createProject,
  updateProjectStatus,
  generateProjectCode,
  joinProject,
  getActiveCode,
  getJoinedProjects,
  getAvailableMembers,
  addMember,
  getProjectMembers,
  removeMember,
  getProjectStats,
  getProjectActiveTask,
  getDocuments,
  uploadDocument,
  deleteDocument,
  deleteProject,
  // Project Actions
  getProjectProgress,
  logProjectProgress,
  getProjectIssues,
  createProjectIssue,
  updateProjectIssue,
  getProjectReports,
  createProjectReport,
} = require('../controllers/projectController');

const multer = require('multer');
const path = require('path');
const fs = require('fs');

const docUploadDir = path.join(__dirname, '..', 'uploads', 'documents');
if (!fs.existsSync(docUploadDir)) {
  fs.mkdirSync(docUploadDir, { recursive: true });
}

const docStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, docUploadDir);
  },
  filename: (req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    const ext = path.extname(file.originalname);
    cb(null, `${unique}${ext}`);
  }
});

const uploadDocs = multer({
  storage: docStorage,
  limits: { fileSize: 50 * 1024 * 1024 }
});

router.get('/',                              getAllProjects);
router.post('/',                             createProject);
router.post('/join',                         joinProject);           // ⚠️ before /:code
router.get('/joined',                        getJoinedProjects);     // ⚠️ before /:code
router.get('/:code',                         getProjectByCode);
router.get('/:code/active-code',             getActiveCode);
router.patch('/:code/status',                updateProjectStatus);
router.delete('/:code',                      deleteProject);
router.post('/:code/generate-code',          generateProjectCode);
router.get('/:code/available-members',       getAvailableMembers);
router.post('/:code/members',                addMember);
router.get('/:code/members',                 getProjectMembers);
router.get('/:code/documents',               getDocuments);
router.post('/:code/documents',              uploadDocs.any(), uploadDocument);
router.delete('/:code/documents/:docId',     deleteDocument);
router.delete('/:code/members/:memberId',    removeMember);
router.get('/:code/stats',                   getProjectStats);
router.get('/:code/active-task',             getProjectActiveTask);

// ─── Project Action Routes ───
router.get('/:code/progress',                getProjectProgress);
router.post('/:code/progress',               logProjectProgress);

router.get('/:code/issues',                  getProjectIssues);
router.post('/:code/issues',                 createProjectIssue);
router.patch('/:code/issues/:issueId',       updateProjectIssue);

router.get('/:code/reports',                 getProjectReports);
router.post('/:code/reports',                createProjectReport);

module.exports = router;