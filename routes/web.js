const express = require('express');
const router = express.Router();
const webService = require('../services/webService');

router.get('/data', async (req, res) => {
  try {
    const result = await webService.getData();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/submit', async (req, res) => {
  try {
    const result = await webService.submitData(req.body);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;