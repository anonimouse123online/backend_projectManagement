const pool = require('../db');

// ============================================================
// HELPER
// Get logged-in user ID from authMiddleware
// ============================================================

function getUserId(req) {
  return (
    req.user?.id ||
    req.user?.user_id ||
    req.user?.userId
  );
}


// ============================================================
// GET ALL CONVERSATIONS
//
// GET /api/messages/conversations
// ============================================================

exports.getConversations = async (req, res) => {
  try {

    const userId = getUserId(req);

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'Unauthorized'
      });
    }

    const result = await pool.query(
      `
      SELECT
        c.id AS conversation_id,
        COALESCE(c.is_group, FALSE) AS is_group,
        c.group_name,
        c.created_at,
        c.updated_at,

        CASE WHEN COALESCE(c.is_group, FALSE) = FALSE THEN other_user.id ELSE NULL END AS user_id,
        CASE WHEN COALESCE(c.is_group, FALSE) = FALSE THEN other_user.full_name ELSE NULL END AS full_name,
        CASE WHEN COALESCE(c.is_group, FALSE) = FALSE THEN other_user.email ELSE NULL END AS email,

        COALESCE(
          latest.message_text,
          CASE
            WHEN latest.message_type = 'image' THEN 'Sent an image'
            WHEN latest.message_type = 'file' THEN 'Sent an attachment'
            ELSE NULL
          END
        ) AS last_message,
        latest.message_type,
        latest.created_at AS last_message_time,

        (
          SELECT COUNT(*)
          FROM messages unread
          WHERE unread.conversation_id = c.id
            AND unread.sender_id != $1
            AND unread.is_read = FALSE
        )::INTEGER AS unread_count,

        (
          SELECT COUNT(*)
          FROM conversation_members cm_count
          WHERE cm_count.conversation_id = c.id
        )::INTEGER AS member_count

      FROM conversations c

      JOIN conversation_members my_membership
        ON my_membership.conversation_id = c.id
       AND my_membership.user_id = $1

      LEFT JOIN LATERAL (
        SELECT u.id, u.full_name, u.email
        FROM conversation_members cm
        JOIN users u ON u.id = cm.user_id
        WHERE cm.conversation_id = c.id
          AND cm.user_id != $1
        LIMIT 1
      ) other_user ON COALESCE(c.is_group, FALSE) = FALSE

      LEFT JOIN LATERAL (
        SELECT
          m.message_text,
          m.message_type,
          m.created_at
        FROM messages m
        WHERE m.conversation_id = c.id
        ORDER BY m.created_at DESC
        LIMIT 1
      ) latest ON TRUE

      ORDER BY
        COALESCE(
          latest.created_at,
          c.created_at
        ) DESC
      `,
      [userId]
    );

    const conversations = result.rows.map((row) => ({
      ...row,
      dm_user: (!row.is_group && row.user_id)
        ? {
            id: row.user_id,
            full_name: row.full_name,
            email: row.email
          }
        : null
    }));

    return res.status(200).json({
      success: true,
      conversations
    });

  } catch (error) {

    console.error(
      'GET CONVERSATIONS ERROR:',
      error
    );

    return res.status(500).json({
      success: false,
      message: 'Failed to load conversations'
    });
  }
};


// Helper: Verify if target users share at least one project with userId
async function areUsersInSameProjects(clientOrPool, userId, targetUserIds) {
  if (!targetUserIds || targetUserIds.length === 0) return true;
  const res = await clientOrPool.query(
    `
    SELECT DISTINCT rel.user_id
    FROM (
      SELECT pm.user_id
      FROM project_members pm
      JOIN projects p ON (pm.project_id = p.code OR pm.project_id = p.id::text)
      WHERE p.owner_id = $1::uuid
      
      UNION
      
      SELECT p.owner_id AS user_id
      FROM projects p
      JOIN project_members pm ON (pm.project_id = p.code OR pm.project_id = p.id::text)
      WHERE pm.user_id = $1::uuid
      
      UNION
      
      SELECT pm1.user_id
      FROM project_members pm1
      JOIN projects p ON (pm1.project_id = p.code OR pm1.project_id = p.id::text)
      WHERE pm1.project_id IN (
        SELECT pm2.project_id
        FROM project_members pm2
        WHERE pm2.user_id = $1::uuid
      )
    ) rel
    WHERE rel.user_id = ANY($2::uuid[])
    `,
    [userId, targetUserIds]
  );
  return res.rows.length === targetUserIds.length;
}

