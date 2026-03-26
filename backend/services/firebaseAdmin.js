const admin = require("firebase-admin");

let app = null;

function getPrivateKey() {
  return String(process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
}

function getFirebaseAdminApp() {
  if (app) return app;

  const projectId = String(process.env.FIREBASE_PROJECT_ID || "").trim();
  const clientEmail = String(process.env.FIREBASE_CLIENT_EMAIL || "").trim();
  const privateKey = getPrivateKey();

  if (!projectId || !clientEmail || !privateKey) {
    throw new Error("Firebase Admin credentials are not configured");
  }

  app = admin.apps[0] || admin.initializeApp({
    credential: admin.credential.cert({
      projectId,
      clientEmail,
      privateKey,
    }),
  });

  return app;
}

async function verifyFirebaseIdToken(idToken) {
  const firebaseApp = getFirebaseAdminApp();
  return firebaseApp.auth().verifyIdToken(idToken);
}

module.exports = {
  verifyFirebaseIdToken,
};
