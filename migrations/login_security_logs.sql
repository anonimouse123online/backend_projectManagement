CREATE TABLE IF NOT EXISTS login_security_logs (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  user_name VARCHAR(255),
  email VARCHAR(255) NOT NULL,
  role VARCHAR(50),
  event_type VARCHAR(30) NOT NULL CHECK (event_type IN ('LOGIN_SUCCESS', 'LOGIN_FAILED', 'LOGOUT')),
  login_status VARCHAR(20) NOT NULL CHECK (login_status IN ('SUCCESS', 'FAILED')),
  ip_address INET,
  latitude NUMERIC(9,6) CHECK (latitude BETWEEN -90 AND 90),
  longitude NUMERIC(9,6) CHECK (longitude BETWEEN -180 AND 180),
  location_accuracy NUMERIC CHECK (location_accuracy BETWEEN 0 AND 1000000000),
  location_permission_status VARCHAR(20) CHECK (location_permission_status IN ('GRANTED', 'DENIED', 'UNAVAILABLE', 'TIMEOUT')),
  user_agent TEXT,
  platform VARCHAR(100),
  language VARCHAR(35),
  security_status VARCHAR(20) NOT NULL CHECK (security_status IN ('NORMAL', 'SUSPICIOUS', 'NEEDS_REVIEW')),
  security_flag BOOLEAN NOT NULL DEFAULT FALSE,
  security_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((latitude IS NULL) = (longitude IS NULL)),
  CHECK ((latitude IS NULL AND location_accuracy IS NULL) OR location_permission_status IS NOT DISTINCT FROM 'GRANTED'),
  CHECK (location_accuracy IS NULL OR latitude IS NOT NULL),
  CHECK (security_flag = (security_status <> 'NORMAL')),
  CHECK ((event_type = 'LOGIN_FAILED' AND login_status = 'FAILED') OR (event_type <> 'LOGIN_FAILED' AND login_status = 'SUCCESS'))
);

CREATE INDEX IF NOT EXISTS idx_login_security_created ON login_security_logs (created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_login_security_user ON login_security_logs (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_login_security_email_failed ON login_security_logs (email, created_at DESC) WHERE event_type = 'LOGIN_FAILED';
CREATE INDEX IF NOT EXISTS idx_login_security_status ON login_security_logs (security_status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_login_security_success ON login_security_logs (user_id, created_at DESC) WHERE event_type = 'LOGIN_SUCCESS';
