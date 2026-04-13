const pool = require('../db');

exports.getResources = async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT
         id, name, supplier, category,
         quantity, unit, min_threshold AS "minThreshold",
         unit_price AS "unitPrice", project, status,
         TO_CHAR(updated_at, 'Mon DD, YYYY') AS "updatedAt"
       FROM resources
       ORDER BY created_at DESC`
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('getResources error:', err);
    res.status(500).json({ error: 'Failed to fetch resources.' });
  }
};

exports.createResource = async (req, res) => {
  try {
    const { name, supplier, category, quantity, unit, minThreshold, unitPrice, project } = req.body;
    const { rows } = await pool.query(
      `INSERT INTO resources (name, supplier, category, quantity, unit, min_threshold, unit_price, project)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING
         id, name, supplier, category,
         quantity, unit, min_threshold AS "minThreshold",
         unit_price AS "unitPrice", project, status,
         TO_CHAR(updated_at, 'Mon DD, YYYY') AS "updatedAt"`,
      [name, supplier, category, quantity, unit, minThreshold, unitPrice, project]
    );
    res.status(201).json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('createResource error:', err);
    res.status(500).json({ error: 'Failed to create resource.' });
  }
};

exports.updateResource = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, supplier, category, quantity, unit, minThreshold, unitPrice, project } = req.body;
    const { rows } = await pool.query(
      `UPDATE resources
       SET name=$1, supplier=$2, category=$3, quantity=$4, unit=$5,
           min_threshold=$6, unit_price=$7, project=$8, updated_at=NOW()
       WHERE id=$9
       RETURNING
         id, name, supplier, category,
         quantity, unit, min_threshold AS "minThreshold",
         unit_price AS "unitPrice", project, status,
         TO_CHAR(updated_at, 'Mon DD, YYYY') AS "updatedAt"`,
      [name, supplier, category, quantity, unit, minThreshold, unitPrice, project, id]
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
    const { rowCount } = await pool.query('DELETE FROM resources WHERE id=$1', [id]);
    if (!rowCount) return res.status(404).json({ error: 'Resource not found.' });
    res.json({ success: true });
  } catch (err) {
    console.error('deleteResource error:', err);
    res.status(500).json({ error: 'Failed to delete resource.' });
  }
};