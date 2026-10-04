const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const pool = require('../db');
const verificationStore = require('../services/verificationStore');
const { sendVerificationCodeEmail } = require('../services/emailService');
const { validateSecurityContext } = require('../services/loginSecurityContext');
const { recordLoginSecurityEventSafely } = require('../services/loginSecurityService');

const JWT_SECRET = process.env.JWT_SECRET;
const SALT_ROUNDS = 10;

if (!JWT_SECRET) {
  console.error('❌ FATAL: JWT_SECRET is not set in .env');
  process.exit(1);
}


// ─── ROLE NORMALIZER ──────────────────────────────────────────
// Database accepts: admin, engineer
const normalizeRole = (role) => {
  if (!role) return 'engineer';

  const normalized = role.trim().toLowerCase();

  if (normalized === 'admin') {
    return 'admin';
  }

  if (
    normalized === 'engineer' ||
    normalized === 'site engineer' ||
    normalized === 'site_engineer'
  ) {
    return 'engineer';
  }

  return 'engineer';
};


// ─── SEND VERIFICATION CODE ────────────────────────────────────
exports.sendVerificationCode = async (req, res) => {
  try {
    const { email } = req.body;

    if (!email || typeof email !== 'string' || !email.trim()) {
      return res.status(400).json({
        error: 'Email address is required.',
      });
    }

    const normalizedEmail = email.trim().toLowerCase();

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(normalizedEmail)) {
      return res.status(400).json({
        error: 'Invalid email address format.',
      });
    }

    // Rate-limiting / cooldown check (60 seconds)
    const { allowed, secondsRemaining } = verificationStore.canResend(normalizedEmail);
    if (!allowed) {
      return res.status(400).json({
        error: `Please wait ${secondsRemaining} seconds before requesting a new verification code.`,
      });
    }

    // Generate random 6-digit numeric verification code (e.g. "482910")
    const code = Math.floor(100000 + Math.random() * 900000).toString();

    // Store securely in memory with 15-minute expiration (900,000 ms)
    verificationStore.setCode(normalizedEmail, code, 15 * 60 * 1000);

    // Send email to user using EmailJS REST API
    await sendVerificationCodeEmail(normalizedEmail, code);

    return res.status(200).json({
      message: 'Verification code sent! Please check your email inbox.',
    });
  } catch (error) {
    console.error('sendVerificationCode error:', error.message);
    return res.status(500).json({
      error: 'Failed to send verification code email.',
    });
  }
};


// ─── SIGNUP ───────────────────────────────────────────────────
exports.signup = async (req, res) => {
  try {
    const { name, email, verificationCode, password, role } = req.body;

    console.log('Signup request received for email:', email);

    // 1. Check required fields
    if (!name || !email || !password) {
      return res.status(400).json({
        error: 'Name, email, and password are required.',
      });
    }

    const normalizedEmail = email.trim().toLowerCase();

    // 2. Check if user with this email already exists
    const existing = await pool.query(
      `
      SELECT id
      FROM users
      WHERE email = $1
      `,
      [normalizedEmail]
    );

    if (existing.rows.length > 0) {
      return res.status(400).json({
        error: 'Email is already registered.',
      });
    }

    let isEmailVerified = false;

    // 3. Verify OTP code if provided during registration
    if (verificationCode) {
      const verifyResult = verificationStore.verifyCode(normalizedEmail, verificationCode);
      if (!verifyResult.valid) {
        return res.status(400).json({
          error: verifyResult.reason || 'Invalid verification code.',
        });
      }
      isEmailVerified = true;
    }

    // 4. Hash password securely (bcrypt with salt rounds = 10)
    const password_hash = await bcrypt.hash(password, SALT_ROUNDS);
    const normalizedRole = normalizeRole(role);
    const fullName = name.trim();

    // 5. Save user in database
    const result = await pool.query(
      `
      INSERT INTO users (
        full_name,
        email,
        password_hash,
        role,
        email_verified
      )
      VALUES ($1, $2, $3, $4, $5)
      RETURNING
        id,
        full_name,
        email,
        role,
        email_verified,
        created_at
      `,
      [
        fullName,
        normalizedEmail,
        password_hash,
        normalizedRole,
        isEmailVerified,
      ]
    );

    const user = result.rows[0];

    // 6. Invalidate verification code if used
    if (isEmailVerified) {
      verificationStore.deleteCode(normalizedEmail);
    }

    return res.status(201).json({
      message: 'Registration successful.',
      user: {
        id: user.id,
        name: user.full_name,
        email: user.email,
        role: user.role,
        emailVerified: user.email_verified,
      },
    });

  } catch (error) {
    console.error('Signup error:', error.message);
    return res.status(500).json({
      error: 'Error during signup.',
    });
  }
};


