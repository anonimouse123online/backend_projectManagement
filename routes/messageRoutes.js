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

    // PDFs
    'application/pdf',

    // Word
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',

    // Excel
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',

    // Plain text
    'text/plain'
  ];

  if (
    allowedMimeTypes.includes(
      file.mimetype
    )
  ) {

    cb(null, true);

  } else {

    cb(
      new Error(
        'Unsupported file type'
      ),
      false
    );
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


// Send image/file
router.post(
  '/upload',
  verifyToken,
  upload.single('file'),
  messageController.sendAttachment
);


module.exports = router;