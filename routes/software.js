const express = require('express');
const router = express.Router();
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
router.get('/',                   softwareController.getAllSoftware);
router.get('/project/:projectId', softwareController.getSoftwareByProject);
router.get('/:id',                softwareController.getSoftwareById);
router.post('/',                  softwareController.createSoftware);
router.patch('/:id',              softwareController.updateSoftware);
router.delete('/:id',             softwareController.deleteSoftware);

module.exports = router;