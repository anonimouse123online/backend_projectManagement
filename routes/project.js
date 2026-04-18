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
  getDocuments,
  uploadDocument,
  deleteDocument,
} = require('../controllers/projectController');

router.get('/',                              getAllProjects);
router.post('/',                             createProject);
router.post('/join',                         joinProject);           // ⚠️ before /:code
router.get('/joined',                        getJoinedProjects);     // ⚠️ before /:code
router.get('/:code',                         getProjectByCode);
router.get('/:code/active-code',             getActiveCode);
router.patch('/:code/status',                updateProjectStatus);
router.post('/:code/generate-code',          generateProjectCode);
router.get('/:code/available-members',       getAvailableMembers);
router.post('/:code/members',                addMember);
router.get('/:code/members',                 getProjectMembers);
router.get('/:code/documents',           getDocuments);
router.post('/:code/documents',          uploadDocument);
router.delete('/:code/documents/:docId', deleteDocument);

module.exports = router;