-- Migration: Add project type, construction method, and schedule risk level
-- Purpose: Timeline Feasibility Validation for construction projects
-- Date: 2026-10-29

ALTER TABLE projects
ADD COLUMN IF NOT EXISTS project_type VARCHAR(50) DEFAULT NULL,
ADD COLUMN IF NOT EXISTS construction_method VARCHAR(50) DEFAULT NULL,
ADD COLUMN IF NOT EXISTS schedule_risk_level VARCHAR(20) DEFAULT NULL;

COMMENT ON COLUMN projects.project_type IS 'Classification: residential, commercial, road_civil, interior_fitout, minor_repairs';
COMMENT ON COLUMN projects.construction_method IS 'Method: traditional, modular_prefab, renovation';
COMMENT ON COLUMN projects.schedule_risk_level IS 'Risk level: low, moderate, high, critical';
