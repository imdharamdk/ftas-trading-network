import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider } from "firebase/auth";

const firebaseConfig = {
  apiKey: String(import.meta.env.VITE_FIREBASE_API_KEY || "").trim(),
  authDomain: String(import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || "").trim(),
  projectId: String(import.meta.env.VITE_FIREBASE_PROJECT_ID || "").trim(),
  appId: String(import.meta.env.VITE_FIREBASE_APP_ID || "").trim(),
  messagingSenderId: String(import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || "").trim(),
};

const requiredFirebaseKeys = ["apiKey", "authDomain", "projectId", "appId"];
const isFirebaseConfigured = requiredFirebaseKeys.every((key) => Boolean(firebaseConfig[key]));

let auth = null;
let googleProvider = null;

function ensureFirebaseAuth() {
  if (!isFirebaseConfigured) {
    throw new Error("Google sign-in is not configured. Set the VITE_FIREBASE_* frontend environment variables.");
  }

  if (!auth || !googleProvider) {
    const app = initializeApp(firebaseConfig);
    auth = getAuth(app);
    googleProvider = new GoogleAuthProvider();
    googleProvider.setCustomParameters({ prompt: "select_account" });
  }

  return { auth, googleProvider };
}

export { ensureFirebaseAuth, isFirebaseConfigured };
