const express = require('express');
const router = express.Router();
const taskController = require('../controllers/taskController');

router.get('/',             taskController.getTasks);
router.post('/',            taskController.createTask);
router.get('/:id',          taskController.getTaskById);
router.patch('/:id/status', taskController.updateTaskStatus);

module.exports = router;