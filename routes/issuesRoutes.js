const express = require('express');
const router = express.Router();

const {
  getProjectIssues,
  createIssue,
  getIssueById,
  updateIssue,
  deleteIssue,
} = require('../controllers/issuesController');

router.get('/projects/:projectId/issues', getProjectIssues);
router.post('/projects/:projectId/issues', createIssue);

router.get('/issues/:id', getIssueById);
router.put('/issues/:id', updateIssue);
router.delete('/issues/:id', deleteIssue);

module.exports = router;