// ============================================================
// CREATE CONVERSATION (1-ON-1 OR GROUP)
//
// POST /api/messages/conversations
// ============================================================

exports.createConversation = async (req, res) => {

  const client = await pool.connect();

  try {

    const senderId = getUserId(req);
    const { receiverId, isGroup, name, receiverIds } = req.body;

    if (!senderId) {

      return res.status(401).json({
        success: false,
        message: 'Unauthorized'
      });
    }

    // ========================================================
    // CREATE GROUP CONVERSATION
    // ========================================================
    if (isGroup) {
      const groupName = String(name || '').trim();
      if (!groupName) {
        return res.status(400).json({
          success: false,
          message: 'Group name is required'
        });
      }

      const validReceiverIds = Array.isArray(receiverIds)
        ? receiverIds.filter(id => id && String(id) !== String(senderId))
        : [];

      if (validReceiverIds.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'Please select at least one member to add'
        });
      }

      // Verify all added members share a project with the sender
      const isAllowed = await areUsersInSameProjects(client, senderId, validReceiverIds);
      if (!isAllowed) {
        return res.status(403).json({
          success: false,
          message: 'You can only add members who share a project with you'
        });
      }

      await client.query('BEGIN');

      const conversation = await client.query(
        `
        INSERT INTO conversations (is_group, group_name)
        VALUES (TRUE, $1)
        RETURNING *
        `,
        [groupName]
      );

      const conversationId = conversation.rows[0].id;

      // Add creator + all selected members
      const allMembers = Array.from(new Set([senderId, ...validReceiverIds]));
      for (const memberId of allMembers) {
        await client.query(
          `
          INSERT INTO conversation_members (conversation_id, user_id)
          VALUES ($1, $2::uuid)
          ON CONFLICT DO NOTHING
          `,
          [conversationId, memberId]
        );
      }

      await client.query('COMMIT');

      return res.status(201).json({
        success: true,
        message: 'Group conversation created',
        conversationId
      });
    }

    // ========================================================
    // CREATE / GET 1-ON-1 DIRECT MESSAGE
    // ========================================================
    if (!receiverId) {

      return res.status(400).json({
        success: false,
        message: 'receiverId is required'
      });
    }

    if (String(senderId) === String(receiverId)) {

      return res.status(400).json({
        success: false,
        message: 'You cannot message yourself'
      });
    }

    // Verify receiver shares a project with the sender
    const isAllowed = await areUsersInSameProjects(client, senderId, [receiverId]);
    if (!isAllowed) {
      return res.status(403).json({
        success: false,
        message: 'You can only message users who belong to your projects'
      });
    }

    // CHECK RECEIVER
    const receiver = await client.query(
      `
      SELECT id
      FROM users
      WHERE id = $1
      `,
      [receiverId]
    );

    if (receiver.rows.length === 0) {

      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // CHECK EXISTING 1-ON-1 CONVERSATION
    const existing = await client.query(
      `
      SELECT c.id
      FROM conversations c

      JOIN conversation_members cm1
        ON cm1.conversation_id = c.id
       AND cm1.user_id = $1

      JOIN conversation_members cm2
        ON cm2.conversation_id = c.id
       AND cm2.user_id = $2

      WHERE COALESCE(c.is_group, FALSE) = FALSE
        AND (
          SELECT COUNT(*)
          FROM conversation_members total
          WHERE total.conversation_id = c.id
        ) = 2

      LIMIT 1
      `,
      [
        senderId,
        receiverId
      ]
    );

    if (existing.rows.length > 0) {

      return res.status(200).json({
        success: true,
        conversationId:
          existing.rows[0].id
      });
    }

    await client.query('BEGIN');

    const conversation = await client.query(
      `
      INSERT INTO conversations (is_group)
      VALUES (FALSE)
      RETURNING *
      `
    );

    const conversationId =
      conversation.rows[0].id;

    await client.query(
      `
      INSERT INTO conversation_members
      (
        conversation_id,
        user_id
      )
      VALUES
        ($1, $2::uuid),
        ($1, $3::uuid)
      `,
      [
        conversationId,
        senderId,
        receiverId
      ]
    );

    await client.query('COMMIT');

    return res.status(201).json({
      success: true,
      message: 'Conversation created',
      conversationId
    });

  } catch (error) {

    await client.query('ROLLBACK');

    console.error(
      'CREATE CONVERSATION ERROR:',
      error
    );

    return res.status(500).json({
      success: false,
      message: 'Failed to create conversation'
    });

  } finally {

    client.release();

  }
};


