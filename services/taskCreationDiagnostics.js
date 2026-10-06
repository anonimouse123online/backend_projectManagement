const { randomUUID } = require('node:crypto');

function labelOf(sql) {
  const statement = sql.replace(/\s+/g, ' ').trim();
  if (/^SELECT current_database\(/i.test(statement)) return 'inspecting database connection';
  if (/pg_attribute/i.test(statement)) return 'inspecting resources.status generation';
  if (/^BEGIN$/i.test(statement)) return 'beginning transaction';
  if (/^COMMIT$/i.test(statement)) return 'committing transaction';
  if (/^ROLLBACK$/i.test(statement)) return 'rolling back transaction';
  if (/^INSERT INTO tasks\b/i.test(statement)) return 'inserting task (including embedded subtasks)';
  if (/^INSERT INTO task_phases\b/i.test(statement)) return 'inserting task phases';
  if (/^DELETE FROM task_phases\b/i.test(statement)) return 'removing previous task phase relations';
  if (/^INSERT INTO resources\b/i.test(statement)) return 'inserting materials/resources';
  if (/^UPDATE resources\b/i.test(statement)) return 'updating materials/resources';
  if (/^UPDATE projects\b/i.test(statement)) return 'synchronizing project progress/status';
  if (/FROM resources\b/i.test(statement)) return 'looking up materials/resources';
  if (/FROM users\b/i.test(statement)) return 'looking up assignee';
  if (/FROM project_members\b/i.test(statement) && !/FROM projects\b/i.test(statement)) return 'checking assignee membership';
  if (/FROM projects\b/i.test(statement)) return 'checking project access and dates';
  if (/FROM task_phases\b/i.test(statement)) return 'loading created task phases';
  if (/FROM tasks\b/i.test(statement)) return 'reading tasks for project progress';
  return statement.split(' ')[0].toLowerCase() + ' database operation';
}

function createTaskDiagnostics() {
  const requestId = randomUUID();
  let failed;
  return {
    requestId,
    wrap(db) {
      return {
        async query(sql, values) {
          const statement = typeof sql === 'string' ? sql : sql.text;
          const operation = labelOf(statement);
          console.log(`[CREATE TASK] ${operation}`, { request_id: requestId });
          try { return await db.query(sql, values); }
          catch (error) {
            // Keep the original failed statement even if ROLLBACK also fails.
            failed ||= { operation, sql: statement };
            throw error;
          }
        },
      };
    },
    logError(err) {
      console.error({
        request_id: requestId, operation: failed?.operation, sql: failed?.sql,
        message: err.message, code: err.code, table: err.table, schema: err.schema,
        column: err.column, constraint: err.constraint, detail: err.detail,
        where: err.where, routine: err.routine,
      });
    },
  };
}

module.exports = { createTaskDiagnostics };
