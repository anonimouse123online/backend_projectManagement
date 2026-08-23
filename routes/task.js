const express = require('express');

const router = express.Router();

const taskController =
  require('../controllers/taskController');


// ============================================================
// TASK LIST / USERS
// ============================================================

router.get(
  '/',
  taskController.getTasks
);

router.get(
  '/users',
  taskController.getUsers
);


// ============================================================
// CREATE TASK
// ============================================================

router.post(
  '/',
  taskController.createTask
);


// ============================================================
// TASK ACTIONS
// ============================================================

router.patch(
  '/:id/status',
  taskController.updateTaskStatus
);

router.patch(
  '/:id/subtasks',
  taskController.updateTaskSubtasks
);

router.patch(
  '/:id/assign',
  taskController.assignTask
);


// ============================================================
// COMPLETE TASK
// PATCH /tasks/:id/complete
// ============================================================

router.patch(
  '/:id/complete',
  taskController.completeTask
);


// ============================================================
// ENGINEER REPORT UPLOAD
// POST /tasks/:id/reports
// ============================================================

router.post(
  '/:id/reports',
  taskController.uploadTaskReport
);


// ============================================================
// TASK IMAGES
// ============================================================

router.post(
  '/:id/images',
  function(req, res, next) {

    taskController.upload.array(
      'images',
      20
    )(
      req,
      res,
      function(err) {

        if (err) {

          console.error(
            'Multer error:',
            err.message
          );

          return res.status(400).json({
            error: err.message
          });
        }

        next();
      }
    );
  },
  taskController.uploadTaskImages
);


router.get(
  '/:id/images',
  taskController.getTaskImages
);


// ============================================================
// TASK REPORT / AI
// ============================================================

router.get(
  '/:id/report',
  taskController.getTaskReport
);

router.post(
  '/:id/generate-report',
  taskController.generateReportNow
);


// ============================================================
// GET SINGLE TASK
// Keep this near the bottom because it is generic.
// ============================================================

router.get(
  '/:id',
  taskController.getTaskById
);


module.exports = router;