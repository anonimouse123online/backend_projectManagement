const express = require('express');
const router = express.Router();
const access = require('../middlewares/projectAccess');
router.use(require('../middlewares/authMiddleware').verifyToken);
const {
  getAllProjects,
  getProjectByCode,
  createProject,
  updateProjectStatus,
  updateProjectDueDate,
  generateProjectCode,
  joinProject,
  getActiveCode,
  getJoinedProjects,
  getAvailableMembers,
  addMember,
  setOwnProjectPosition,
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
  getProjectReports,
  createProjectReport,
  updateProjectReport,
} = require('../controllers/projectController');

// Both project-code and UUID issue URLs share the same authorization checks.
const {
  getProjectIssues,
  createIssue: createProjectIssue,
  updateIssue: updateProjectIssue,
  resolveIssue,
  getIssueById,
  deleteIssue,
} = require('../controllers/issuesController');

const { uploadDocuments: uploadDocs } = require('../middlewares/projectFileUpload');
const uploadReportImages = require('../middlewares/projectReportImageUpload');
const schedule = require('../controllers/scheduleController');

// Both project-code and UUID URLs share the same authorization check. Keep
// this before schedule handlers so each receives the authorized req.project.
router.use('/:code', (req, res, next) => {
  if (['join', 'joined'].includes(req.params.code)) return next();
  return access.project()(req, res, next);
});

// Schedule proposal and dependency APIs. Project membership is checked by the
// router-level guard above; only project managers may alter dependency edges.
router.get('/:code/schedule', schedule.getSchedule);
router.get('/:code/schedule/capabilities', schedule.getCapabilities);
router.get('/:code/schedule/critical-path', schedule.getCriticalPath);
router.get('/:code/schedule/calendar', schedule.getCalendar);
router.get('/:code/schedule/dependencies', schedule.getDependencies);
router.get('/:code/schedule/risk', schedule.getRisk);
router.post('/:code/schedule/dependencies', access.project(true), schedule.createDependency);
router.patch('/:code/schedule/dependencies/:id', access.project(true), schedule.updateDependency);
router.delete('/:code/schedule/dependencies/:id', access.project(true), schedule.deleteDependency);
router.post('/:code/schedule/simulations', schedule.createSimulation);
router.post('/:code/schedule/scenarios', schedule.createSimulation);
router.get('/:code/schedule/scenarios', schedule.listScenarios);
router.post('/:code/schedule/scenarios/compare', schedule.compareScenarios);
router.get('/:code/schedule/scenarios/:id', schedule.getScenario);
router.get('/:code/schedule/baselines', schedule.listBaselines);
router.post('/:code/schedule/baselines', access.project(true), schedule.createBaseline);
router.post('/:code/schedule/recovery-options', schedule.recoveryOptions);
router.get('/:code/schedule/history', schedule.getHistory);
router.post('/:code/schedule/change-requests', schedule.createChangeRequest);
router.get('/:code/schedule/change-requests', schedule.listChangeRequests);
router.get('/:code/schedule/change-requests/:id', schedule.getChangeRequest);
router.post('/:code/schedule/change-requests/:id/approve', access.project(true), schedule.approveChange);
router.post('/:code/schedule/change-requests/:id/reject', access.project(true), schedule.rejectChange);
router.post('/:code/schedule/change-requests/:id/reverse', access.project(true), schedule.reverseChange);

router.get('/',                              getAllProjects);
router.post('/',                             createProject);
router.post('/join',                         joinProject);           // ⚠️ before /:code
router.get('/joined',                        getJoinedProjects);     // ⚠️ before /:code
router.get('/:code',                         getProjectByCode);
router.get('/:code/active-code',             getActiveCode);
router.patch('/:code/status',                updateProjectStatus);
router.patch('/:code/due-date',              access.project(true), updateProjectDueDate);
router.delete('/:code',                      deleteProject);
router.post('/:code/generate-code',          generateProjectCode);
router.get('/:code/available-members',       getAvailableMembers);
router.post('/:code/members',                addMember);
router.patch('/:code/members/me/position',   setOwnProjectPosition);
router.get('/:code/members',                 getProjectMembers);
router.get('/:code/documents',               getDocuments);
router.post('/:code/documents',              access.project('work'), uploadDocs.any(), uploadDocument);
router.delete('/:code/documents/:docId',     access.project(true), deleteDocument);
router.delete('/:code/members/:memberId',    removeMember);
router.get('/:code/stats',                   getProjectStats);
router.get('/:code/active-task',             getProjectActiveTask);

// ─── Project Action Routes ───
router.get('/:code/progress',                getProjectProgress);
router.post('/:code/progress',               access.project(true), logProjectProgress);

router.get('/:code/issues',                  getProjectIssues);
router.post('/:code/issues',                 createProjectIssue);
router.get('/:code/issues/:issueId',         getIssueById);
router.patch('/:code/issues/:issueId/resolve', resolveIssue);
router.patch('/:code/issues/:issueId',       updateProjectIssue);
router.put('/:code/issues/:issueId',         updateProjectIssue);
router.delete('/:code/issues/:issueId',      deleteIssue);

router.get('/:code/reports',                 getProjectReports);
router.post('/:code/reports/images',          uploadReportImages, (req, res) => {
  const imageService = require('../services/projectReportImageService');
  const references = (req.files || []).map(file => imageService.referenceFor({
    projectId: req.project.id, filename: file.filename,
  }));
  return res.status(201).json({ success: true, data: references,
    images: imageService.imagesForReport(references, req.project.id) });
});
router.post('/:code/reports',                createProjectReport);
router.patch('/:code/reports/:reportId',      updateProjectReport);
router.put('/:code/reports/:reportId',        updateProjectReport);

module.exports = router;
