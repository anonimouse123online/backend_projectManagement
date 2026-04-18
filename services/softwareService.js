const pool = require('../db');

const softwareService = {

  // ─── EXISTING ───────────────────────────────────────────
  async getStatus() {
    return { status: 'connected', version: '1.0.0' };
  },

  async syncData(payload) {
    return { synced: true, payload };
  },

  // ─── GET ALL ─────────────────────────────────────────────
  async getAllSoftware() {
    const result = await pool.query(
      `SELECT s.*, p.name AS project_name
       FROM software s
       LEFT JOIN projects p ON s.project_id = p.id
       ORDER BY s.created_at DESC`
    );
    return result.rows;
  },

  // ─── GET BY ID ───────────────────────────────────────────
  async getSoftwareById(id) {
    const result = await pool.query(
      `SELECT s.*, p.name AS project_name
       FROM software s
       LEFT JOIN projects p ON s.project_id = p.id
       WHERE s.id = $1`,
      [id]
    );
    return result.rows[0] ?? null;
  },

  // ─── GET BY PROJECT ──────────────────────────────────────
  async getSoftwareByProject(projectId) {
    const result = await pool.query(
      `SELECT * FROM software
       WHERE project_id = $1
       ORDER BY created_at DESC`,
      [projectId]
    );
    return result.rows;
  },

  // ─── CREATE ──────────────────────────────────────────────
  async createSoftware({ name, version, description, license_key, status, project_id }) {
    const result = await pool.query(
      `INSERT INTO software (name, version, description, license_key, status, project_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       RETURNING *`,
      [name, version, description, license_key, status, project_id]
    );
    return result.rows[0];
  },

  // ─── UPDATE ──────────────────────────────────────────────
  async updateSoftware(id, fields) {
    const allowed = ['name', 'version', 'description', 'license_key', 'status', 'project_id'];
    const keys = Object.keys(fields).filter(k => allowed.includes(k));
    if (keys.length === 0) return null;

    const setClauses = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
    const values = [...keys.map(k => fields[k]), id];

    const result = await pool.query(
      `UPDATE software
       SET ${setClauses}, updated_at = NOW()
       WHERE id = $${values.length}
       RETURNING *`,
      values
    );
    return result.rows[0] ?? null;
  },

  // ─── DELETE ──────────────────────────────────────────────
  async deleteSoftware(id) {
    const result = await pool.query(
      `DELETE FROM software WHERE id = $1 RETURNING id`,
      [id]
    );
    return result.rows[0] ?? null;
  },
};

module.exports = softwareService;