// ============================================================
// GET MESSAGES FROM ONE CONVERSATION
//
// GET /api/messages/conversations/:conversationId
// ============================================================

exports.getMessages = async (req, res) => {
  try {

    const { conversationId } = req.params;

    // Logged-in user from JWT
    const userId =
      req.user?.id ||
      req.user?.user_id ||
      req.user?.userId;

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'Unauthorized'
      });
    }


    // ============================================================
    // CHECK USER BELONGS TO CONVERSATION
    // ============================================================

    const memberCheck = await pool.query(
      `
      SELECT 1
      FROM conversation_members
      WHERE conversation_id = $1
        AND user_id = $2
      LIMIT 1
      `,
      [
        conversationId,
        userId
      ]
    );

    if (memberCheck.rows.length === 0) {
      return res.status(403).json({
        success: false,
        message: 'You are not a member of this conversation'
      });
    }


    // ============================================================
    // GET MESSAGES
    // ============================================================

    const result = await pool.query(
      `
      SELECT
        m.id,
        m.conversation_id,
        m.sender_id,
        m.message_text,
        m.message_type,
        m.is_read,
        m.created_at,

        u.full_name AS sender_name,

        CASE
          WHEN m.sender_id = $2::uuid
          THEN TRUE
          ELSE FALSE
        END AS is_mine,

        COALESCE(
          (
            SELECT json_agg(
              json_build_object(
                'id', a.id,
                'originalName', a.original_name,
                'fileName', a.file_name,
                'filePath', a.file_path,
                'mimeType', a.mime_type,
                'fileSize', a.file_size
              )
            )
            FROM message_attachments a
            WHERE a.message_id = m.id
          ),
          '[]'::json
        ) AS attachments

      FROM messages m

      LEFT JOIN users u
        ON u.id = m.sender_id

      WHERE m.conversation_id = $1

      ORDER BY m.created_at ASC
      `,
      [
        conversationId,
        userId
      ]
    );


    return res.status(200).json({
      success: true,
      messages: result.rows
    });

  } catch (error) {

    console.error(
      'GET MESSAGES ERROR:',
      error
    );

    return res.status(500).json({
      success: false,
      message: 'Failed to load messages'
    });
  }
};


// ============================================================
// SEND TEXT MESSAGE
//
// POST /api/messages
//
// BODY:
// {
//    "conversationId": 1,
//    "message": "Hello"
// }
// ============================================================

