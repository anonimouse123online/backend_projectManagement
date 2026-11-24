const test = require('node:test');
const assert = require('node:assert/strict');
const pool = require('../db');

test('geofence isolation between distinct projects', async (t) => {
  // Query two real projects from DB
  const { rows: projects } = await pool.query(
    'SELECT id, code, name FROM projects ORDER BY created_at ASC LIMIT 2'
  );

  assert.ok(projects.length >= 2, 'Need at least 2 projects in the database');
  const projA = projects[0];
  const projB = projects[1];

  assert.notEqual(projA.id, projB.id);

  // Set distinct coordinates on Project A
  const latA = 9.8831000;
  const lngA = 123.6001000;
  const radA = 150.0;

  const latB = 10.3157000;
  const lngB = 123.8854000;
  const radB = 250.0;

  // Update Project A
  const updateA = await pool.query(
    `UPDATE projects
     SET geofence_latitude = $1,
         geofence_longitude = $2,
         geofence_radius = $3,
         geofence_enabled = true,
         updated_at = NOW()
     WHERE id = (
       SELECT id FROM projects
       WHERE id = $4::uuid
       LIMIT 1
     )
     RETURNING id, code, geofence_latitude, geofence_longitude, geofence_radius, geofence_enabled`,
    [latA, lngA, radA, projA.id]
  );
  assert.equal(updateA.rows.length, 1);
  assert.equal(updateA.rows[0].id, projA.id);

  // Update Project B with different coordinates
  const updateB = await pool.query(
    `UPDATE projects
     SET geofence_latitude = $1,
         geofence_longitude = $2,
         geofence_radius = $3,
         geofence_enabled = true,
         updated_at = NOW()
     WHERE id = (
       SELECT id FROM projects
       WHERE id = $4::uuid
       LIMIT 1
     )
     RETURNING id, code, geofence_latitude, geofence_longitude, geofence_radius, geofence_enabled`,
    [latB, lngB, radB, projB.id]
  );
  assert.equal(updateB.rows.length, 1);
  assert.equal(updateB.rows[0].id, projB.id);

  // Verify Project A still has its OWN coordinates and was NOT overwritten by Project B
  const checkA = await pool.query(
    'SELECT id, geofence_latitude, geofence_longitude, geofence_radius FROM projects WHERE id = $1',
    [projA.id]
  );
  const rowA = checkA.rows[0];
  assert.equal(parseFloat(rowA.geofence_latitude), latA, 'Project A latitude must not be overwritten');
  assert.equal(parseFloat(rowA.geofence_longitude), lngA, 'Project A longitude must not be overwritten');
  assert.equal(parseFloat(rowA.geofence_radius), radA, 'Project A radius must not be overwritten');

  // Verify Project B has its own coordinates
  const checkB = await pool.query(
    'SELECT id, geofence_latitude, geofence_longitude, geofence_radius FROM projects WHERE id = $1',
    [projB.id]
  );
  const rowB = checkB.rows[0];
  assert.equal(parseFloat(rowB.geofence_latitude), latB, 'Project B latitude must match latB');
  assert.equal(parseFloat(rowB.geofence_longitude), lngB, 'Project B longitude must match lngB');
  assert.equal(parseFloat(rowB.geofence_radius), radB, 'Project B radius must match radB');

  // Assert they are completely distinct
  assert.notEqual(rowA.geofence_latitude, rowB.geofence_latitude);
  assert.notEqual(rowA.geofence_longitude, rowB.geofence_longitude);

  await pool.end();
});
