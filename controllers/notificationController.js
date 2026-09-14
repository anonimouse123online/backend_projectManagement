const pool = require('../db');
const messaging =
  require('../configuration/firebaseAdmin');


// ============================================================
// GET ALL NOTIFICATIONS
// GET /notifications
// ============================================================

exports.getNotifications = async (req, res) => {
  try {
    const query = `
      SELECT
        n.id,
        n.title,
        n.body AS message,
        n.type AS audience,
        n.user_id AS created_by,
        n.created_at,
        n.read,
        n.link,

        u.full_name AS sender_name

      FROM notifications n

      LEFT JOIN users u
        ON u.id = n.user_id

      ORDER BY n.created_at DESC
    `;

    const result = await pool.query(query);

    return res.status(200).json({
      success: true,
      data: result.rows
    });

  } catch (error) {
    console.error(
      'Get notifications error:',
      error
    );

    return res.status(500).json({
      success: false,
      message: 'Failed to fetch notifications.'
    });
  }
};


// ============================================================
// CREATE / SEND NOTIFICATION
// POST /notifications
// ============================================================

// ============================================================
// CREATE / SEND NOTIFICATION
// POST /notifications
// ============================================================

exports.createNotification = async (req, res) => {
  try {
    const {
      title,
      message,
      audience
    } = req.body;


    // ========================================================
    // VALIDATION
    // ========================================================

    if (!title || !title.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Notification title is required.'
      });
    }


    if (!message || !message.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Notification message is required.'
      });
    }


    const allowedAudiences = [
      'all',
      'engineer'
    ];


    const selectedAudience =
      audience || 'all';


    if (
      !allowedAudiences.includes(
        selectedAudience
      )
    ) {
      return res.status(400).json({
        success: false,
        message: 'Invalid notification audience.'
      });
    }


    // ========================================================
    // GET LOGGED-IN USER
    // ========================================================

    const userId =
      req.user?.id ||
      req.user?.userId;


    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'Unauthorized.'
      });
    }


    // ========================================================
    // ADMIN CHECK
    // ========================================================

    const role =
      req.user?.role?.toLowerCase();


    if (role && role !== 'admin') {
      return res.status(403).json({
        success: false,
        message:
          'Only administrators can send notifications.'
      });
    }


    // ========================================================
    // INSERT NOTIFICATION INTO POSTGRESQL
    // ========================================================

    // The DB 'type' column has a CHECK constraint:
    // task, message, weather, file, project, member, deadline
    // Admin-sent broadcast notifications use type 'message'
    const dbType = 'message';

    const query = `
      INSERT INTO notifications (
        title,
        body,
        type,
        user_id
      )

      VALUES ($1, $2, $3, $4)

      RETURNING
        id,
        title,
        body AS message,
        type AS audience,
        user_id AS created_by,
        created_at
    `;


    const values = [
      title.trim(),
      message.trim(),
      dbType,
      userId
    ];


    const result =
      await pool.query(
        query,
        values
      );


    const notification =
      result.rows[0];


    // ========================================================
    // SEND FIREBASE PUSH NOTIFICATION (if available)
    // ========================================================

    let firebaseResponse = null;

    if (messaging) {
      try {
        let topic;

        if (selectedAudience === 'engineer') {
          topic = 'engineers';
        } else {
          topic = 'all_users';
        }

        const firebaseMessage = {
          notification: {
            title: notification.title,
            body: notification.message
          },
          data: {
            notificationId: String(notification.id),
            audience: notification.audience,
            type: 'admin_notification'
          },
          topic: topic
        };

        firebaseResponse =
          await messaging.send(firebaseMessage);

        console.log(
          'Firebase notification sent:',
          firebaseResponse
        );
      } catch (fbErr) {
        console.warn(
          'Firebase push failed (notification still saved):',
          fbErr.message
        );
      }
    } else {
      console.log(
        'Firebase messaging not available — notification saved to DB only.'
      );
    }


    // ========================================================
    // RESPONSE
    // ========================================================

    return res.status(201).json({

      success: true,

      message:
        'Notification saved successfully.',

      data:
        notification,

      firebaseMessageId:
        firebaseResponse
    });


  } catch (error) {

    console.error(
      'Create notification error:',
      error
    );


    return res.status(500).json({

      success: false,

      message:
        'Failed to send notification.',

      error:
        error.message
    });
  }
};