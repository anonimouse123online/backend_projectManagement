const pool = require('../db');

exports.getResources = async (req, res) => {
  try {
    const { category, status, project, search } = req.query;
    const conditions = [];
    const params = [];

    if (category && category !== 'All Resources' && category !== 'All Categories') {
      params.push(category);
      conditions.push(`category ILIKE $${params.length}`);
    }

    if (status && status !== 'All' && status !== 'All Status') {
      params.push(status);
      conditions.push(`status ILIKE $${params.length}`);
    }

    if (project && project !== 'All Projects') {
      params.push(project);
      conditions.push(`project ILIKE $${params.length}`);
    }

    if (search) {
      params.push(`%${search}%`);
      conditions.push(`(name ILIKE $${params.length} OR supplier ILIKE $${params.length} OR project ILIKE $${params.length})`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const { rows } = await pool.query(
      `SELECT
         id, name, supplier, category,
         quantity, unit, min_threshold AS "minThreshold",
         unit_price AS "unitPrice", project,
         CASE
           WHEN quantity <= 0 THEN 'Out of stock'
           WHEN quantity <= min_threshold THEN 'Low stock'
           WHEN category = 'Equipment' THEN 'Available'
           ELSE 'In stock'
         END AS status,
         task_id AS "taskId", task_name AS "taskName",
         TO_CHAR(updated_at, 'Mon DD, YYYY') AS "updatedAt"
       FROM resources
       ${where}
       ORDER BY created_at DESC`,
      params
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('getResources error:', err);
    res.status(500).json({ error: 'Failed to fetch resources.' });
  }
};

exports.createResource = async (req, res) => {
  try {
    const { name, supplier, category, quantity, unit, minThreshold, unitPrice, project, taskId, taskName } = req.body;
    const targetTaskId = taskId && taskId !== 'none' && taskId !== '' ? taskId : null;
    let targetTaskName = taskName && taskName.trim() ? taskName.trim() : null;

    if (targetTaskId && !targetTaskName) {
      const tRow = await pool.query('SELECT task_name FROM tasks WHERE id::text = $1::text', [targetTaskId]);
      if (tRow.rows.length > 0) {
        targetTaskName = tRow.rows[0].task_name;
      }
    }

    const qtyNum = parseFloat(quantity) || 0;
    const threshNum = parseFloat(minThreshold) || 0;
    let computedStatus = 'In stock';
    if (qtyNum <= 0) {
      computedStatus = 'Out of stock';
    } else if (qtyNum <= threshNum) {
      computedStatus = 'Low stock';
    } else if (category === 'Equipment') {
      computedStatus = 'Available';
    } else {
      computedStatus = 'In stock';
    }

    const { rows } = await pool.query(
      `INSERT INTO resources (name, supplier, category, quantity, unit, min_threshold, unit_price, project, task_id, task_name, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING
         id, name, supplier, category,
         quantity, unit, min_threshold AS "minThreshold",
         unit_price AS "unitPrice", project, status,
         task_id AS "taskId", task_name AS "taskName",
         TO_CHAR(updated_at, 'Mon DD, YYYY') AS "updatedAt"`,
      [name, supplier, category, qtyNum, unit, threshNum, unitPrice, project, targetTaskId, targetTaskName, computedStatus]
    );

    // If assigned to a task, sync/append this material to the task's materials_required
    if (targetTaskId) {
      try {
        const taskRes = await pool.query('SELECT materials_required FROM tasks WHERE id::text = $1::text', [targetTaskId]);
        if (taskRes.rows.length > 0) {
          const currentMat = (taskRes.rows[0].materials_required || '').trim();
          const cleanItem = `${quantity} ${unit} ${name}`.trim();
          const isNone = !currentMat || currentMat.toLowerCase() === 'none' || currentMat.toLowerCase() === 'none specified' || currentMat.toLowerCase().includes('standard site material');
          const updatedMat = isNone ? cleanItem : `${currentMat}, ${cleanItem}`;
          await pool.query('UPDATE tasks SET materials_required = $1, updated_at = NOW() WHERE id::text = $2::text', [updatedMat, targetTaskId]);
        }
      } catch (syncErr) {
        console.warn('Warning syncing material to task:', syncErr.message);
      }
    }

    res.status(201).json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('createResource error:', err);
    res.status(500).json({ error: 'Failed to create resource.' });
  }
};

exports.updateResource = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, supplier, category, quantity, unit, minThreshold, unitPrice, project, taskId, taskName } = req.body;
    const targetTaskId = taskId && taskId !== 'none' && taskId !== '' ? taskId : null;
    const targetTaskName = taskName && taskName.trim() ? taskName.trim() : null;

    const qtyNum = parseFloat(quantity) || 0;
    const threshNum = parseFloat(minThreshold) || 0;
    let computedStatus = 'In stock';
    if (qtyNum <= 0) {
      computedStatus = 'Out of stock';
    } else if (qtyNum <= threshNum) {
      computedStatus = 'Low stock';
    } else if (category === 'Equipment') {
      computedStatus = 'Available';
    } else {
      computedStatus = 'In stock';
    }

    const { rows } = await pool.query(
      `UPDATE resources
       SET name=$1, supplier=$2, category=$3, quantity=$4, unit=$5,
           min_threshold=$6, unit_price=$7, project=$8, task_id=$9, task_name=$10, status=$11, updated_at=NOW()
       WHERE id::text = $12::text
       RETURNING
         id, name, supplier, category,
         quantity, unit, min_threshold AS "minThreshold",
         unit_price AS "unitPrice", project, status,
         task_id AS "taskId", task_name AS "taskName",
         TO_CHAR(updated_at, 'Mon DD, YYYY') AS "updatedAt"`,
      [name, supplier, category, qtyNum, unit, threshNum, unitPrice, project, targetTaskId, targetTaskName, computedStatus, id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Resource not found.' });
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('updateResource error:', err);
    res.status(500).json({ error: 'Failed to update resource.' });
  }
};

exports.deleteResource = async (req, res) => {
  try {
    const { id } = req.params;

    // 1. Fetch resource details before deleting to know what task/materials to clean
    const findRes = await pool.query(
      'SELECT id, name, task_id, project FROM resources WHERE id::text = $1::text',
      [id]
    );
    if (!findRes.rows.length) return res.status(404).json({ error: 'Resource not found.' });

    const resource = findRes.rows[0];
    const resourceName = (resource.name || '').trim();

    // 2. Delete the resource from the resources table
    await pool.query('DELETE FROM resources WHERE id::text = $1::text', [id]);

    // 3. Clean up the deleted resource from tasks.materials_required
    if (resourceName) {
      try {
        let taskQuery = `
          SELECT t.id, t.materials_required
          FROM tasks t
          WHERE t.materials_required ILIKE $1
        `;
        const queryParams = [`%${resourceName}%`];

        if (resource.task_id) {
          taskQuery = `
            SELECT t.id, t.materials_required
            FROM tasks t
            WHERE t.id::text = $2::text OR (t.materials_required ILIKE $1)
          `;
          queryParams.push(resource.task_id);
        }

        const tRes = await pool.query(taskQuery, queryParams);

        for (const task of tRes.rows) {
          const rawMats = (task.materials_required || '').split(',');
          const target = resourceName.toLowerCase();
          const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const endRegex = new RegExp('(?:^|\\s)' + escaped + '$', 'i');

          const filtered = rawMats
            .map(m => m.trim())
            .filter(m => {
              if (!m) return false;
              const cleanM = m.replace(/\s*\([^)]*\)/g, '').trim().toLowerCase();
              const itemWithoutQty = cleanM.replace(/^[\d.,\s]+(?:bags?|pcs?|units?|kg|tons?|sets?|cu\.?m|meters?|boxes?|liters?|rolls?|sheets?|pairs?|items?|lengths?)?\s*/i, '').trim();
              const isMatch = itemWithoutQty === target || cleanM === target || endRegex.test(cleanM);
              return !isMatch;
            });

          const newMaterialsStr = filtered.length > 0 ? filtered.join(', ') : 'None specified';
          await pool.query(
            'UPDATE tasks SET materials_required = $1, updated_at = NOW() WHERE id::text = $2::text',
            [newMaterialsStr, task.id]
          );
        }
      } catch (cleanErr) {
        console.warn('Warning cleaning up task materials on resource delete:', cleanErr.message);
      }
    }

    res.json({ success: true });
  } catch (err) {
    console.error('deleteResource error:', err);
    res.status(500).json({ error: 'Failed to delete resource.' });
  }
};