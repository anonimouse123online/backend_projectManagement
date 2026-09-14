const { Server } = require('socket.io');

function initializeSocket(server) {

  const io = new Server(
    server,
    {
      cors: {
        origin: '*',
        methods: [
          'GET',
          'POST',
          'PUT'
        ]
      }
    }
  );

  const jwt = require('jsonwebtoken');
  const pool = require('../db');

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) {
      return next(new Error('Authentication error: No token provided'));
    }

    jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
      if (err) {
        return next(new Error('Authentication error: Invalid token'));
      }
      socket.userId = decoded.id;
      next();
    });
  });


  // ==========================================================
  // CONNECTION
  // ==========================================================

  io.on(
    'connection',
    async (socket) => {

      console.log(
        `💬 Socket connected securely: ${socket.id} for user ${socket.userId}`
      );

      // Force user into their private room
      socket.join(`user:${socket.userId}`);

      // Auto-join all conversations this user is part of
      try {
        const convs = await pool.query(
          'SELECT conversation_id FROM conversation_members WHERE user_id = $1',
          [socket.userId]
        );
        convs.rows.forEach(row => {
          socket.join(`conversation:${row.conversation_id}`);
        });
      } catch (err) {
        console.error('Socket DB error joining conversations:', err);
      }

      // ========================================================
      // NEW CONVERSATION JOIN (When a new chat is created)
      // ========================================================

      socket.on(
        'join_conversation',
        async (conversationId) => {
          if (!conversationId) return;

          // Verify they are actually a member before joining
          try {
            const check = await pool.query(
              'SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2',
              [conversationId, socket.userId]
            );
            if (check.rows.length > 0) {
              socket.join(`conversation:${conversationId}`);
              console.log(`💬 ${socket.userId} securely joined conversation ${conversationId}`);
            }
          } catch (err) {
            console.error('Socket DB error verifying membership:', err);
          }
        }
      );


      // ========================================================
      // TYPING
      // ========================================================

      socket.on(
        'typing',
        ({ conversationId }) => {
          socket
            .to(`conversation:${conversationId}`)
            .emit('user_typing', {
              conversationId,
              userId: socket.userId
            });
        }
      );


      // ========================================================
      // STOP TYPING
      // ========================================================

      socket.on(
        'stop_typing',
        ({ conversationId }) => {
          socket
            .to(`conversation:${conversationId}`)
            .emit('user_stop_typing', {
              conversationId,
              userId: socket.userId
            });
        }
      );


      // ========================================================
      // DISCONNECT
      // ========================================================

      socket.on(
        'disconnect',
        () => {

          console.log(
            `❌ Socket disconnected: ${socket.id}`
          );
        }
      );

    }
  );


  return io;
}


module.exports =
  initializeSocket;