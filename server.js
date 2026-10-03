require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const http = require('http');
const path = require('path');

const routes = require('./routes/index');

// ============================================================
// PASSWORD RESET ROUTES
// ============================================================

const passwordResetRoutes =
  require('./routes/passwordResetRoutes');

const pool = require('./db');

const {
  startScheduler
} = require('./services/schedulerService');

const {
  verifyToken
} = require('./middlewares/authMiddleware');

const initializeSocket =
  require('./services/socketService');


// ============================================================
// EXPRESS APP
// ============================================================

const app = express();


// ============================================================
// HTTP SERVER
//
// Required for Socket.IO
// ============================================================

const server =
  http.createServer(app);


// ============================================================
// SOCKET.IO
// ============================================================

const io =
  initializeSocket(server);


// Make io available inside controllers:
//
// const io = req.app.get('io');
//
app.set(
  'io',
  io
);


// ============================================================
// SECURITY
// ============================================================

app.use(
  helmet({
    crossOriginResourcePolicy: false,
  })
);


// ============================================================
// CORS
// ============================================================

const corsOrigin =
  process.env.CORS_ORIGIN ||
  'http://localhost:5173';


app.use(
  cors({

    origin:
      corsOrigin,

    methods: [
      'GET',
      'POST',
      'PUT',
      'PATCH',
      'DELETE',
      'OPTIONS',
    ],

    allowedHeaders: [
      'Content-Type',
      'Authorization',
    ],
  })
);


// ============================================================
// BODY PARSER
// ============================================================

app.use(
  express.json({
    limit: '25mb',
  })
);


app.use(
  express.urlencoded({
    extended: true,
    limit: '25mb',
  })
);


// ============================================================
// RATE LIMIT
// ============================================================

const limiter =
  rateLimit({

    windowMs:
      15 * 60 * 1000,

    max:
      100000,

    standardHeaders:
      true,

    legacyHeaders:
      false,
  });


app.use(
  limiter
);


// ============================================================
// STATIC UPLOADS
//
// Example:
//
// http://localhost:5001/uploads/messages/photo.jpg
// ============================================================

app.use(
  '/uploads',

  express.static(
    path.join(
      __dirname,
      'uploads'
    )
  )
);


// ============================================================
// REQUEST LOGGER
// ============================================================

app.use(
  (
    req,
    res,
    next
  ) => {

    console.log(
      `${req.method} ${req.url}`
    );

    next();
  }
);


// ============================================================
// PUBLIC ROUTES
// ============================================================

app.get(
  '/health',

  (
    req,
    res
  ) => {

    res.json({

      status:
        'ok',

      socket:
        'enabled',
    });
  }
);


