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
        n.message,
        n.audience,
        n.created_by,
        n.created_at,

        u.full_name AS sender_name

      FROM notifications n

      LEFT JOIN users u
        ON u.id = n.created_by

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

    const query = `
      INSERT INTO notifications (
        title,
        message,
        audience,
        created_by
      )

      VALUES ($1, $2, $3, $4)

      RETURNING
        id,
        title,
        message,
        audience,
        created_by,
        created_at
    `;


    const values = [
      title.trim(),
      message.trim(),
      selectedAudience,
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
    // DETERMINE FIREBASE TOPIC
    // ========================================================

    let topic;


    if (selectedAudience === 'engineer') {

      topic = 'engineers';

    } else {

      topic = 'all_users';
    }


    // ========================================================
    // SEND FIREBASE PUSH NOTIFICATION
    // ========================================================

    const firebaseMessage = {

      notification: {

        title:
          notification.title,

        body:
          notification.message
      },


      data: {

        notificationId:
          String(notification.id),

        audience:
          notification.audience,

        type:
          'admin_notification'
      },


      topic:
        topic
    };


    const firebaseResponse =
    await messaging.send(firebaseMessage);


    console.log(
      'Firebase notification sent:',
      firebaseResponse
    );


    // ========================================================
    // RESPONSE
    // ========================================================

    return res.status(201).json({

      success: true,

      message:
        'Notification saved and push notification sent successfully.',

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