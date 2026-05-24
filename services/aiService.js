    const fs   = require('fs');
    const path = require('path');

    const AI_SERVICE_URL = process.env.AI_SERVICE_URL || 'http://localhost:8000';

    /**
     * Sends task images to the Python AI service as base64 JSON.
     * Avoids multipart/form-data boundary issues entirely.
     *
     * @param {Object}   task       - { task_name, project_name, assignee }
     * @param {string}   taskId
     * @param {string}   date       - YYYY-MM-DD
     * @param {string[]} imagePaths - Absolute file paths
     * @returns {Promise<{ report: string, observations: Array }>}
     */
    const generateAIReport = async ({ task, taskId, date, imagePaths }) => {

    // ── Debug: log what we received ───────────────────────────────────────────
    console.log('[AI] generateAIReport called with:');
    console.log('  taskId:     ', taskId);
    console.log('  task_name:  ', task?.task_name);
    console.log('  project:    ', task?.project_name);
    console.log('  assignee:   ', task?.assignee);
    console.log('  date:       ', date);
    console.log('  imagePaths: ', imagePaths);
    console.log('  type:       ', typeof imagePaths);
    console.log('  isArray:    ', Array.isArray(imagePaths));
    console.log('  length:     ', imagePaths?.length);

    // ── Convert images to base64 strings ──────────────────────────────────────
    const base64Images = [];
    for (const imgPath of imagePaths) {
        console.log(`[AI] Checking path: ${imgPath}`);
        if (fs.existsSync(imgPath)) {
        const buffer = fs.readFileSync(imgPath);
        base64Images.push(buffer.toString('base64'));
        console.log(`[AI] ✅ Loaded image: ${path.basename(imgPath)} (${buffer.length} bytes)`);
        } else {
        console.warn(`[AI] ⚠️  Image not found on disk: ${imgPath}`);
        }
    }

    if (base64Images.length === 0) {
        throw new Error('No valid image files found to send to AI service.');
    }

    // ── Debug: log the request payload (without full base64) ─────────────────
    const requestPayload = {
        task_id:     taskId,
        task_name:   task.task_name,
        location:    task.project_name || 'N/A',
        assigned_to: task.assignee     || 'N/A',
        date:        date,
        images:      base64Images,
    };

    console.log('[AI] Sending JSON payload to FastAPI:');
    console.log('  task_id:     ', requestPayload.task_id);
    console.log('  task_name:   ', requestPayload.task_name);
    console.log('  location:    ', requestPayload.location);
    console.log('  assigned_to: ', requestPayload.assigned_to);
    console.log('  date:        ', requestPayload.date);
    console.log('  images count:', requestPayload.images.length);
    console.log('  first image size (chars):', requestPayload.images[0]?.length);
    console.log(`[AI] Sending ${base64Images.length} image(s) to FastAPI as JSON...`);

    const response = await fetch(`${AI_SERVICE_URL}/generate-report`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(requestPayload),
    });

    console.log('[AI] FastAPI response status:', response.status);

    if (!response.ok) {
        const errText = await response.text();
        console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.error('[AI] ❌ FastAPI returned', response.status);
        console.error('[AI] Error body:', errText);
        console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        throw new Error(`AI service error (${response.status}): ${errText}`);
    }

    const result = await response.json();
    console.log('[AI] ✅ Report received from FastAPI');

    return {
        report:       result.report,
        observations: result.observations,
    };
    };

    /**
     * Health check — confirms the Python AI service is reachable.
     * @returns {Promise<boolean>}
     */
    const checkAIServiceHealth = async () => {
    try {
        const response = await fetch(`${AI_SERVICE_URL}/health`, {
        signal: AbortSignal.timeout(5000),
        });
        return response.ok;
    } catch {
        return false;
    }
    };

    module.exports = { generateAIReport, checkAIServiceHealth };