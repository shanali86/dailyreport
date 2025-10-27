import admin from "firebase-admin";
import fs from "fs";

// Read serviceAccount.json manually
const serviceAccount = JSON.parse(
  fs.readFileSync(new URL("./serviceAccount.json", import.meta.url))
);

// Initialize Firebase admin SDK
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

export const db = admin.firestore();

console.log("🔥 Firebase connected successfully!");
