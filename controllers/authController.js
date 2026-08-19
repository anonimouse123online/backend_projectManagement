const jwt    = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const pool   = require('../db');

const JWT_SECRET   = process.env.JWT_SECRET;
const SALT_ROUNDS  = 10;

if (!JWT_SECRET) {
  console.error('❌ FATAL: JWT_SECRET is not set in .env');
  process.exit(1);
}

// ─── SIGNUP ───────────────────────────────────────────────────
exports.signup = async (req, res) => {
  try {
    const { name, email, password, role } = req.body;
    console.log('Signup payload received:', { name, email, role });

    if (!email || !password || !role) {
      return res.status(400).json({ error: 'Email, password, and role are required.' });
    }

    // Use name if provided, otherwise derive from email
    const fullName = name?.trim() || email.split('@')[0];

    const existing = await pool.query(
      'SELECT id FROM users WHERE email = $1', [email]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Email already registered.' });
    }

    // ─── hash password ────────────────────────────────────
    const password_hash = await bcrypt.hash(password, SALT_ROUNDS);

    const result = await pool.query(
      `INSERT INTO users (full_name, email, password_hash, role)
       VALUES ($1, $2, $3, $4)
       RETURNING id, full_name, email, role, created_at`,
      [fullName, email.trim().toLowerCase(), password_hash, role]
    );

    const user = result.rows[0];

    return res.status(201).json({
      message: 'User created successfully!',
      user: {
        id:    user.id,
        name:  user.full_name,
        email: user.email,
        role:  user.role,
      },
    });
  } catch (error) {
    console.error('Signup error:', error);
    return res.status(500).json({ error: 'Error during signup.' });
  }
};

// ─── LOGIN ────────────────────────────────────────────────────
exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    const result = await pool.query(
      'SELECT * FROM users WHERE email = $1 AND is_active = TRUE',
      [email.trim().toLowerCase()]
    );

    const user = result.rows[0];
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    // ─── bcrypt compare ───────────────────────────────────
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      JWT_SECRET,
      { expiresIn: '7d' }  // extended for mobile offline use
    );

    const redirectTo = user.role === 'Admin'
      ? '/admin/dashboard'
      : '/engineer/dashboard';

    return res.json({
      message: 'Login successful.',
      token,
      redirectTo,
      user: {
        id:    user.id,
        name:  user.full_name,
        email: user.email,
        role:  user.role,
      },
    });
  } catch (error) {
    console.error('Login error:', error);
    return res.status(500).json({ error: 'Error during login.' });
  }
};

// ─── GET CURRENT USER PROFILE ─────────────────────────────────
exports.getMe = async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Unauthorized.' });

    const result = await pool.query(
      'SELECT id, full_name, email, phone, company, preferences, created_at FROM users WHERE id = $1 AND is_active = TRUE',
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }

    const user = result.rows[0];
    res.json({
      success: true,
      data: {
        id: user.id,
        name: user.full_name,
        email: user.email,
        role: user.role,
        phone: user.phone || '',
        company: user.company || 'SitePulse Construction Corp',
        preferences: user.preferences || {
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
    res.status(500).json({ error: 'Failed to fetch user profile.' });
  }
};

// ─── UPDATE PROFILE ───────────────────────────────────────────
exports.updateProfile = async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Unauthorized.' });

    const { full_name, phone, company, preferences } = req.body;

    const result = await pool.query(
      `UPDATE users
       SET full_name   = COALESCE($1, full_name),
           phone       = COALESCE($2, phone),
           company     = COALESCE($3, company),
           preferences = COALESCE($4, preferences),
           updated_at  = NOW()
       WHERE id = $5 AND is_active = TRUE
       RETURNING id, full_name, email, role, phone, company, preferences, updated_at`,
      [full_name ? full_name.trim() : null, phone, company, preferences ? JSON.stringify(preferences) : null, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }

    const user = result.rows[0];
    return res.json({
      success: true,
      message: 'Profile updated successfully!',
      data: {
        id: user.id,
        name: user.full_name,
        email: user.email,
        role: user.role,
        phone: user.phone,
        company: user.company,
        preferences: user.preferences,
      },
    });
  } catch (err) {
    console.error('updateProfile error:', err);
    return res.status(500).json({ error: 'Failed to update profile settings.' });
  }
};

// ─── CHANGE PASSWORD ──────────────────────────────────────────
exports.changePassword = async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Unauthorized.' });

    const { current_password, new_password } = req.body;
    if (!current_password || !new_password) {
      return res.status(400).json({ error: 'Current password and new password are required.' });
    }

    if (new_password.length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters.' });
    }

    const userRes = await pool.query(
      'SELECT password_hash FROM users WHERE id = $1 AND is_active = TRUE',
      [userId]
    );

    if (userRes.rows.length === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }

    const isMatch = await bcrypt.compare(current_password, userRes.rows[0].password_hash);
    if (!isMatch) {
      return res.status(400).json({ error: 'Incorrect current password.' });
    }

    const newHash = await bcrypt.hash(new_password, SALT_ROUNDS);
    await pool.query('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2', [newHash, userId]);

    return res.json({
      success: true,
      message: 'Password changed successfully! Please use your new password next time you log in.',
    });
  } catch (err) {
    console.error('changePassword error:', err);
    return res.status(500).json({ error: 'Failed to update password.' });
  }
};

// ─── SYSTEM HEALTH & METRICS ──────────────────────────────────
exports.getSystemHealth = async (req, res) => {
  try {
    const [dbTest, projCount, usersCount, issuesCount] = await Promise.all([
      pool.query('SELECT NOW() as db_time'),
      pool.query('SELECT COUNT(*) FROM projects'),
      pool.query('SELECT COUNT(*) FROM users WHERE is_active = TRUE'),
      pool.query('SELECT COUNT(*) FROM project_issues WHERE status != \'Resolved\''),
    ]);

    return res.json({
      success: true,
      data: {
        status: 'Operational',
        database: 'Connected (PostgreSQL updated_sitepulse)',
        serverTime: dbTest.rows[0].db_time,
        metrics: {
          totalProjects: parseInt(projCount.rows[0].count),
          activeUsers: parseInt(usersCount.rows[0].count),
          openIssues: parseInt(issuesCount.rows[0].count),
        },
        version: 'SitePulse v2.4.0-prod',
        nodeEnvironment: process.env.NODE_ENV || 'development',
      },
    });
  } catch (err) {
    console.error('getSystemHealth error:', err);
    return res.status(500).json({ error: 'Failed to check system health.' });
  }
};

// ─── DASHBOARD ────────────────────────────────────────────────
exports.getDashboard = (req, res) => {
  res.json({ message: 'Welcome to your SitePulse dashboard!' });
};