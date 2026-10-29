const path = require('node:path');
const { verifyToken } = require('./authMiddleware');

// Protect only project documents/issue images before the existing static server.
// Normalize encoded directory names and dot segments exactly as file serving does.
module.exports = function projectFileAccess(req, res, next) {
  let effectivePath;
  try { effectivePath = path.posix.normalize(decodeURIComponent(req.path).replaceAll('\\', '/')); }
  catch { return res.status(400).json({ success: false, message: 'Invalid file URL.' }); }
  const folder = effectivePath.split('/')[1]?.toLowerCase();
  if (!['documents', 'issues', 'tasks', 'messages', 'project-reports'].includes(folder)) return res.status(404).json({ error: 'File not found.' });
  const segments = effectivePath.split('/');
  segments[1] = folder;
  req.projectFilePath = '/uploads' + segments.map(encodeURIComponent).join('/');
  return verifyToken(req, res, () => {
    if (folder === 'tasks') {
      req.params.id = segments[2];
      return require('./projectAccess').task()(req, res, next);
    }
    if (folder === 'messages') {
      return require('./projectAccess').guard(async () => {
        const { rows } = await require('../db').query(`SELECT 1 FROM message_attachments a
          JOIN messages m ON m.id = a.message_id
          JOIN conversation_members cm ON cm.conversation_id = m.conversation_id
          WHERE a.file_path = $1 AND cm.user_id = $2::uuid`, [decodeURIComponent(req.projectFilePath), req.user.id]);
        if (!rows.length) throw new (require('../services/projectAccessService').AccessError)(404, 'File not found.');
      })(req, res, next);
    }
    if (folder === 'project-reports') {
      req.params.code = segments[2];
      return require('./projectAccess').project()(req, res, next);
    }
    const authorize = folder === 'documents'
      ? require('../controllers/projectController').authorizeDocumentFile
      : require('../controllers/issuesController').authorizeIssueImage;
    return authorize(req, res, next);
  });
};
