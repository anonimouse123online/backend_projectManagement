const access = require('../services/projectAccessService');

const guard = handler => async (req, res, next) => {
  if (!req.user?.id) return res.status(401).json({ error: 'Authentication required.' });
  try { await handler(req); next(); }
  catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    next(error);
  }
};

const project = (manage = false) => guard(async req => {
  req.project = await access.getProject(req.params.code || req.params.projectId, req.user);
  if (manage === 'work') require('../services/projectIssueService').requireWrite(req.project, req.user);
  else if (manage) access.requireManage(req.project, req.user);
});

const task = (mode = 'read') => guard(async req => {
  req.task = await access.getTask(req.params.id || req.params.taskId, req.user);
  if (mode === 'manage') access.requireManage(req.task.project, req.user);
  if (mode === 'work' && req.task.project.owner_id !== req.user.id && req.task.assignee_id !== req.user.id) {
    access.requireManage(req.task.project, req.user);
  }
});

const createTask = guard(async req => {
  const body = req.body || {};
  const project = await access.getProject(body.project_id || body.projectId || body.project, req.user);
  access.requireManage(project, req.user);
});

module.exports = { guard, project, task, createTask };
