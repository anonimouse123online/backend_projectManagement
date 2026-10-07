const { isIP } = require('node:net');

const PERMISSIONS = new Set(['GRANTED', 'DENIED', 'UNAVAILABLE', 'TIMEOUT']);

function invalid(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function optionalString(value, field, max) {
  if (value === undefined || value === null) return null;
  // eslint-disable-next-line no-control-regex -- Reject ASCII control characters in security metadata.
  if (typeof value !== 'string' || value.length > max || /[\x00-\x1f\x7f]/.test(value)) {
    throw invalid(`security_context.${field} must be a string of at most ${max} characters without control characters.`);
  }
  return value.trim() || null;
}

function optionalNumber(value, field, min, max) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw invalid(`security_context.${field} must be a finite number between ${min} and ${max}.`);
  }
  return value;
}

function validateSecurityContext(input, headerUserAgent) {
  if (input !== undefined && input !== null && (typeof input !== 'object' || Array.isArray(input))) {
    throw invalid('security_context must be an object.');
  }
  const context = input || {};
  const permission = context.location_permission_status ?? null;
  if (permission !== null && !PERMISSIONS.has(permission)) {
    throw invalid('Invalid security_context.location_permission_status.');
  }
  const latitude = optionalNumber(context.latitude, 'latitude', -90, 90);
  const longitude = optionalNumber(context.longitude, 'longitude', -180, 180);
  const accuracy = optionalNumber(context.location_accuracy, 'location_accuracy', 0, 1e9);
  if ((latitude === null) !== (longitude === null)) {
    throw invalid('security_context.latitude and longitude must be supplied together.');
  }
  if ((latitude !== null || accuracy !== null) && permission !== 'GRANTED') {
    throw invalid('Location values require location_permission_status GRANTED.');
  }
  if (accuracy !== null && latitude === null) {
    throw invalid('location_accuracy requires latitude and longitude.');
  }
  // Only these fields are persisted. Client-supplied IP, names, roles, and tokens
  // are never copied into an audit record.
  const suppliedAgent = optionalString(context.user_agent, 'user_agent', 2048);
  const fallbackAgent = typeof headerUserAgent === 'string'
    // eslint-disable-next-line no-control-regex -- Strip ASCII control characters from the header value.
    ? headerUserAgent.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 2048) : null;
  return {
    latitude, longitude, location_accuracy: accuracy,
    location_permission_status: permission,
    user_agent: suppliedAgent || fallbackAgent || null,
    platform: optionalString(context.platform, 'platform', 100),
    language: optionalString(context.language, 'language', 35),
  };
}

function normalizeIp(value) {
  if (typeof value !== 'string' || !isIP(value)) return null;
  if (isIP(value) === 4) return value;
  // A link-local IPv6 scope identifies a local interface, not the IP itself;
  // PostgreSQL INET does not accept that suffix.
  const canonical = new URL(`http://[${value.split('%')[0]}]/`).hostname.slice(1, -1);
  const mapped = /^::ffff:([\da-f]{1,4}):([\da-f]{1,4})$/i.exec(canonical);
  if (mapped) {
    const high = parseInt(mapped[1], 16), low = parseInt(mapped[2], 16);
    return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
  }
  return canonical;
}

function getClientIp(req) {
  // Express resolves req.ip using the configured trust function. Never parse
  // X-Forwarded-For or CF-Connecting-IP here.
  return normalizeIp(req.ip) || normalizeIp(req.socket?.remoteAddress);
}

module.exports = { validateSecurityContext, getClientIp, normalizeIp, invalid };
