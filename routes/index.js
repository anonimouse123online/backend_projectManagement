const express = require('express');
const router = express.Router();

const authRoutes      = require('./auth');
const dashboardRoutes = require('./dashboard');
const softwareRoutes  = require('./software');
const webRoutes       = require('./web');
const projectRoutes   = require('./project'); 
const resourceRoutes  = require("./resource"); 
const taskRoutes      = require('./task');
const userRoutes      = require('./user');        // ← ADD THIS

router.use('/auth',      authRoutes);
router.use('/dashboard', dashboardRoutes);
router.use('/software',  softwareRoutes);
router.use('/web',       webRoutes);
router.use('/projects',  projectRoutes); 
router.use("/resources", resourceRoutes); 
router.use('/tasks',     taskRoutes);
router.use('/users',     userRoutes);             // ← ADD THIS

module.exports = router;