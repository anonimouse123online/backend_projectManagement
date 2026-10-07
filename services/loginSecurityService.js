const pool = require('../db');
const { getClientIp } = require('./loginSecurityContext');

function distanceKm(a, b) {
  const radians = degrees => degrees * Math.PI / 180;
  const dLat = radians(b.latitude - a.latitude);
  const dLon = radians(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(radians(a.latitude)) *
    Math.cos(radians(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(Math.min(1, h)));
}

function evaluateSecurity({ eventType, context, history, previousLocation, now }) {
  if (eventType === 'LOGOUT') {
    return { security_status: 'NORMAL', security_flag: false, security_reason: null };
  }
  const reasons = [];
  const repeatedFailures = Number(history.failed_count) + (eventType === 'LOGIN_FAILED' ? 1 : 0) >= 5;
  if (repeatedFailures) reasons.push('At least five failed login attempts for this email in the last 15 minutes.');
  if (eventType === 'LOGIN_SUCCESS' && history.has_history) {
    if (history.has_ip === false) reasons.push('New IP address in the last 90 days of successful logins.');
    if (context.user_agent && history.has_device === false) reasons.push('Previously unseen user-agent in the last 90 days of successful logins.');
    // Location is optional, client-reported evidence. Require good accuracy at
    // both points and an extreme travel speed before raising a location signal.
    if (previousLocation && context.latitude !== null && context.location_accuracy !== null &&
        context.location_accuracy <= 10000 && context.location_permission_status === 'GRANTED') {
      const hours = (new Date(now) - new Date(previousLocation.created_at)) / 3600000;
      const km = distanceKm(previousLocation, context);
      if (hours > 0 && hours <= 24 && km >= 500 && km / hours > 900) {
        reasons.push('Client-reported location changed by at least 500 km with implied travel above 900 km/h; location requires verification.');
      }
    }
  }
  return {
    security_status: repeatedFailures ? 'SUSPICIOUS' : reasons.length ? 'NEEDS_REVIEW' : 'NORMAL',
    security_flag: reasons.length > 0,
    security_reason: reasons.length ? reasons.join(' ') : null,
  };
}

async function recordLoginSecurityEvent({ req, user, email, context, eventType }) {
  const ip = getClientIp(req);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Serialize the counter/read/insert for the same normalized email so that
    // concurrent failed attempts cannot all miss the five-attempt threshold.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [email]);
    const { rows: [history] } = await client.query(`
      SELECT NOW() AS now,
        (SELECT COUNT(*) FROM login_security_logs
          WHERE email = $1 AND event_type = 'LOGIN_FAILED'
            AND created_at >= NOW() - INTERVAL '15 minutes') AS failed_count,
        EXISTS (SELECT 1 FROM login_security_logs WHERE user_id = $2
          AND event_type = 'LOGIN_SUCCESS' AND created_at >= NOW() - INTERVAL '90 days') AS has_history,
        CASE WHEN $3::inet IS NULL THEN NULL ELSE EXISTS (
          SELECT 1 FROM login_security_logs WHERE user_id = $2 AND event_type = 'LOGIN_SUCCESS'
            AND created_at >= NOW() - INTERVAL '90 days' AND ip_address = $3::inet) END AS has_ip,
        EXISTS (SELECT 1 FROM login_security_logs WHERE user_id = $2 AND event_type = 'LOGIN_SUCCESS'
          AND created_at >= NOW() - INTERVAL '90 days' AND user_agent = $4) AS has_device
    `, [email, user?.id || null, ip, context.user_agent]);
    let previousLocation = null;
    if (eventType === 'LOGIN_SUCCESS' && user && context.latitude !== null && context.location_accuracy !== null) {
      const result = await client.query(`
        SELECT latitude, longitude, created_at FROM login_security_logs
        WHERE user_id = $1 AND event_type = 'LOGIN_SUCCESS'
          AND location_permission_status = 'GRANTED' AND latitude IS NOT NULL
          AND location_accuracy <= 10000 AND created_at >= NOW() - INTERVAL '24 hours'
        ORDER BY created_at DESC, id DESC LIMIT 1
      `, [user.id]);
      previousLocation = result.rows[0] || null;
    }
    const security = evaluateSecurity({ eventType, context, history, previousLocation, now: history.now });
    const result = await client.query(`
      INSERT INTO login_security_logs (
        user_id, user_name, email, role, event_type, login_status, ip_address,
        latitude, longitude, location_accuracy, location_permission_status,
        user_agent, platform, language, security_status, security_flag, security_reason
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
      RETURNING id, security_status, security_flag, security_reason
    `, [
      user?.id || null, user?.full_name || null, email, user?.role || null,
      eventType, eventType === 'LOGIN_FAILED' ? 'FAILED' : 'SUCCESS', ip,
      context.latitude, context.longitude, context.location_accuracy,
      context.location_permission_status, context.user_agent, context.platform, context.language,
      security.security_status, security.security_flag, security.security_reason,
    ]);
    await client.query('COMMIT');
    return { ...result.rows[0], security_audit_available: true };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function recordLoginSecurityEventSafely(event) {
  try {
    return await recordLoginSecurityEvent(event);
  } catch (error) {
    // Keep the existing authentication available if the audit store fails.
    // Never print the request, SQL parameters, email, password, or tokens.
    console.error('Login security audit could not be saved:', error.code || 'AUDIT_WRITE_FAILED');
    return { security_status: null, security_flag: null, security_reason: null, security_audit_available: false };
  }
}

module.exports = { recordLoginSecurityEvent, recordLoginSecurityEventSafely, evaluateSecurity, distanceKm };
