const express = require('express');
const router = express.Router();
router.use(require('../middlewares/authMiddleware').verifyToken);
const reportController = require('../controllers/reportController');

// ─── Reports ──────────────────────────────────────────────────────────────────
router.get('/',               reportController.getReports);
router.get('/task/:taskId', require('../middlewares/projectAccess').task(),   reportController.getReportsByTask);
router.get('/:id',            reportController.getReportById);
router.post('/process-now', require('../middlewares/authMiddleware').requireAdmin,   reportController.processReportsNow);

module.exports = router;