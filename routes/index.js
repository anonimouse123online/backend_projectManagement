const express = require('express');

const router = express.Router();


// ============================================================
// ROUTES
// ============================================================

const authRoutes =
  require('./auth');

const dashboardRoutes =
  require('./dashboard');

const softwareRoutes =
  require('./software');

const webRoutes =
  require('./web');

const projectRoutes =
  require('./project');

const resourceRoutes =
  require('./resource');

const taskRoutes =
  require('./task');

const userRoutes =
  require('./user');

const reportRoutes =
  require('./routes_report');

const timelogRoutes =
  require('./timelog');

const issuesRoutes =
  require('./issuesRoutes');

const messageRoutes =
  require('./messageRoutes');

const notificationRoutes =
  require('./notificationRoutes');


// ============================================================
// PASSWORD RESET
// NEW
// ============================================================

const passwordResetRoutes =
  require('./passwordResetRoutes');


// ============================================================
// AUTH
// ============================================================

router.use(
  '/auth',
  authRoutes
);


// ============================================================
// PASSWORD RESET
//
// Creates:
//
// POST /auth/forgot-password
// POST /auth/verify-reset-code
// POST /auth/reset-password
// ============================================================

router.use(
  '/auth',
  passwordResetRoutes
);


// ============================================================
// DASHBOARD
// ============================================================

router.use(
  '/dashboard',
  dashboardRoutes
);


// ============================================================
// SOFTWARE
// ============================================================

router.use(
  '/software',
  softwareRoutes
);


// ============================================================
// WEB
// ============================================================

router.use(
  '/web',
  webRoutes
);


// ============================================================
// PROJECTS
// ============================================================

router.use(
  '/projects',
  projectRoutes
);


// ============================================================
// RESOURCES
// ============================================================

router.use(
  '/resources',
  resourceRoutes
);


// ============================================================
// TASKS
// ============================================================

router.use(
  '/tasks',
  taskRoutes
);


// ============================================================
// USERS
// ============================================================

router.use(
  '/users',
  userRoutes
);


// ============================================================
// REPORTS
// ============================================================

router.use(
  '/reports',
  reportRoutes
);


// ============================================================
// TIMELOGS
// ============================================================

router.use(
  '/timelogs',
  timelogRoutes
);


// ============================================================
// NOTIFICATIONS
// ============================================================

router.use(
  '/notifications',
  notificationRoutes
);


// ============================================================
// ISSUES
// ============================================================

router.use(
  '/',
  issuesRoutes
);


// ============================================================
// MESSAGES
// ============================================================

router.use(
  '/messages',
  messageRoutes
);


// ============================================================
// EXPORT ROUTER
// ============================================================

module.exports = router;