exports.sendMessage = async (req, res) => {

  try {

    const senderId = getUserId(req);

    const {
      conversationId,
      message
    } = req.body;

    if (!conversationId) {

      return res.status(400).json({
        success: false,
        message:
          'conversationId is required'
      });
    }

    if (
      !message ||
      !message.trim()
    ) {

      return res.status(400).json({
        success: false,
        message:
          'Message cannot be empty'
      });
    }

    // ========================================================
    // CHECK MEMBERSHIP
    // ========================================================

    const member = await pool.query(
      `
      SELECT id
      FROM conversation_members
      WHERE conversation_id = $1
        AND user_id = $2
      `,
      [
        conversationId,
        senderId
      ]
    );

    if (member.rows.length === 0) {

      return res.status(403).json({
        success: false,
        message:
          'You are not part of this conversation'
      });
    }

    // ========================================================
    // INSERT MESSAGE
    // ========================================================

    const result = await pool.query(
      `
      INSERT INTO messages
      (
        conversation_id,
        sender_id,
        message_text,
        message_type
      )
      VALUES
      (
        $1,
        $2,
        $3,
        'text'
      )
      RETURNING *
      `,
      [
        conversationId,
        senderId,
        message.trim()
      ]
    );

    const newMessage =
      result.rows[0];

    // ========================================================
    // UPDATE CONVERSATION
    // ========================================================

    await pool.query(
      `
      UPDATE conversations
      SET updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      `,
      [conversationId]
    );

    // ========================================================
    // SOCKET.IO REALTIME
    // ========================================================

    const io = req.app.get('io');

    if (io) {

      io
        .to(`conversation:${conversationId}`)
        .emit(
          'new_message',
          newMessage
        );
    }

    return res.status(201).json({
      success: true,
      message: newMessage
    });

  } catch (error) {

    console.error(
      'SEND MESSAGE ERROR:',
      error
    );

    return res.status(500).json({
      success: false,
      message: 'Failed to send message'
    });
  }
};


// ============================================================
// SEND FILE / IMAGE
//
// POST /api/messages/upload
//
// multipart/form-data:
//
// conversationId = 1
// message = optional text
// file = actual file
// ============================================================

exports.sendAttachment = async (req, res) => {

  const client = await pool.connect();

  try {

    const senderId = getUserId(req);

    const {
      conversationId,
      message
    } = req.body;

    if (!conversationId) {

      return res.status(400).json({
        success: false,
        message:
          'conversationId is required'
      });
    }

    if (!req.file) {

      return res.status(400).json({
        success: false,
        message:
          'Please select a file'
      });
    }

    // ========================================================
    // CHECK MEMBERSHIP
    // ========================================================

    const member = await client.query(
      `
      SELECT id
      FROM conversation_members
      WHERE conversation_id = $1
        AND user_id = $2
      `,
      [
        conversationId,
        senderId
      ]
    );

    if (member.rows.length === 0) {

      return res.status(403).json({
        success: false,
        message:
          'You are not part of this conversation'
      });
    }

    await client.query('BEGIN');

    // ========================================================
    // DETERMINE TYPE
    // ========================================================

    let messageType = 'file';

    if (
      req.file.mimetype.startsWith('image/')
    ) {

      messageType = 'image';
    }

    // ========================================================
    // CREATE MESSAGE
    // ========================================================

    const messageResult =
      await client.query(
        `
        INSERT INTO messages
        (
          conversation_id,
          sender_id,
          message_text,
          message_type
        )
        VALUES
        (
          $1,
          $2,
          $3,
          $4
        )
        RETURNING *
        `,
        [
          conversationId,
          senderId,
          message || null,
          messageType
        ]
      );

    const newMessage =
      messageResult.rows[0];

    // ========================================================
    // SAVE ATTACHMENT
    // ========================================================

    const attachment =
      await client.query(
        `
        INSERT INTO message_attachments
        (
          message_id,
          original_name,
          file_name,
          file_path,
          mime_type,
          file_size
        )
        VALUES
        (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6
        )
        RETURNING *
        `,
        [
          newMessage.id,
          req.file.originalname,
          req.file.filename,
          `/uploads/messages/${req.file.filename}`,
          req.file.mimetype,
          req.file.size
        ]
      );

    await client.query(
      `
      UPDATE conversations
      SET updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      `,
      [conversationId]
    );

    await client.query('COMMIT');

    const responseMessage = {
      ...newMessage,

      attachments: [
        {
          id:
            attachment.rows[0].id,

          originalName:
            attachment.rows[0]
              .original_name,

          fileName:
            attachment.rows[0]
              .file_name,

          filePath:
            attachment.rows[0]
              .file_path,

          mimeType:
            attachment.rows[0]
              .mime_type,

          fileSize:
            attachment.rows[0]
              .file_size
        }
      ]
    };

    // ========================================================
    // REALTIME
    // ========================================================

    const io = req.app.get('io');

    if (io) {

      io
        .to(`conversation:${conversationId}`)
        .emit(
          'new_message',
          responseMessage
        );
    }

    return res.status(201).json({
      success: true,
      message: responseMessage
    });

  } catch (error) {

    await client.query('ROLLBACK');

    console.error(
      'SEND ATTACHMENT ERROR:',
      error
    );

    return res.status(500).json({
      success: false,
      message:
        'Failed to send attachment'
    });

  } finally {

    client.release();
  }
};


