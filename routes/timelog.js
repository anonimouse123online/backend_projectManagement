const express = require('express');

const router = express.Router();

const timelogController = require('../controllers/timelogController');

// GET /timelogs
router.get('/', timelogController.getTimelogs);

// POST /timelogs
router.post('/', timelogController.createTimelog);

module.exports = router;