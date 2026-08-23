const express = require('express');

const router = express.Router();

const {
  getNotifications,
  createNotification
} = require('../controllers/notificationController');


// GET /notifications
router.get(
  '/',
  getNotifications
);


// POST /notifications
router.post(
  '/',
  createNotification
);


module.exports = router;