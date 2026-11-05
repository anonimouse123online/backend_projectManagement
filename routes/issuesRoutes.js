const express = require('express');
const router = express.Router();
router.use(require('../middlewares/authMiddleware').verifyToken);

const {
  getProjectIssues,
  createIssue,
  getIssueById,
  updateIssue,
  resolveIssue,
  deleteIssue,
} = require('../controllers/issuesController');

router.get('/projects/:projectId/issues', getProjectIssues);
router.post('/projects/:projectId/issues', createIssue);

router.get('/issues/unresolved-count', async (req, res) => {
  try {
    const access = require('../services/projectAccessService');
    const pool = require('../db');
    const query = `
      SELECT COALESCE(SUM(issue_counts.active_issue_count), 0)::int AS unresolved_count,
             COUNT(p.id) FILTER (WHERE issue_counts.active_issue_count > 0)::int AS projects_with_issues_count
      FROM projects p
      JOIN (
        SELECT project_id, COUNT(*)::int AS active_issue_count
        FROM project_issues WHERE status IN ('open', 'in_progress') GROUP BY project_id
      ) issue_counts ON issue_counts.project_id = p.id
      WHERE ${access.projectScope('p', 1)}
    `;
    const { rows } = await pool.query(query, [req.user.id]);
    const unresolvedCount = Number(rows[0]?.unresolved_count || 0);
    const projectsWithIssuesCount = Number(rows[0]?.projects_with_issues_count || 0);
    return res.status(200).json({
      success: true,
      data: {
        unresolvedCount,
        projectsWithIssuesCount,
      },
      unresolvedCount,
      projectsWithIssuesCount,
    });
  } catch (error) {
    console.error('Failed to get unresolved issues count:', error);
    return res.status(500).json({ success: false, error: 'Failed to fetch unresolved issues count' });
  }
});

router.get('/issues/:id', getIssueById);
router.patch('/issues/:id/resolve', resolveIssue);
router.put('/issues/:id', updateIssue);
router.patch('/issues/:id', updateIssue);
router.delete('/issues/:id', deleteIssue);

module.exports = router;
