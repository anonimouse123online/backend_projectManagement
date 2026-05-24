const express = require('express');
const router = express.Router();
const taskController = require('../controllers/taskController');

router.get('/',             taskController.getTasks);
router.get('/users',        taskController.getUsers);
router.get('/:id',          taskController.getTaskById);
router.post('/',            taskController.createTask);
router.patch('/:id/status', taskController.updateTaskStatus);

router.post('/:id/images', function(req, res, next) {
  taskController.upload.array('images', 20)(req, res, function(err) {
    if (err) {
      console.error('Multer error:', err.message);
      return res.status(400).json({ error: err.message });
    }
    next();
  });
}, taskController.uploadTaskImages);

router.get('/:id/images',           taskController.getTaskImages);
router.get('/:id/report',           taskController.getTaskReport);
router.post('/:id/generate-report', taskController.generateReportNow);

module.exports = router;