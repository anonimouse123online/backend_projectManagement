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


const messaging =
  getMessaging(firebaseApp);


module.exports = messaging;