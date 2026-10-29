const express = require('express');

const router = express.Router();
router.use(require('../middlewares/authMiddleware').verifyToken);

const timelogController = require('../controllers/timelogController');

// GET /timelogs
router.get('/', require('../middlewares/relatedProjectAccess').timelog, timelogController.getTimelogs);

// POST /timelogs
router.post('/', require('../middlewares/relatedProjectAccess').timelog, timelogController.createTimelog);

router.get('/:id', require('../middlewares/relatedProjectAccess').timelog, timelogController.getTimelogById);
router.patch('/:id', require('../middlewares/relatedProjectAccess').timelog, timelogController.updateTimelog);
router.put('/:id', require('../middlewares/relatedProjectAccess').timelog, timelogController.updateTimelog);
router.delete('/:id', require('../middlewares/relatedProjectAccess').timelog, timelogController.deleteTimelog);

module.exports = router;
