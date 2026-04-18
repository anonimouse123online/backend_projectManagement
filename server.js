const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const routes = require('./routes/index');
const pool = require('./db');

const app = express();

app.use(helmet());

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json({ limit: '25mb' }));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many requests, please try again later.' },
});
app.use('/auth', authLimiter);

app.use((req, res, next) => {
  console.log(`${req.method} ${req.url}`);
  next();
});

// ❌ REMOVE these two lines — already handled in routes/index.js
// const taskRoutes = require('./routes/taskRoutes');
// app.use('/tasks', taskRoutes);

// ✅ All routes go through here
app.use('/', routes);

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 5001;

pool.connect()
  .then(client => {
    console.log('✅ Connected to PostgreSQL — updated_sitepulse');
    client.release();
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