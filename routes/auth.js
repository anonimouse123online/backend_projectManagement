const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const authController = require('../controllers/authController');
const { verifyToken } = require('../middlewares/authMiddleware');

// Brute-force protection specifically for login and signup attempts
const loginSignupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 25, // 25 attempts per 15 minutes per IP
  message: { error: 'Too many login attempts. Please try again after 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

router.post('/signup', loginSignupLimiter, authController.signup);
router.post('/login', loginSignupLimiter, authController.login);
router.get('/me', verifyToken, authController.getMe);
router.patch('/profile', verifyToken, authController.updateProfile);
router.patch('/change-password', verifyToken, authController.changePassword);
router.get('/system-health', verifyToken, authController.getSystemHealth);
router.get('/dashboard', authController.getDashboard);

module.exports = router;