const fs = require('fs');
const path = require('path');
const {
  initializeApp,
  cert,
  getApps
} = require("firebase-admin/app");

const {
  getMessaging
} = require("firebase-admin/messaging");

const serviceAccountPath = path.join(__dirname, "firebase-service-account.json");

let messaging = null;

if (fs.existsSync(serviceAccountPath)) {
  try {
    const serviceAccount = require(serviceAccountPath);

    const firebaseApp =
      getApps().length === 0
        ? initializeApp({
            credential: cert(serviceAccount)
          })
        : getApps()[0];

    messaging = getMessaging(firebaseApp);
    console.log("Firebase Admin initialized successfully.");
  } catch (error) {
    console.warn("⚠️ Failed to initialize Firebase Admin:", error.message);
  }
} else {
  console.warn("⚠️ Warning: configuration/firebase-service-account.json not found. Push notifications will be disabled until it is added.");
  messaging = {
    send: async (msg) => {
      console.warn("⚠️ Firebase messaging.send called, but firebase-service-account.json is missing.");
      return "mock-message-id";
    }
  };
}

module.exports = messaging;