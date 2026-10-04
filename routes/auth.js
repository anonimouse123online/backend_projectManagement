const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const authController = require('../controllers/authController');
const { verifyToken } = require('../middlewares/authMiddleware');
const loginSecurityController = require('../controllers/loginSecurityController');

// Brute-force protection specifically for login and signup attempts
const loginSignupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 25, // 25 attempts per 15 minutes per IP
  message: { error: 'Too many login attempts. Please try again after 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

router.post('/send-verification-code', loginSignupLimiter, authController.sendVerificationCode);
router.post('/signup', loginSignupLimiter, authController.signup);
router.post('/verify-email', loginSignupLimiter, authController.verifyEmail);
router.post('/resend-verification', loginSignupLimiter, authController.resendVerification);
router.post('/login', loginSignupLimiter, authController.login);
router.post('/logout', verifyToken, loginSecurityController.requireActiveSecurityUser, loginSecurityController.logout);
router.get('/me', verifyToken, authController.getMe);
router.patch('/profile', verifyToken, authController.updateProfile);
router.patch('/change-password', verifyToken, authController.changePassword);
router.get('/system-health', verifyToken, authController.getSystemHealth);
router.get('/dashboard', authController.getDashboard);

module.exports = router;
