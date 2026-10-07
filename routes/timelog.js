const express = require('express');

const router = express.Router();

const timelogController = require('../controllers/timelogController');

// GET /timelogs
router.get('/', timelogController.getTimelogs);

// POST /timelogs
router.post('/', timelogController.createTimelog);

router.get('/:id', timelogController.getTimelogById);
router.patch('/:id', timelogController.updateTimelog);
router.put('/:id', timelogController.updateTimelog);
router.delete('/:id', timelogController.deleteTimelog);

module.exports = router;
