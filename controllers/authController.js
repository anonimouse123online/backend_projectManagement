const jwt  = require('jsonwebtoken');
const pool = require('../db');

const JWT_SECRET = process.env.JWT_SECRET || 'your_secret_key';

// ─── SIGNUP ───────────────────────────────────────────────
exports.signup = async (req, res) => {
  try {
    const { email, password, role } = req.body;

    if (!email || !password || !role) {
      return res.status(400).json({ error: 'Email, password, and role are required.' });
    }

    const existing = await pool.query(
      'SELECT id FROM users WHERE email = $1', [email]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Email already registered.' });
    }

    // TODO: hash password later
    await pool.query(
      'INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3)',
      [email, password, role]
    );

    res.status(201).json({ message: 'User created successfully!' });
  } catch (error) {
    console.error('Signup error:', error);
    res.status(500).json({ error: 'Error during signup.' });
  }
};

// ─── LOGIN ────────────────────────────────────────────────
exports.login = async (req, res) => {
  try {
    const { email, password, role } = req.body;

    if (!email || !password || !role) {
      return res.status(400).json({ error: 'Email, password, and role are required.' });
    }

    const result = await pool.query(
      'SELECT * FROM users WHERE email = $1 AND role = $2 AND is_active = TRUE',
      [email, role]
    );

    const user = result.rows[0];
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials or role mismatch.' });
    }

    // Plain text compare — replace with bcrypt later
    if (password !== user.password_hash) {
      return res.status(401).json({ error: 'Invalid credentials or role mismatch.' });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      JWT_SECRET,
      { expiresIn: '1h' }
    );

    res.json({
      message: 'Login successful.',
      token,
      user: {
        id:    user.id,
        email: user.email,
        role:  user.role,
        name:  user.full_name,
      },
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Error during login.' });
  }
};

// ─── DASHBOARD ────────────────────────────────────────────
exports.getDashboard = (req, res) => {
  res.json({ message: 'Welcome to your SitePulse dashboard!' });
};