// ─── VERIFY EMAIL ──────────────────────────────────────────────
exports.verifyEmail = async (req, res) => {
  try {
    const { email, code } = req.body;

    if (!email || !code) {
      return res.status(400).json({
        error: 'Email and verification code are required.',
      });
    }

    const normalizedEmail = email.trim().toLowerCase();

    // 1. Verify user exists in database
    const userRes = await pool.query(
      `
      SELECT id, email_verified
      FROM users
      WHERE email = $1
      `,
      [normalizedEmail]
    );

    if (userRes.rows.length === 0) {
      return res.status(400).json({
        error: 'User not found with this email address.',
      });
    }

    if (userRes.rows[0].email_verified) {
      return res.status(200).json({
        message: 'Email is already verified.',
      });
    }

    // 2. Verify code and expiration (15 minutes)
    const verifyResult = verificationStore.verifyCode(normalizedEmail, code);
    if (!verifyResult.valid) {
      return res.status(400).json({
        error: verifyResult.reason || 'Invalid verification code.',
      });
    }

    // 3. Mark user email_verified = TRUE in database
    await pool.query(
      `
      UPDATE users
      SET
        email_verified = TRUE,
        verification_code_hash = NULL,
        verification_code_expires_at = NULL,
        updated_at = NOW()
      WHERE email = $1
      `,
      [normalizedEmail]
    );

    // 4. Clear used code from memory
    verificationStore.deleteCode(normalizedEmail);

    return res.status(200).json({
      message: 'Email verified successfully.',
    });

  } catch (error) {
    console.error('verifyEmail error:', error.message);
    return res.status(500).json({
      error: 'Failed to verify email address.',
    });
  }
};


// ─── RESEND VERIFICATION CODE ──────────────────────────────────
exports.resendVerification = async (req, res) => {
  try {
    const { email } = req.body;

    if (!email || typeof email !== 'string' || !email.trim()) {
      return res.status(400).json({
        error: 'Email address is required.',
      });
    }

    const normalizedEmail = email.trim().toLowerCase();

    // 1. Rate-limiting cooldown check (60 seconds)
    const { allowed, secondsRemaining } = verificationStore.canResend(normalizedEmail);
    if (!allowed) {
      return res.status(400).json({
        error: `Please wait ${secondsRemaining} seconds before requesting a new verification code.`,
      });
    }

    // 2. Generate new 6-digit verification code
    const newCode = Math.floor(100000 + Math.random() * 900000).toString();

    // 3. Store new code with reset 15-minute expiration
    verificationStore.setCode(normalizedEmail, newCode, 15 * 60 * 1000);

    // 4. Send email via EmailJS REST API
    await sendVerificationCodeEmail(normalizedEmail, newCode);

    return res.status(200).json({
      message: 'Verification code sent! Please check your email inbox.',
    });

  } catch (error) {
    console.error('resendVerification error:', error.message);
    return res.status(500).json({
      error: 'Failed to resend verification code.',
    });
  }
};


