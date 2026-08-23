const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const pool = require('../db');

const JWT_SECRET = process.env.JWT_SECRET;
const SALT_ROUNDS = 10;

if (!JWT_SECRET) {
  console.error('❌ FATAL: JWT_SECRET is not set in .env');
  process.exit(1);
}


// ─── ROLE NORMALIZER ──────────────────────────────────────────
// Database only accepts:
// admin
// engineer

const normalizeRole = (role) => {
  if (!role) return null;

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

  return null;
};


// ─── SIGNUP ───────────────────────────────────────────────────
exports.signup = async (req, res) => {
  try {
    const { name, email, password, role } = req.body;

    console.log('Signup payload received:', {
      name,
      email,
      role,
    });

    if (!email || !password || !role) {
      return res.status(400).json({
        error: 'Email, password, and role are required.',
      });
    }

    // Normalize email
    const normalizedEmail = email.trim().toLowerCase();

    // Normalize role
    const normalizedRole = normalizeRole(role);

    if (!normalizedRole) {
      return res.status(400).json({
        error: 'Invalid role. Only Admin and Engineer are allowed.',
      });
    }

    console.log(
      `Normalized signup role: ${role} -> ${normalizedRole}`
    );

    // Use name if provided, otherwise derive from email
    const fullName =
      name?.trim() ||
      normalizedEmail.split('@')[0];

    // Check if email already exists
    const existing = await pool.query(
      `
      SELECT id
      FROM users
      WHERE email = $1
      `,
      [normalizedEmail]
    );

    if (existing.rows.length > 0) {
      return res.status(409).json({
        error: 'Email already registered.',
      });
    }

    // Hash password
    const password_hash = await bcrypt.hash(
      password,
      SALT_ROUNDS
    );

    // Create user
    const result = await pool.query(
      `
      INSERT INTO users (
        full_name,
        email,
        password_hash,
        role
      )
      VALUES ($1, $2, $3, $4)
      RETURNING
        id,
        full_name,
        email,
        role,
        created_at
      `,
      [
        fullName,
        normalizedEmail,
        password_hash,
        normalizedRole,
      ]
    );

    const user = result.rows[0];

    return res.status(201).json({
      message: 'User created successfully!',
      user: {
        id: user.id,
        name: user.full_name,
        email: user.email,
        role: user.role,
      },
    });

  } catch (error) {
    console.error('Signup error:', error);

    return res.status(500).json({
      error: 'Error during signup.',
    });
  }
};


// ─── LOGIN ────────────────────────────────────────────────────
exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        error: 'Email and password are required.',
      });
    }

    const normalizedEmail = email.trim().toLowerCase();

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
      return res.status(401).json({
        error: 'Invalid credentials.',
      });
    }

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

    // Database stores lowercase roles
    const redirectTo =
      user.role === 'admin'
        ? '/admin/dashboard'
        : '/engineer/dashboard';

    return res.json({
      message: 'Login successful.',
      token,
      redirectTo,
      user: {
        id: user.id,
        name: user.full_name,
        email: user.email,
        role: user.role,
      },
    });

  } catch (error) {
    console.error('Login error:', error);

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
        WHERE status != 'Resolved'
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