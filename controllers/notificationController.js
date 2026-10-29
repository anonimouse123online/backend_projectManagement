const access = require('../services/projectAccessService');
const pool = require('../db');

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

    if (!userId) return res.status(401).json({ error: 'Authentication required.' });
    query = `${baseSelect} WHERE
      (n.project_id IS NOT NULL AND ${access.projectScope('p', 1)}
        AND (n.audience != 'individual' OR n.target_user_id = $1 OR n.created_by = $1))
      OR (n.project_id IS NULL AND (n.created_by = $1 OR n.target_user_id = $1))
      ORDER BY n.created_at DESC`;
    values = [userId];
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

    if (['all', 'engineer'].includes(selectedAudience)) {
      return res.status(403).json({ error: 'Select a project or an authorized recipient.' });
    }
    if (cleanProjectId) {
      await access.getProject(cleanProjectId, req.user);
    }
    if (cleanTargetUserId) {
      const { rows } = await pool.query(`SELECT 1 FROM projects p WHERE ${access.projectScope('p', 1)}
        AND ${access.projectScope('p', 2)} AND ($3::text IS NULL OR p.code = $3) LIMIT 1`,
        [userId, cleanTargetUserId, cleanProjectId]);
      if (!rows.length) return res.status(403).json({ error: 'Recipient must share an authorized project.' });
    }
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

    // Project data is delivered through authenticated socket rooms and the API.
    // FCM topic subscriptions do not prove authorization; never publish it there.
    // ========================================================
    // REALTIME SOCKET.IO
    // ========================================================
    const io = req.app.get('io');
    if (io) {
      const recipients = cleanProjectId ? (await pool.query(`SELECT u.id FROM users u
        JOIN projects p ON p.code = $1 WHERE u.is_active = TRUE AND
        (u.id = p.owner_id OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.code AND pm.user_id = u.id))`,
        [cleanProjectId])).rows.map(row => row.id) : [];
      const ids = selectedAudience === 'individual' ? [cleanTargetUserId] : recipients;
      if (ids.length) io.to(ids.map(id => `user:${id}`)).emit('new_notification', enrichedNotification);
    }

    return res.status(201).json({
      success: true,
      message: 'Notification sent successfully.',
      data: enrichedNotification
    });

  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    console.error('Create notification error:', error);

    return res.status(500).json({
      success: false,
      message: 'Failed to send notification.',
      error: error.message
    });
  }
};