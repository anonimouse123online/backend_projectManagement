const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const pool = require('../db');

function initializeSocket(server) {
  const io = new Server(server, { cors: { origin: process.env.CORS_ORIGIN || 'http://localhost:5173' } });
  require('./projectIssueService').initializeIssueSocket(io);
  io.use(async (socket, next) => {
    try {
      const user = jwt.verify(socket.handshake.auth?.token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
      const { rows } = await pool.query('SELECT id FROM users WHERE id::text = $1 AND is_active = TRUE', [user.id]);
      if (!rows.length) throw new Error('Invalid account');
      socket.data.user = rows[0];
      next();
    } catch { next(new Error('Authentication required.')); }
  });
  io.on('connection', socket => {
    const userId = socket.data.user.id;
    socket.join(`user:${userId}`);
    socket.on('join_user', id => { if (id === userId) socket.join(`user:${userId}`); });
    async function isMember(conversationId) {
      const { rows } = await pool.query(`SELECT 1 FROM conversation_members
        WHERE conversation_id::text = $1 AND user_id = $2::uuid`, [String(conversationId), userId]);
      return rows.length > 0;
    }
    socket.on('join_conversation', async id => {
      try { if (await isMember(id)) socket.join(`conversation:${id}`); }
      catch { /* Fail closed on lookup errors. */ }
    });
    socket.on('leave_conversation', id => socket.leave(`conversation:${id}`));
    for (const [incoming, outgoing] of [['typing', 'user_typing'], ['stop_typing', 'user_stop_typing']]) {
      socket.on(incoming, async ({ conversationId } = {}) => {
        try {
          if (await isMember(conversationId)) socket.to(`conversation:${conversationId}`).emit(outgoing, { conversationId, userId });
        } catch { /* Fail closed on lookup errors. */ }
      });
    }
  });
  return io;
}
module.exports = initializeSocket;
