const bcrypt = require('bcryptjs');

// In-memory verification code store
// Map<lowercaseEmail, { codeHash: string, expiresAt: number, lastSentAt: number }>
const verificationCodes = new Map();

/**
 * Store a verification code securely in memory with a 15-minute TTL.
 * @param {string} email Target user email
 * @param {string} code 6-digit verification code
 * @param {number} ttlMs Expiration time in ms (default: 15 minutes)
 */
function setCode(email, code, ttlMs = 15 * 60 * 1000) {
  if (!email || !code) return;
  const key = email.trim().toLowerCase();
  const codeStr = String(code).trim();
  const codeHash = bcrypt.hashSync(codeStr, 10);

  verificationCodes.set(key, {
    codeHash,
    expiresAt: Date.now() + ttlMs,
    lastSentAt: Date.now(),
  });
}

/**
 * Check rate-limiting cooldown for resending verification code.
 * @param {string} email
 * @param {number} cooldownMs Cooldown duration in ms (default: 60 seconds)
 * @returns {{ allowed: boolean, secondsRemaining: number }}
 */
function canResend(email, cooldownMs = 60 * 1000) {
  if (!email) return { allowed: true, secondsRemaining: 0 };
  const key = email.trim().toLowerCase();
  const record = verificationCodes.get(key);

  if (!record || !record.lastSentAt) {
    return { allowed: true, secondsRemaining: 0 };
  }

  const elapsed = Date.now() - record.lastSentAt;
  if (elapsed < cooldownMs) {
    const secondsRemaining = Math.ceil((cooldownMs - elapsed) / 1000);
    return { allowed: false, secondsRemaining };
  }

  return { allowed: true, secondsRemaining: 0 };
}

/**
 * Verify an input code for an email address.
 * @param {string} email
 * @param {string} inputCode
 * @returns {{ valid: boolean, reason?: string }}
 */
function verifyCode(email, inputCode) {
  if (!email || !inputCode) {
    return { valid: false, reason: 'Email and verification code are required.' };
  }

  const key = email.trim().toLowerCase();
  const record = verificationCodes.get(key);

  if (!record) {
    return { valid: false, reason: 'Invalid verification code.' };
  }

  if (Date.now() > record.expiresAt) {
    return { valid: false, reason: 'Verification code has expired. Please request a new one.' };
  }

  const matches = bcrypt.compareSync(String(inputCode).trim(), record.codeHash);
  if (!matches) {
    return { valid: false, reason: 'Invalid verification code.' };
  }

  return { valid: true };
}

/**
 * Remove/invalidate the verification code for an email address.
 * @param {string} email
 */
function deleteCode(email) {
  if (!email) return;
  const key = email.trim().toLowerCase();
  verificationCodes.delete(key);
}

module.exports = {
  setCode,
  canResend,
  verifyCode,
  deleteCode,
};
