const pool = require('../db');
const messaging = require('../configuration/firebaseAdmin');

// ============================================================
// GET NOTIFICATIONS
// GET /notifications
//
// Isolated by recipient:
// 1. Senders see notifications they created
// 2. Recipients only see notifications targeted to:
//    - 'all'
//    - 'engineer' (if user is engineer)
//    - 'project' (if user belongs to project_id or owns the project)
//    - 'individual' (if target_user_id === user.id)
// 3. Admins can see all notifications with target details
// ============================================================

exports.getNotifications = async (req, res) => {
  try {
    const userId = req.user?.id || req.user?.userId;
    const role = (req.user?.role || '').toLowerCase();

    let query;
    let values = [];

    const baseSelect = `
      SELECT
        n.id,
        n.title,
        n.message,
        n.audience,
        n.project_id,
        COALESCE(p.name, n.project_id) AS project_name,
        n.target_user_id,
        target_u.full_name AS target_user_name,
        target_u.email AS target_user_email,
        n.created_by,
        n.created_at,
        u.full_name AS sender_name,
        u.email AS sender_email
      FROM notifications n
      LEFT JOIN users u ON u.id = n.created_by
      LEFT JOIN projects p ON p.code = n.project_id
      LEFT JOIN users target_u ON target_u.id = n.target_user_id
    `;

    if (!userId) {
      // Unauthenticated fallback
      query = `
        ${baseSelect}
        WHERE n.audience = 'all'
        ORDER BY n.created_at DESC
      `;
    } else if (role === 'admin') {
      // Admins see all notifications with complete isolation metadata
      query = `
        ${baseSelect}
        ORDER BY n.created_at DESC
      `;
    } else {
      // Isolated notifications for the logged-in user
      const isEngineer = role.includes('engineer');
      query = `
        ${baseSelect}
        WHERE
          n.created_by = $1
          OR n.target_user_id = $1
          OR n.audience = 'all'
          OR (n.audience = 'engineer' AND $2 = true)
          OR (
            n.audience = 'project'
            AND (
              n.project_id IN (
                SELECT project_id FROM project_members WHERE user_id = $1
              )
              OR n.project_id IN (
                SELECT code FROM projects WHERE owner_id = $1
              )
            )
          )
        ORDER BY n.created_at DESC
      `;
      values = [userId, isEngineer];
    }

    const result = await pool.query(query, values);

    return res.status(200).json({
      success: true,
      data: result.rows
    });

  } catch (error) {
    console.error('Get notifications error:', error);

    return res.status(500).json({
      success: false,
      message: 'Failed to fetch notifications.'
    });
  }
};


// ============================================================
// CREATE / SEND NOTIFICATION
// POST /notifications
//
// Supports targeting:
// - audience: 'all' | 'engineer' | 'project' | 'individual'
// - projectId: project code (e.g. 'PRJ-2026-001')
// - targetUserId: UUID of user to notify alone
// ============================================================

