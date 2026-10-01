const express = require('express');
const router = express.Router();

const multer = require('multer');
const path = require('path');
const fs = require('fs');

const messageController =
  require('../controllers/messageController');

const { verifyToken } =
  require('../middlewares/authMiddleware');


// ============================================================
// UPLOAD FOLDER
// ============================================================

const uploadDirectory =
  path.join(
    __dirname,
    '..',
    'uploads',
    'messages'
  );

if (!fs.existsSync(uploadDirectory)) {

  fs.mkdirSync(
    uploadDirectory,
    {
      recursive: true
    }
  );
}


// ============================================================
// MULTER STORAGE
// ============================================================

const storage = multer.diskStorage({

  destination: (
    req,
    file,
    cb
  ) => {

    cb(
      null,
      uploadDirectory
    );
  },

  filename: (
    req,
    file,
    cb
  ) => {

    const uniqueName =
      `${Date.now()}-${Math.round(
        Math.random() * 1e9
      )}`;

    const extension =
      path.extname(
        file.originalname
      );

    cb(
      null,
      `${uniqueName}${extension}`
    );
  }
});


// ============================================================
// FILE FILTER
// ============================================================

const fileFilter = (
  req,
  file,
  cb
) => {

  const allowedMimeTypes = [
    // Images
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/gif',
    'image/svg+xml',

    // Documents
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/csv',
    'text/plain',

    // Archives
    'application/zip',
    'application/x-zip-compressed',
    'application/x-rar-compressed',

    // CAD / DWG / binary
    'application/octet-stream',
    'image/vnd.dwg',
    'application/acad',
    'application/x-acad',
    'application/autocad_dwg'
  ];

  if (
    allowedMimeTypes.includes(file.mimetype) ||
    file.originalname.match(/\.(jpg|jpeg|png|webp|gif|svg|pdf|doc|docx|xls|xlsx|csv|txt|zip|rar|dwg)$/i)
  ) {
    cb(null, true);
  } else {
    cb(new Error('Unsupported file type. Please upload a standard image or document.'), false);
  }
};


const upload = multer({

  storage,

  fileFilter,

  limits: {

    // 10 MB
    fileSize:
      10 * 1024 * 1024
  }
});


// ============================================================
// ROUTES
// ============================================================

// Get conversation list
console.log('verifyToken:', typeof verifyToken);
console.log('getConversations:', typeof messageController.getConversations);
router.get(
  '/conversations',
  verifyToken,
  messageController.getConversations
);


// Create/open conversation
router.post(
  '/conversations',
  verifyToken,
  messageController.createConversation
);


// Get messages
router.get(
  '/conversations/:conversationId',
  verifyToken,
  messageController.getMessages
);


// Get conversation members
router.get(
  '/conversations/:conversationId/members',
  verifyToken,
  messageController.getConversationMembers
);


// Mark read
router.put(
  '/conversations/:conversationId/read',
  verifyToken,
  messageController.markAsRead
);


// Send normal text message
router.post(
  '/',
  verifyToken,
  messageController.sendMessage
);


const handleUpload = (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      console.error('MULTER ERROR:', err);
      return res.status(400).json({
        success: false,
        message: err.message || 'File upload error'
      });
    }
    next();
  });
};

// Send image/file
router.post(
  '/upload',
  verifyToken,
  handleUpload,
  messageController.sendAttachment
);

module.exports = router;