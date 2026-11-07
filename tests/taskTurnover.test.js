const test = require('node:test');
const assert = require('node:assert/strict');
const { syncProjectTurnoverTask } = require('../services/taskTurnoverService');

test('syncProjectTurnoverTask creates locked Turnover task when none exists', async () => {
  let inserted = null;
  const mockDb = {
    query: async (rawSql, params) => {
      const sql = rawSql.replace(/\s+/g, ' ');
      if (sql.includes('SELECT t.* FROM tasks t')) {
        return { rows: [] }; // No existing turnover task
      }
      if (sql.includes('INSERT INTO tasks')) {
        inserted = {
          id: 'mock-turnover-id',
          task_name: 'Turnover of the documents',
          phase: 'Turnover Phase',
          priority: 'High',
          status: 'Locked',
          subtasks: JSON.parse(params[0]),
          progress_pct: 0,
          project_id: params[1],
        };
        return { rows: [inserted] };
      }
      if (sql.includes('INSERT INTO task_phases')) {
        return { rows: [] };
      }
      if (sql.includes('SELECT id, status, progress_pct, subtasks FROM tasks')) {
        return {
          rows: [
            { id: 'other-1', status: 'In Progress', progress_pct: 50, subtasks: [] },
          ],
        };
      }
      return { rows: [] };
    },
  };

  const result = await syncProjectTurnoverTask('mock-project-id', mockDb);
  assert.equal(result.task_name, 'Turnover of the documents');
  assert.equal(result.phase, 'Turnover Phase');
  assert.equal(result.priority, 'High');
  assert.equal(result.status, 'Locked');
  assert.equal(result.subtasks.length, 1);
  assert.equal(result.subtasks[0].title, 'Turnover');
});

test('syncProjectTurnoverTask unlocks to Ongoing when all other tasks are completed', async () => {
  let updatedStatus = null;
  const mockDb = {
    query: async (rawSql, params) => {
      const sql = rawSql.replace(/\s+/g, ' ');
      if (sql.includes('SELECT t.* FROM tasks t')) {
        return {
          rows: [
            {
              id: 'mock-turnover-id',
              task_name: 'Turnover of the documents',
              phase: 'Turnover Phase',
              priority: 'High',
              status: 'Locked',
              subtasks: [{ id: 'sub-1', title: 'Turnover', completed: false }],
              progress_pct: 0,
            },
          ],
        };
      }
      if (sql.includes('SELECT id, status, progress_pct, subtasks FROM tasks')) {
        // All other tasks completed!
        return {
          rows: [
            { id: 'other-1', status: 'Completed', progress_pct: 100, subtasks: [] },
            { id: 'other-2', status: 'Done', progress_pct: 100, subtasks: [] },
          ],
        };
      }
      if (sql.includes('UPDATE tasks') && sql.includes("SET status = 'Ongoing'")) {
        updatedStatus = 'Ongoing';
        return { rows: [] };
      }
      return { rows: [] };
    },
  };

  const result = await syncProjectTurnoverTask('mock-project-id', mockDb);
  assert.ok(result);
  assert.equal(result.status, 'Ongoing');
  assert.equal(updatedStatus, 'Ongoing');
});

test('syncProjectTurnoverTask stays Locked if not all other tasks are completed', async () => {
  const mockDb = {
    query: async (rawSql, params) => {
      const sql = rawSql.replace(/\s+/g, ' ');
      if (sql.includes('SELECT t.* FROM tasks t')) {
        return {
          rows: [
            {
              id: 'mock-turnover-id',
              task_name: 'Turnover of the documents',
              phase: 'Turnover Phase',
              priority: 'High',
              status: 'Locked',
              subtasks: [{ id: 'sub-1', title: 'Turnover', completed: false }],
              progress_pct: 0,
            },
          ],
        };
      }
      if (sql.includes('SELECT id, status, progress_pct, subtasks FROM tasks')) {
        return {
          rows: [
            { id: 'other-1', status: 'Completed', progress_pct: 100, subtasks: [] },
            { id: 'other-2', status: 'Pending', progress_pct: 0, subtasks: [] },
          ],
        };
      }
      return { rows: [] };
    },
  };

  const result = await syncProjectTurnoverTask('mock-project-id', mockDb);
  assert.ok(result);
  assert.equal(result.status, 'Locked');
});

test('createTask rejects task creation when project is completed', async () => {
  const taskController = require('../controllers/taskController');
  let statusCode = null;
  let jsonResult = null;

  const req = {
    user: { id: 'admin-user-id' },
    body: {
      taskName: 'Late Task',
      phases: ['Turnover Phase'],
      assigneeId: 'eng-1',
      projectId: 'completed-proj-id',
      startDate: new Date().toISOString().split('T')[0],
      dueDate: new Date(Date.now() + 86400000).toISOString().split('T')[0],
      priority: 'High',
      materialsRequired: 'None',
      siteInstructions: 'Do not allow',
    },
  };
  const res = {
    status: (code) => {
      statusCode = code;
      return {
        json: (data) => {
          jsonResult = data;
        },
      };
    },
  };

  // Mock pool
  const pool = require('../db');
  const origConnect = pool.connect;
  pool.connect = async () => ({
    query: async (sql) => {
      if (sql.includes('current_database')) {
        return { rows: [{ current_database: 'test', current_schema: 'public', search_path: 'public' }] };
      }
      if (sql.includes('FROM projects p')) {
        return {
          rows: [
            {
              id: 'completed-proj-id',
              code: 'PRJ-DONE',
              name: 'Finished Project',
              status: 'Completed',
              owner_id: 'admin-user-id',
            },
          ],
        };
      }
      return { rows: [] };
    },
    release: () => {},
  });

  try {
    await taskController.createTask(req, res);
    assert.equal(statusCode, 400);
    assert.equal(jsonResult.success, false);
    assert.match(jsonResult.error, /Cannot add tasks to a completed project/i);
  } finally {
    pool.connect = origConnect;
  }
});
