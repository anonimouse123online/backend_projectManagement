const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const routes = require('./routes/index');
const pool = require('./db');
const { startScheduler } = require('./services/schedulerService');
const { verifyToken } = require('./middlewares/authMiddleware');

const app = express();

app.use(helmet());

// ─── CORS — use env variable instead of wildcard ────────────────────────────
const corsOrigin = process.env.CORS_ORIGIN || 'http://localhost:5173';
app.use(cors({
  origin: corsOrigin,
  methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json({ limit: '25mb' }));

// ─── Request logger ─────────────────────────────────────────────────────────
app.use((req, res, next) => {
  console.log(`${req.method} ${req.url}`);
  next();
});

// ─── Public routes (no auth required) ───────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ─── Auth middleware — protect everything except /auth/* and /health ─────────
app.use((req, res, next) => {
  // Skip auth for login, signup, and health check
  if (req.path.startsWith('/auth/') || req.path === '/health') {
    return next();
  }
  verifyToken(req, res, next);
});

// ✅ All routes go through here
app.use('/', routes);

const PORT = process.env.PORT || 5001;

pool.connect()
  .then(client => {
    console.log('✅ Connected to PostgreSQL — updated_sitepulse');
    client.release();

    startScheduler();

    app.listen(PORT, () => {
      console.log(`🚀 Server running on http://localhost:${PORT}`);
      console.log(`   AUTH     → http://localhost:${PORT}/auth/signup`);
      console.log(`   AUTH     → http://localhost:${PORT}/auth/login`);
      console.log(`   SOFTWARE → http://localhost:${PORT}/software`);
    });
  })
  .catch(err => {
    console.error('❌ PostgreSQL connection failed:', err.message);
    process.exit(1);
  });