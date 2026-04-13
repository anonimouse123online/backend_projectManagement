const express = require('express');
const router = express.Router();
const softwareService = require('../services/softwareService');

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

module.exports = router;