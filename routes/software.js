const express = require('express');
const router = express.Router();
router.use(require('../middlewares/authMiddleware').verifyToken);
const softwareService = require('../services/softwareService');
const softwareController = require('../controllers/softwareController');

// ─── SYNC / STATUS (existing) ─────────────────────────────
router.get('/status', async (req, res) => {
  try {
    const result = await softwareService.getStatus();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/sync', async (req, res) => {
  try {
    const result = await softwareService.syncData(req.body);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── CRUD ─────────────────────────────────────────────────
router.get('/', require('../middlewares/relatedProjectAccess').software,                   softwareController.getAllSoftware);
router.get('/project/:projectId', require('../middlewares/relatedProjectAccess').software, softwareController.getSoftwareByProject);
router.get('/:id', require('../middlewares/relatedProjectAccess').software,                softwareController.getSoftwareById);
router.post('/', require('../middlewares/relatedProjectAccess').software,                  softwareController.createSoftware);
router.patch('/:id', require('../middlewares/relatedProjectAccess').software,              softwareController.updateSoftware);
router.delete('/:id', require('../middlewares/relatedProjectAccess').software,             softwareController.deleteSoftware);

module.exports = router;