// ============================================================
// WEATHER PROXY ENDPOINT (Automatic GPS Weather for Mobile App & Web)
// ============================================================
app.get('/weather', async (req, res) => {
  try {
    const lat = req.query.lat || req.query.latitude || 9.88;
    const lon = req.query.lon || req.query.longitude || 123.60;

    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,is_day,weather_code,wind_speed_10m`;
    const response = await fetch(url);
    if (!response.ok) {
      return res.status(502).json({ success: false, error: 'Weather service unavailable' });
    }
    const data = await response.json();
    return res.json({ success: true, ...data });
  } catch (err) {
    console.error('Weather proxy error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
// AUTHENTICATION MIDDLEWARE
// ============================================================

app.use(
  (
    req,
    res,
    next
  ) => {

    // ========================================================
    // PUBLIC ROUTES
    // ========================================================

    if (
      req.path.startsWith('/auth/') ||
      req.path === '/health' ||
      req.path === '/weather' ||
      req.path.startsWith('/uploads/')
    ) {

      return next();
    }


    // ========================================================
    // PROTECTED ROUTES
    // ========================================================

    verifyToken(
      req,
      res,
      next
    );
  }
);


// ============================================================
// EXISTING API ROUTES
// ============================================================

app.use(
  '/',
  routes
);


// ============================================================
// PASSWORD RESET ROUTES
//
// Final endpoints:
//
// POST /auth/forgot-password
// POST /auth/verify-reset-code
// POST /auth/reset-password
//
// passwordResetRoutes.js only needs:
//
// /forgot-password
// /verify-reset-code
// /reset-password
// ============================================================

app.use(
  '/auth',
  passwordResetRoutes
);


// ============================================================
// 404
// ============================================================

app.use(
  (
    req,
    res
  ) => {

    return res
      .status(404)
      .json({

        success:
          false,

        message:
          'Route not found',
      });
  }
);


// ============================================================
// GLOBAL ERROR HANDLER
// ============================================================

app.use(
  (
    err,
    req,
    res,
    next
  ) => {

    console.error(
      '❌ SERVER ERROR:',
      err
    );


    // ========================================================
    // MULTER FILE TOO LARGE
    // ========================================================

    if (
      err.code ===
      'LIMIT_FILE_SIZE'
    ) {

      return res
        .status(413)
        .json({

          success:
            false,

          message:
            'File is too large. Maximum size is 10 MB.',
        });
    }


    return res
      .status(
        err.status ||
        500
      )
      .json({

        success:
          false,

        message:
          err.message ||
          'Internal server error',
      });
  }
);


// ============================================================
// PORT
// ============================================================

const PORT =
  process.env.PORT ||
  5001;


// ============================================================
// DATABASE CONNECTION
// ============================================================

pool
  .connect()

  .then(
    (
      client
    ) => {

      console.log(
        `✅ Connected to PostgreSQL — ${process.env.DB_NAME || 'sitepulse_db'}`
      );


      client.release();


      // ======================================================
      // START SCHEDULED JOBS
      // ======================================================

      startScheduler();


      // ======================================================
      // START HTTP + SOCKET.IO SERVER
      //
      // 0.0.0.0 allows physical Android devices
      // on the same network to access this backend.
      // ======================================================

      server.listen(
        PORT,
        '0.0.0.0',

        () => {

          const BASE_URL =
            `http://localhost:${PORT}`;


          console.log('');


          console.log(
            '══════════════════════════════════════════════'
          );


          console.log(
            '🚀 SITEPULSE BACKEND RUNNING'
          );


          console.log(
            '══════════════════════════════════════════════'
          );


          console.log(
            `🌐 Base API: ${BASE_URL}`
          );


          console.log('');


          // ==================================================
          // PUBLIC
          // ==================================================

          console.log(
            '📡 PUBLIC API'
          );


          console.log(
            `GET     ${BASE_URL}/health`
          );


          console.log('');


          // ==================================================
          // AUTH
          // ==================================================

          console.log(
            '🔐 AUTH API'
          );


          console.log(
            `POST    ${BASE_URL}/auth/signup`
          );


          console.log(
            `POST    ${BASE_URL}/auth/login`
          );


          console.log(
            `POST    ${BASE_URL}/auth/forgot-password`
          );


          console.log(
            `POST    ${BASE_URL}/auth/verify-reset-code`
          );


          console.log(
            `POST    ${BASE_URL}/auth/reset-password`
          );


          console.log('');


          // ==================================================
          // PROJECTS
          // ==================================================

          console.log(
            '📁 PROJECT API'
          );


          console.log(
            `GET     ${BASE_URL}/projects`
          );


          console.log(
            `GET     ${BASE_URL}/projects/:id`
          );


          console.log(
            `POST    ${BASE_URL}/projects`
          );


          console.log(
            `PATCH   ${BASE_URL}/projects/:id`
          );


          console.log(
            `DELETE  ${BASE_URL}/projects/:id`
          );


          console.log('');


          // ==================================================
          // SOFTWARE
          // ==================================================

          console.log(
            '💻 SOFTWARE API'
          );


          console.log(
            `GET     ${BASE_URL}/software`
          );


          console.log('');


          // ==================================================
          // MESSAGES
          // ==================================================

          console.log(
            '💬 MESSAGE API'
          );


          console.log(
            `GET     ${BASE_URL}/messages/conversations`
          );


          console.log(
            `POST    ${BASE_URL}/messages/conversations`
          );


          console.log(
            `GET     ${BASE_URL}/messages/conversations/:conversationId`
          );


          console.log(
            `POST    ${BASE_URL}/messages`
          );


          console.log(
            `POST    ${BASE_URL}/messages/upload`
          );


          console.log(
            `PUT     ${BASE_URL}/messages/conversations/:conversationId/read`
          );


          console.log('');


          // ==================================================
          // SOCKET.IO
          // ==================================================

          console.log(
            '⚡ REAL-TIME MESSAGING'
          );


          console.log(
            `Socket.IO: ${BASE_URL}`
          );


          console.log(
            'Events:'
          );


          console.log(
            '  join_user'
          );


          console.log(
            '  join_conversation'
          );


          console.log(
            '  leave_conversation'
          );


          console.log(
            '  new_message'
          );


          console.log(
            '  typing'
          );


          console.log(
            '  stop_typing'
          );


          console.log(
            '  messages_read'
          );


          console.log('');


          console.log(
            '══════════════════════════════════════════════'
          );


          console.log(
            `📱 Android Emulator Base URL: http://10.0.2.2:${PORT}/`
          );


          console.log(
            `📱 Physical Phone API:       http://10.119.145.52:${PORT}/`
          );


          console.log(
            `🖥️  Web / Postman Base URL:   ${BASE_URL}/`
          );


          console.log(
            `📎 Upload URL:                ${BASE_URL}/uploads/`
          );


          console.log(
            '══════════════════════════════════════════════'
          );


          console.log('');
        }
      );
    }
  )

  .catch(
    (
      err
    ) => {

      console.error(
        '❌ PostgreSQL connection failed:',
        err.message
      );


      process.exit(1);
    }
  );