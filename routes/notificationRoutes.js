const express = require('express');

const router = express.Router();
router.use(require('../middlewares/authMiddleware').verifyToken);

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