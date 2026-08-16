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
router.post('/:code/documents',              uploadDocument);
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