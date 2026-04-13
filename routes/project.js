const express = require('express');
const router = express.Router();
const { getAllProjects, getProjectByCode, createProject } = require('../controllers/projectController');

router.get('/',       getAllProjects);
router.get('/:code',  getProjectByCode);
router.post('/',      createProject);       // ← add this

module.exports = router;