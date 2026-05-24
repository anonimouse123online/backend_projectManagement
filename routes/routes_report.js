const express = require('express');
const router = express.Router();
const reportController = require('../controllers/reportController');

// ─── Reports ──────────────────────────────────────────────────────────────────
router.get('/',               reportController.getReports);
router.get('/task/:taskId',   reportController.getReportsByTask);
router.get('/:id',            reportController.getReportById);
router.post('/process-now',   reportController.processReportsNow);

module.exports = router;