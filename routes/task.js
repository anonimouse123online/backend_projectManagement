const express = require('express');
const router = express.Router();
const taskController = require('../controllers/taskController');

router.get('/',  taskController.getTasks);   // ← add this
router.post('/', taskController.createTask);

module.exports = router;