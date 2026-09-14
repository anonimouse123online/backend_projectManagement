let messaging = null;

try {
  const {
    initializeApp,
    cert,
    getApps
  } = require("firebase-admin/app");

  const {
    getMessaging
  } = require("firebase-admin/messaging");

  const serviceAccount =
    require("./firebase-service-account.json");

  const firebaseApp =
    getApps().length === 0
      ? initializeApp({
          credential: cert(serviceAccount)
        })
      : getApps()[0];

  messaging = getMessaging(firebaseApp);
  console.log("[Firebase] Admin SDK initialized successfully.");
} catch (err) {
  console.warn("[Firebase] Could not initialize Admin SDK:", err.message);
  console.warn("[Firebase] Push notifications will be disabled.");
}

module.exports = messaging;