// ─── LOGIN ────────────────────────────────────────────────────
exports.login = async (req, res) => {
  try {
    const { email, password, security_context } = req.body || {};

    if (typeof email !== 'string' || !email.trim() || email.trim().length > 255 ||
        // eslint-disable-next-line no-control-regex -- Reject ASCII control characters in email input.
        /[\x00-\x1f\x7f]/.test(email) || typeof password !== 'string' || !password) {
      return res.status(400).json({
        error: 'Email and password are required.',
      });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const context = validateSecurityContext(security_context, req.headers['user-agent']);

    const result = await pool.query(
      `
      SELECT *
      FROM users
      WHERE email = $1
        AND is_active = TRUE
      `,
      [normalizedEmail]
    );

    const user = result.rows[0];

    if (!user) {
      await recordLoginSecurityEventSafely({ req, email: normalizedEmail, context, eventType: 'LOGIN_FAILED' });
      return res.status(401).json({
        error: 'Invalid credentials.',
      });
    }

    // Compare password
    const match = await bcrypt.compare(
      password,
      user.password_hash
    );

    if (!match) {
      await recordLoginSecurityEventSafely({ req, user, email: normalizedEmail, context, eventType: 'LOGIN_FAILED' });
      return res.status(401).json({
        error: 'Invalid credentials.',
      });
    }

    const security = await recordLoginSecurityEventSafely({
      req, user, email: normalizedEmail, context, eventType: 'LOGIN_SUCCESS',
    });

    // Create JWT
    const token = jwt.sign(
      {
        id: user.id,
        email: user.email,
        role: user.role,
      },
      JWT_SECRET,
      {
        expiresIn: '7d',
      }
    );

    // Database stores roles (handle case-insensitive)
    const redirectTo =
      user.role?.toLowerCase() === 'admin'
        ? '/admin/dashboard'
        : '/engineer/dashboard';

    return res.json({
      message: 'Login successful.',
      token,
      redirectTo,
      security_status: security.security_status,
      security_flag: security.security_flag,
      security_reason: security.security_reason,
      security_audit_available: security.security_audit_available,
      user: {
        id: user.id,
        name: user.full_name,
        email: user.email,
        role: user.role,
      },
    });

  } catch (error) {
    if (error.status === 400) {
      return res.status(400).json({ error: error.message });
    }
    console.error('Login error:', error.code || 'LOGIN_ERROR');

    return res.status(500).json({
      error: 'Error during login.',
    });
  }
};


// ─── GET CURRENT USER PROFILE ─────────────────────────────────
// ─── GET CURRENT USER PROFILE ─────────────────────────────────
exports.getMe = async (req, res) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({
        error: 'Unauthorized.',
      });
    }

    const result = await pool.query(
      `
      SELECT
        id,
        full_name,
        email,
        role,
        created_at
      FROM users
      WHERE id = $1
        AND is_active = TRUE
      `,
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: 'User not found.',
      });
    }

    const user = result.rows[0];

    return res.status(200).json({
      success: true,
      data: {
        id: user.id,
        name: user.full_name,
        email: user.email,
        role: user.role,

        // Not stored in database
        phone: null,
        company: null,

        // Default frontend preferences
        preferences: {
          email_notifications: true,
          sms_alerts: false,
          theme: 'light',
          weather_unit: 'celsius',
          currency: 'PHP',
        },

        createdAt: user.created_at,
      },
    });

  } catch (err) {
    console.error('getMe error:', err);

    return res.status(500).json({
      error: 'Failed to fetch user profile.',
    });
  }
};


