const express = require('express');

const router = express.Router();
const access = require('../middlewares/projectAccess');
router.use(require('../middlewares/authMiddleware').verifyToken);

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
  access.createTask,
  taskController.createTask
);

// No generic edit route existed; use the existing task resource URL.
router.use('/:id', (req, res, next) => {
  if (req.params.id === 'users') return next();
  const manage = req.method !== 'GET' && (req.path === '/' || req.path === '/assign');
  return access.task(manage ? 'manage' : req.method === 'GET' ? 'read' : 'work')(req, res, next);
});
router.patch('/:id', taskController.updateTask);
router.put('/:id', taskController.updateTask);


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
