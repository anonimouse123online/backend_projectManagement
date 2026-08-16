const express = require('express');
const router = express.Router();
const timelogController = require('../controllers/timelogController');

router.get('/', timelogController.getTimelogs);

module.exports = router;
