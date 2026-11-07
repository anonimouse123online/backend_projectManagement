const crypto = require('crypto');
const pool = require('../db');

/**
 * Ensures the project has the "Turnover of the documents" task in "Turnover Phase",
 * and evaluates whether it should be "Locked" or "Ongoing".
 *
 * Rules:
 * - Title: "Turnover of the documents"
 * - Subtask: [{ id: uuid, title: "Turnover", completed: false, status: "pending" }]
 * - Priority: "High"
 * - Status: "Locked" initially.
 * - Automatically unlocks to "Ongoing" when all other tasks of that project are Completed!
 * - Re-locks to "Locked" if other tasks are no longer all completed (and turnover hasn't been completed).
 */
async function syncProjectTurnoverTask(projectId, db = pool) {
  if (!projectId) return null;

  try {
    // 1. Find existing turnover task for this project
    let turnoverRes = await db.query(
      `SELECT t.*
       FROM tasks t
       WHERE t.project_id = $1::uuid
         AND (
           LOWER(TRIM(t.task_name)) = 'turnover of the documents'
           OR LOWER(TRIM(COALESCE(t.phase, ''))) = 'turnover phase'
           OR EXISTS (
             SELECT 1 FROM task_phases tp
             WHERE tp.task_id = t.id AND LOWER(TRIM(tp.phase)) = 'turnover phase'
           )
         )
       LIMIT 1`,
      [projectId]
    );

    let turnoverTask = turnoverRes.rows[0];

    // If it doesn't exist, create it!
    if (!turnoverTask) {
      const subtasks = [
        {
          id: crypto.randomUUID(),
          title: 'Turnover',
          completed: false,
          status: 'pending',
          progress: 0,
        },
      ];

      const insertRes = await db.query(
        `INSERT INTO tasks (
           id,
           task_name,
           phase,
           priority,
           status,
           subtasks,
           progress_pct,
           project_id,
           created_at,
           updated_at
         ) VALUES (
           gen_random_uuid(),
           'Turnover of the documents',
           'Turnover Phase',
           'High',
           'Locked',
           $1::jsonb,
           0,
           $2::uuid,
           NOW(),
           NOW()
         )
         RETURNING *`,
        [JSON.stringify(subtasks), projectId]
      );

      turnoverTask = insertRes.rows[0];

      await db.query(
        `INSERT INTO task_phases (task_id, phase)
         VALUES ($1::uuid, 'Turnover Phase')
         ON CONFLICT DO NOTHING`,
        [turnoverTask.id]
      );
    } else {
      // Ensure it has the Turnover subtask if empty
      const currentSubs = Array.isArray(turnoverTask.subtasks) ? turnoverTask.subtasks : [];
      if (currentSubs.length === 0) {
        const subtasks = [
          {
            id: crypto.randomUUID(),
            title: 'Turnover',
            completed: false,
            status: 'pending',
            progress: 0,
          },
        ];
        await db.query(
          `UPDATE tasks
           SET subtasks = $1::jsonb, updated_at = NOW()
           WHERE id = $2::uuid`,
          [JSON.stringify(subtasks), turnoverTask.id]
        );
        turnoverTask.subtasks = subtasks;
      }
    }

    // 2. Check all other tasks of this project
    const otherTasksRes = await db.query(
      `SELECT id, status, progress_pct, subtasks
       FROM tasks
       WHERE project_id = $1::uuid
         AND id <> $2::uuid`,
      [projectId, turnoverTask.id]
    );

    const otherTasks = otherTasksRes.rows;

    const isTaskDone = (t) => {
      const s = (t.status || '').trim().toLowerCase();
      if (['completed', 'done', 'approved', 'verified', 'closed', 'finished'].includes(s)) {
        return true;
      }
      if (Number(t.progress_pct) >= 100) {
        return true;
      }
      const subs = Array.isArray(t.subtasks) ? t.subtasks : [];
      if (subs.length > 0 && subs.every(st => Boolean(st && (st.completed || ['completed', 'done'].includes((st.status || '').toLowerCase()) || Number(st.progress ?? st.progress_pct) >= 100)))) {
        return true;
      }
      return false;
    };

    const allOtherCompleted = otherTasks.length > 0 && otherTasks.every(isTaskDone);

    const currentTurnoverStatus = (turnoverTask.status || '').trim().toLowerCase();
    const isTurnoverFinished = ['completed', 'done', 'approved', 'verified', 'closed'].includes(currentTurnoverStatus)
      || Number(turnoverTask.progress_pct) >= 100;

    if (!isTurnoverFinished) {
      if (allOtherCompleted) {
        // Unlock to Ongoing!
        if (currentTurnoverStatus === 'locked' || currentTurnoverStatus === 'pending') {
          await db.query(
            `UPDATE tasks
             SET status = 'Ongoing', updated_at = NOW()
             WHERE id = $1::uuid`,
            [turnoverTask.id]
          );
          turnoverTask.status = 'Ongoing';
        }
      } else {
        // Keep or lock back to Locked
        if (currentTurnoverStatus !== 'locked') {
          const subs = Array.isArray(turnoverTask.subtasks) ? turnoverTask.subtasks : [];
          const anySubDone = subs.some(st => st.completed || ['completed', 'done'].includes((st.status || '').toLowerCase()));
          if (!anySubDone && (Number(turnoverTask.progress_pct) || 0) === 0) {
            await db.query(
              `UPDATE tasks
               SET status = 'Locked', updated_at = NOW()
               WHERE id = $1::uuid`,
              [turnoverTask.id]
            );
            turnoverTask.status = 'Locked';
          }
        }
      }
    }

    return turnoverTask;
  } catch (err) {
    console.error('syncProjectTurnoverTask error:', err.message);
    return null;
  }
}

/**
 * Ensures all projects in the database have their Turnover task created and synced.
 */
async function syncAllProjectsTurnoverTasks(db = pool) {
  try {
    const projects = await db.query('SELECT id, code FROM projects');
    for (const p of projects.rows) {
      await syncProjectTurnoverTask(p.id, db);
    }
  } catch (err) {
    console.error('syncAllProjectsTurnoverTasks error:', err.message);
  }
}

module.exports = {
  syncProjectTurnoverTask,
  syncAllProjectsTurnoverTasks,
};