// ============================================================
// MARK CONVERSATION READ
//
// PUT /api/messages/conversations/:conversationId/read
// ============================================================

exports.markAsRead = async (req, res) => {

  try {

    const userId = getUserId(req);

    const {
      conversationId
    } = req.params;

    await pool.query(
      `
      UPDATE messages
      SET is_read = TRUE
      WHERE conversation_id = $1
        AND sender_id != $2
      `,
      [
        conversationId,
        userId
      ]
    );

    const io = req.app.get('io');

    if (io) {

      io
        .to(`conversation:${conversationId}`)
        .emit(
          'messages_read',
          {
            conversationId,
            userId
          }
        );
    }

    return res.status(200).json({
      success: true,
      message:
        'Messages marked as read'
    });

  } catch (error) {

    console.error(
      'MARK READ ERROR:',
      error
    );

    return res.status(500).json({
      success: false,
      message:
        'Failed to mark messages as read'
    });
  }
};


// ============================================================
// GET CONVERSATION MEMBERS
//
// GET /api/messages/conversations/:conversationId/members
// ============================================================

exports.getConversationMembers = async (req, res) => {
  try {
    const userId = getUserId(req);
    const { conversationId } = req.params;

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'Unauthorized'
      });
    }

    // Verify requesting user is a member of this conversation
    const memberCheck = await pool.query(
      `
      SELECT 1
      FROM conversation_members
      WHERE conversation_id = $1 AND user_id = $2
      `,
      [conversationId, userId]
    );

    if (memberCheck.rows.length === 0) {
      return res.status(403).json({
        success: false,
        message: 'Access denied. You are not a member of this conversation.'
      });
    }

    // Fetch conversation details + all members
    const convInfo = await pool.query(
      `
      SELECT
        c.id,
        COALESCE(c.is_group, FALSE) AS is_group,
        c.group_name,
        c.created_at
      FROM conversations c
      WHERE c.id = $1
      `,
      [conversationId]
    );

    const membersResult = await pool.query(
      `
      SELECT
        u.id,
        u.full_name,
        u.email,
        u.role,
        cm.joined_at
      FROM conversation_members cm
      JOIN users u ON u.id = cm.user_id
      WHERE cm.conversation_id = $1
      ORDER BY
        CASE WHEN u.id = $2 THEN 0 ELSE 1 END,
        u.full_name ASC
      `,
      [conversationId, userId]
    );

    return res.status(200).json({
      success: true,
      conversation: convInfo.rows[0] || null,
      members: membersResult.rows
    });

  } catch (error) {
    console.error('GET CONVERSATION MEMBERS ERROR:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch conversation members'
    });
  }
};