exports.createNotification = async (req, res) => {
  try {
    const {
      title,
      message,
      audience,
      projectId,
      targetUserId
    } = req.body;

    // Validation
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
      'engineer',
      'project',
      'individual'
    ];

    const selectedAudience = audience || 'all';

    if (!allowedAudiences.includes(selectedAudience)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid notification audience.'
      });
    }

    if (selectedAudience === 'project' && (!projectId || !projectId.trim())) {
      return res.status(400).json({
        success: false,
        message: 'Please select a project for project-scoped notifications.'
      });
    }

    if (selectedAudience === 'individual' && (!targetUserId || !targetUserId.trim())) {
      return res.status(400).json({
        success: false,
        message: 'Please select a specific person to notify.'
      });
    }

    const userId = req.user?.id || req.user?.userId;

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'Unauthorized.'
      });
    }

    // Role check: Admin, Project Manager, Site Engineer, Supervisor can send notifications
    const role = (req.user?.role || '').toLowerCase();
    const allowedRoles = ['admin', 'project manager', 'site engineer', 'supervisor'];
    if (role && !allowedRoles.includes(role)) {
      return res.status(403).json({
        success: false,
        message: 'You do not have permission to send notifications.'
      });
    }

    const cleanProjectId = projectId ? projectId.trim() : null;
    const cleanTargetUserId = targetUserId ? targetUserId.trim() : null;

    // Retrieve project name if specified
    let projectName = null;
    if (cleanProjectId) {
      const projCheck = await pool.query(
        'SELECT name FROM projects WHERE code = $1 LIMIT 1',
        [cleanProjectId]
      );
      if (projCheck.rows.length > 0) {
        projectName = projCheck.rows[0].name;
      }
    }

    // Retrieve target user name if specified
    let targetUserName = null;
    if (cleanTargetUserId) {
      const userCheck = await pool.query(
        'SELECT full_name FROM users WHERE id = $1 LIMIT 1',
        [cleanTargetUserId]
      );
      if (userCheck.rows.length > 0) {
        targetUserName = userCheck.rows[0].full_name;
      }
    }

    // Insert into PostgreSQL
    const insertQuery = `
      INSERT INTO notifications (
        title,
        message,
        audience,
        project_id,
        target_user_id,
        created_by
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING
        id,
        title,
        message,
        audience,
        project_id,
        target_user_id,
        created_by,
        created_at
    `;

    const insertValues = [
      title.trim(),
      message.trim(),
      selectedAudience,
      cleanProjectId,
      cleanTargetUserId,
      userId
    ];

    const result = await pool.query(insertQuery, insertValues);
    const notification = result.rows[0];

    // Enrich with names
    const senderResult = await pool.query(
      'SELECT full_name FROM users WHERE id = $1',
      [userId]
    );
    const senderName = senderResult.rows[0]?.full_name || 'SitePulse Team';

    const enrichedNotification = {
      ...notification,
      project_name: projectName || cleanProjectId,
      target_user_name: targetUserName,
      sender_name: senderName
    };

    // ========================================================
    // DISPATCH PUSH NOTIFICATIONS (FCM)
    // ========================================================
    try {
      const displayTitle = (selectedAudience === 'project' || selectedAudience === 'individual') && projectName
        ? `[${projectName}] ${notification.title}`
        : notification.title;

      const fcmBasePayload = {
        notification: {
          title: displayTitle,
          body: notification.message
        },
        data: {
          title: displayTitle,
          message: notification.message,
          notificationId: String(notification.id),
          audience: notification.audience,
          projectId: cleanProjectId || '',
          targetUserId: cleanTargetUserId || '',
          type: 'admin_notification'
        },
        android: {
          priority: 'high',
          notification: {
            channelId: 'sitepulse_notifications',
            icon: 'ic_notification',
            color: '#2563EB',
            sound: 'default',
            priority: 'high',
            defaultSound: true,
            defaultVibrateTimings: true
          }
        }
      };

      if (selectedAudience === 'all') {
        messaging.send({ ...fcmBasePayload, topic: 'all_users' }).catch(() => {});
      } else if (selectedAudience === 'engineer') {
        messaging.send({ ...fcmBasePayload, topic: 'engineers' }).catch(() => {});
      } else if (selectedAudience === 'project' && cleanProjectId) {
        // Send to project topic
        const sanitizedTopic = 'proj_' + cleanProjectId.replace(/[^a-zA-Z0-9_-]/g, '_');
        messaging.send({ ...fcmBasePayload, topic: sanitizedTopic }).catch(() => {});

        // Also push directly to each project member's personal topic
        const members = await pool.query(
          'SELECT user_id FROM project_members WHERE project_id = $1',
          [cleanProjectId]
        );
        for (const m of members.rows) {
          if (m.user_id !== userId) {
            messaging.send({ ...fcmBasePayload, topic: `user_${m.user_id}` }).catch(() => {});
          }
        }
      } else if (selectedAudience === 'individual' && cleanTargetUserId) {
        // Push exclusively to the targeted person
        messaging.send({ ...fcmBasePayload, topic: `user_${cleanTargetUserId}` }).catch(() => {});
      }
    } catch (fcmErr) {
      console.warn('FCM dispatch warning:', fcmErr.message);
    }

    // ========================================================
    // REALTIME SOCKET.IO
    // ========================================================
    const io = req.app.get('io');
    if (io) {
      if (selectedAudience === 'project' && cleanProjectId) {
        io.to(`project:${cleanProjectId}`).emit('new_notification', enrichedNotification);
      } else if (selectedAudience === 'individual' && cleanTargetUserId) {
        io.to(`user:${cleanTargetUserId}`).emit('new_notification', enrichedNotification);
      } else {
        io.emit('new_notification', enrichedNotification);
      }
    }

    return res.status(201).json({
      success: true,
      message: 'Notification sent successfully.',
      data: enrichedNotification
    });

  } catch (error) {
    console.error('Create notification error:', error);

    return res.status(500).json({
      success: false,
      message: 'Failed to send notification.',
      error: error.message
    });
  }
};