// ─── UPDATE PROFILE ───────────────────────────────────────────
// ─── UPDATE PROFILE ───────────────────────────────────────────
exports.updateProfile = async (req, res) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({
        error: 'Unauthorized.',
      });
    }

    const { full_name } = req.body;

    const result = await pool.query(
      `
      UPDATE users
      SET
        full_name = COALESCE($1, full_name),
        updated_at = NOW()
      WHERE id = $2
        AND is_active = TRUE
      RETURNING
        id,
        full_name,
        email,
        role,
        updated_at
      `,
      [
        full_name?.trim() || null,
        userId,
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: 'User not found.',
      });
    }

    const user = result.rows[0];

    return res.status(200).json({
      success: true,
      message: 'Profile updated successfully!',
      data: {
        id: user.id,
        name: user.full_name,
        email: user.email,
        role: user.role,
        phone: null,
        company: null,
        preferences: {
          email_notifications: true,
          sms_alerts: false,
          theme: 'light',
          weather_unit: 'celsius',
          currency: 'PHP',
        },
      },
    });

  } catch (err) {
    console.error('updateProfile error:', err);

    return res.status(500).json({
      error: 'Failed to update profile settings.',
    });
  }
};


// ─── CHANGE PASSWORD ──────────────────────────────────────────
exports.changePassword = async (req, res) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({
        error: 'Unauthorized.',
      });
    }

    const {
      current_password,
      new_password,
    } = req.body;

    if (!current_password || !new_password) {
      return res.status(400).json({
        error:
          'Current password and new password are required.',
      });
    }

    if (new_password.length < 6) {
      return res.status(400).json({
        error:
          'New password must be at least 6 characters.',
      });
    }

    const userRes = await pool.query(
      `
      SELECT password_hash
      FROM users
      WHERE id = $1
        AND is_active = TRUE
      `,
      [userId]
    );

    if (userRes.rows.length === 0) {
      return res.status(404).json({
        error: 'User not found.',
      });
    }

    const isMatch = await bcrypt.compare(
      current_password,
      userRes.rows[0].password_hash
    );

    if (!isMatch) {
      return res.status(400).json({
        error: 'Incorrect current password.',
      });
    }

    const newHash = await bcrypt.hash(
      new_password,
      SALT_ROUNDS
    );

    await pool.query(
      `
      UPDATE users
      SET
        password_hash = $1,
        updated_at = NOW()
      WHERE id = $2
      `,
      [
        newHash,
        userId,
      ]
    );

    return res.json({
      success: true,
      message:
        'Password changed successfully! Please use your new password next time you log in.',
    });

  } catch (err) {
    console.error('changePassword error:', err);

    return res.status(500).json({
      error: 'Failed to update password.',
    });
  }
};


// ─── SYSTEM HEALTH & METRICS ──────────────────────────────────
exports.getSystemHealth = async (req, res) => {
  try {
    const [
      dbTest,
      projCount,
      usersCount,
      issuesCount,
    ] = await Promise.all([
      pool.query(
        'SELECT NOW() as db_time'
      ),

      pool.query(
        'SELECT COUNT(*) FROM projects'
      ),

      pool.query(
        `
        SELECT COUNT(*)
        FROM users
        WHERE is_active = TRUE
        `
      ),

      pool.query(
        `
        SELECT COUNT(*)
        FROM project_issues
        WHERE status IN ('open', 'in_progress')
        `
      ),
    ]);

    return res.json({
      success: true,

      data: {
        status: 'Operational',

        database:
          'Connected (PostgreSQL updated_sitepulse)',

        serverTime:
          dbTest.rows[0].db_time,

        metrics: {
          totalProjects:
            parseInt(
              projCount.rows[0].count
            ),

          activeUsers:
            parseInt(
              usersCount.rows[0].count
            ),

          openIssues:
            parseInt(
              issuesCount.rows[0].count
            ),
        },

        version:
          'SitePulse v2.4.0-prod',

        nodeEnvironment:
          process.env.NODE_ENV ||
          'development',
      },
    });

  } catch (err) {
    console.error(
      'getSystemHealth error:',
      err
    );

    return res.status(500).json({
      error:
        'Failed to check system health.',
    });
  }
};


// ─── DASHBOARD ────────────────────────────────────────────────
exports.getDashboard = (req, res) => {
  return res.json({
    message:
      'Welcome to your SitePulse dashboard!',
  });
};
