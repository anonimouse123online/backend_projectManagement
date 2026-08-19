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


  // ==========================================================
  // CONNECTION
  // ==========================================================

  io.on(
    'connection',
    (socket) => {

      console.log(
        `💬 Socket connected: ${socket.id}`
      );


      // ========================================================
      // USER ROOM
      //
      // Mobile app sends:
      //
      // socket.emit("join_user", userId)
      // ========================================================

      socket.on(
        'join_user',
        (userId) => {

          if (!userId) return;

          socket.join(
            `user:${userId}`
          );

          console.log(
            `👤 User ${userId} joined socket room`
          );
        }
      );


      // ========================================================
      // JOIN CONVERSATION
      //
      // socket.emit(
      //    "join_conversation",
      //    conversationId
      // )
      // ========================================================

      socket.on(
        'join_conversation',
        (conversationId) => {

          if (!conversationId) {
            return;
          }

          socket.join(
            `conversation:${conversationId}`
          );

          console.log(
            `💬 ${socket.id} joined conversation ${conversationId}`
          );
        }
      );


      // ========================================================
      // LEAVE CONVERSATION
      // ========================================================

      socket.on(
        'leave_conversation',
        (conversationId) => {

          socket.leave(
            `conversation:${conversationId}`
          );
        }
      );


      // ========================================================
      // TYPING
      // ========================================================

      socket.on(
        'typing',
        ({
          conversationId,
          userId
        }) => {

          socket
            .to(
              `conversation:${conversationId}`
            )
            .emit(
              'user_typing',
              {
                conversationId,
                userId
              }
            );
        }
      );


      // ========================================================
      // STOP TYPING
      // ========================================================

      socket.on(
        'stop_typing',
        ({
          conversationId,
          userId
        }) => {

          socket
            .to(
              `conversation:${conversationId}`
            )
            .emit(
              'user_stop_typing',
              {
                conversationId,
                userId
              }
            );
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