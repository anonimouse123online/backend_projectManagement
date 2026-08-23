const express = require('express');

const router = express.Router();

const authRoutes = require('./auth');
const dashboardRoutes = require('./dashboard');
const softwareRoutes = require('./software');
const webRoutes = require('./web');
const projectRoutes = require('./project');
const resourceRoutes = require('./resource');
const taskRoutes = require('./task');
const userRoutes = require('./user');
const reportRoutes = require('./routes_report');
const timelogRoutes = require('./timelog');
const issuesRoutes = require('./issuesRoutes');
const messageRoutes = require('./messageRoutes');

// NEW
const notificationRoutes = require('./notificationRoutes');


router.use('/auth', authRoutes);

router.use('/dashboard', dashboardRoutes);

router.use('/software', softwareRoutes);

router.use('/web', webRoutes);

router.use('/projects', projectRoutes);

router.use('/resources', resourceRoutes);

router.use('/tasks', taskRoutes);

router.use('/users', userRoutes);

router.use('/reports', reportRoutes);

router.use('/timelogs', timelogRoutes);


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

router.use('/', issuesRoutes);


// ============================================================
// MESSAGES
// ============================================================

router.use(
  '/messages',
  messageRoutes
);


module.exports = router;