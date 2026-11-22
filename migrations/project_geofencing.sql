-- Add geofencing fields to projects table
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS geofence_latitude NUMERIC(10, 7),
  ADD COLUMN IF NOT EXISTS geofence_longitude NUMERIC(10, 7),
  ADD COLUMN IF NOT EXISTS geofence_radius NUMERIC(10, 2) DEFAULT 200.0,
  ADD COLUMN IF NOT EXISTS geofence_enabled BOOLEAN DEFAULT FALSE;

COMMENT ON COLUMN projects.geofence_latitude IS 'Geofence center latitude for site verification';
COMMENT ON COLUMN projects.geofence_longitude IS 'Geofence center longitude for site verification';
COMMENT ON COLUMN projects.geofence_radius IS 'Geofence radius in meters';
COMMENT ON COLUMN projects.geofence_enabled IS 'Whether geofencing restriction and verification is enabled for this project';
