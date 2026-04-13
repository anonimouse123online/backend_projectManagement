const express = require('express');
const router = express.Router();
const dashboardController = require('../controllers/dashboardController');

router.get('/stats',      dashboardController.getStats);
router.get('/projects',   dashboardController.getProjects);
router.get('/monitor',    dashboardController.getMonitorItems);
router.get('/rfis',       dashboardController.getRFIs);
router.get('/notes',      dashboardController.getNotes);
router.get('/gauge',      dashboardController.getGaugeStats);

module.exports = router;