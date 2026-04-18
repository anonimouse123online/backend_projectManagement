const jwt    = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const pool   = require('../db');

const JWT_SECRET   = process.env.JWT_SECRET || 'your_secret_key';
const SALT_ROUNDS  = 10;

// ─── SIGNUP ───────────────────────────────────────────────
exports.signup = async (req, res) => {
  try {
    const { name, email, password, role } = req.body;
    console.log('Signup payload received:', { name, email, role });

    if (!name || !email || !password || !role) {
      return res.status(400).json({ error: 'Name, email, password, and role are required.' });
    }

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
      [name.trim(), email.trim().toLowerCase(), password_hash, role]
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

// ─── LOGIN ────────────────────────────────────────────────
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

    const redirectTo = user.role === 'admin'
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

// ─── DASHBOARD ────────────────────────────────────────────
exports.getDashboard = (req, res) => {
  res.json({ message: 'Welcome to your SitePulse dashboard!' });
};