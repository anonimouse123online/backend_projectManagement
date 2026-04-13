const express = require('express');
const router = express.Router();
const resourceController = require('../controllers/resourceController');

router.get('/',     resourceController.getResources);
router.post('/',    resourceController.createResource);
router.patch('/:id', resourceController.updateResource);
router.delete('/:id', resourceController.deleteResource);

module.exports = router;