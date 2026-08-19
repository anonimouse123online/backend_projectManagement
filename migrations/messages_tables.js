const pool = require('../db');

async function createMessageTables() {
  try {
    // ============================================================
    // CONVERSATIONS
    // ============================================================
    await pool.query(`
      CREATE TABLE IF NOT EXISTS conversations (
        id SERIAL PRIMARY KEY,

        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // ============================================================
    // CONVERSATION MEMBERS
    // ============================================================
    await pool.query(`
      CREATE TABLE IF NOT EXISTS conversation_members (
        id SERIAL PRIMARY KEY,

        conversation_id INTEGER NOT NULL
          REFERENCES conversations(id)
          ON DELETE CASCADE,

        user_id INTEGER NOT NULL
          REFERENCES users(id)
          ON DELETE CASCADE,

        joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

        UNIQUE(conversation_id, user_id)
      );
    `);

    // ============================================================
    // MESSAGES
    // ============================================================
    await pool.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,

        conversation_id INTEGER NOT NULL
          REFERENCES conversations(id)
          ON DELETE CASCADE,

        sender_id INTEGER NOT NULL
          REFERENCES users(id)
          ON DELETE CASCADE,

        message_text TEXT,

        message_type VARCHAR(30) DEFAULT 'text',

        is_read BOOLEAN DEFAULT FALSE,

        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // ============================================================
    // MESSAGE ATTACHMENTS
    // ============================================================
    await pool.query(`
      CREATE TABLE IF NOT EXISTS message_attachments (
        id SERIAL PRIMARY KEY,

        message_id INTEGER NOT NULL
          REFERENCES messages(id)
          ON DELETE CASCADE,

        original_name TEXT NOT NULL,

        file_name TEXT NOT NULL,

        file_path TEXT NOT NULL,

        mime_type VARCHAR(150),

        file_size BIGINT,

        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // ============================================================
    // INDEXES
    // ============================================================
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_messages_conversation
      ON messages(conversation_id);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_messages_sender
      ON messages(sender_id);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_conversation_members_user
      ON conversation_members(user_id);
    `);

    console.log('✅ Message tables ready');

  } catch (error) {
    console.error(
      '❌ Failed creating message tables:',
      error.message
    );

    throw error;
  }
}

module.exports = createMessageTables;