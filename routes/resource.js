const express = require('express');
const router = express.Router();
router.use(require('../middlewares/authMiddleware').verifyToken);
const resourceController = require('../controllers/resourceController');

router.get('/',     resourceController.getResources);
router.post('/', require('../middlewares/relatedProjectAccess').resource,    resourceController.createResource);
router.put('/:id', require('../middlewares/relatedProjectAccess').resource,   resourceController.updateResource);
router.patch('/:id', require('../middlewares/relatedProjectAccess').resource, resourceController.updateResource);
router.delete('/:id', require('../middlewares/relatedProjectAccess').resource, resourceController.deleteResource);

module.exports = router;