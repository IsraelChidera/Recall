import "server-only";

import { cert, getApp, getApps, initializeApp, type App } from "firebase-admin/app";
import { getAuth, type Auth } from "firebase-admin/auth";
import { getFirestore, type Firestore } from "firebase-admin/firestore";

import { getServerEnv } from "@/lib/env/server";

/**
 * Firebase Admin SDK. It bypasses Firestore Security Rules, so every caller
 * must first verify the request's ID token and build paths from that uid only.
 * The `withAuth` guard in lib/server/with-auth.ts enforces this for every API route.
 */
function getAdminApp(): App {
  if (getApps().length > 0) return getApp();

  // Local development against the Emulator Suite needs no credentials. The
  // Admin SDK routes to the emulators when these variables are set.
  if (process.env.FIREBASE_AUTH_EMULATOR_HOST || process.env.FIRESTORE_EMULATOR_HOST) {
    if (process.env.NODE_ENV === "production" && process.env.VERCEL) {
      throw new Error("Emulator variables must not be set on a deployed environment.");
    }
    return initializeApp({
      projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ?? "demo-recall",
    });
  }

  const env = getServerEnv();
  return initializeApp({
    credential: cert({
      projectId: env.FIREBASE_PROJECT_ID,
      clientEmail: env.FIREBASE_CLIENT_EMAIL,
      privateKey: env.FIREBASE_PRIVATE_KEY,
    }),
  });
}

export function getAdminAuth(): Auth {
  return getAuth(getAdminApp());
}

export function getAdminDb(): Firestore {
  return getFirestore(getAdminApp());
}
