const cron = require('node-cron');
const pool = require('../db');
const access = require('./projectAccessService');
const { generateAIReport } = require('./aiService');
const { imagesForReport } = require('./reportImageService');

/**
 * Runs every day at 6:00 PM.
 * Finds all tasks with pending images and generates their reports.
 */
const startScheduler = () => {
  // Cron: 0 18 * * * = every day at 6:00 PM
  cron.schedule('0 18 * * *', async () => {
    console.log('🕕 [Scheduler] Running end-of-day report generation...');
    await processPendingReports();
  });

  console.log('✅ [Scheduler] End-of-day report scheduler started (runs at 6:00 PM daily).');
};

/**
 * Finds all task_images rows with status = 'pending' for today
 * and triggers AI report generation for each.
 */
const processPendingReports = async (userId = null) => {
  const date = new Date().toISOString().split('T')[0];

  try {
    // Get all pending image batches for today
    const { rows } = await pool.query(
      `SELECT
         ti.task_id,
         ti.image_paths,
         t.task_name,
         t.site_instructions,
         p.name     AS project_name,
         u.full_name AS assignee
       FROM task_images ti
       JOIN tasks    t ON t.id = ti.task_id
       LEFT JOIN projects p ON p.id = t.project_id
       LEFT JOIN users    u ON u.id = t.assignee_id
       WHERE ti.upload_date = $1
         AND ti.status = 'pending'
         ${userId ? `AND ${access.projectScope('p', 2)}` : ''}`,
      userId ? [date, userId] : [date]
    );

    if (rows.length === 0) {
      console.log(`[Scheduler] No pending images for ${date}.`);
      return;
    }

    console.log(`[Scheduler] Found ${rows.length} task(s) to process for ${date}.`);

    for (const row of rows) {
      await processOneTask({ row, date });
    }

    console.log('[Scheduler] ✅ All tasks processed.');
  } catch (err) {
    console.error('[Scheduler] ❌ Error during batch processing:', err.message);
  }
};

/**
 * Processes a single task: calls AI service, saves report, updates image status.
 */
const processOneTask = async ({ row, date }) => {
  const { task_id, image_paths, task_name, project_name, assignee } = row;

  console.log(`[Scheduler] Processing task: ${task_name} (${task_id})`);

  try {
    const { report, observations, imagePaths } = await generateAIReport({
      task:       { task_name, project_name, assignee },
      taskId:     task_id,
      date,
      imagePaths: image_paths,
    });

    // Save report to DB
    await pool.query(
      `INSERT INTO reports (task_id, report_date, observations, report_text, status, image_paths)
       VALUES ($1, $2, $3, $4, 'completed', $5::jsonb)
       ON CONFLICT (task_id, report_date)
       DO UPDATE SET
         observations = $3,
         report_text  = $4,
         status       = 'completed',
         image_paths  = $5::jsonb`,
      [task_id, date, JSON.stringify(observations), report,
        JSON.stringify(imagesForReport(imagePaths, task_id).map(image => image.url))]
    );

    // Mark images as processed
    await pool.query(
      `UPDATE task_images SET status = 'processed'
       WHERE task_id = $1 AND upload_date = $2`,
      [task_id, date]
    );

    console.log(`[Scheduler] ✅ Report saved for: ${task_name}`);
  } catch (err) {
    console.error(`[Scheduler] ❌ Failed for task ${task_name}:`, err.message);

    // Mark as failed so we can retry or investigate
    await pool.query(
      `UPDATE task_images SET status = 'failed'
       WHERE task_id = $1 AND upload_date = $2`,
      [task_id, date]
    );
  }
};

module.exports = { startScheduler, processPendingReports };
