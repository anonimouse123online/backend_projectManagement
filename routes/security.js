const express = require('express');
const { verifyToken, requireAdmin } = require('../middlewares/authMiddleware');
const controller = require('../controllers/loginSecurityController');

const router = express.Router();
router.use(verifyToken, requireAdmin, controller.requireActiveSecurityUser, controller.requireCurrentAdmin);
router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
router.get('/login-logs', controller.getLoginSecurityLogs);
router.get('/login-logs/:id', controller.getLoginSecurityLog);

module.exports = router;
