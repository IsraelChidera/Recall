import { getApp, getApps, initializeApp, type FirebaseApp } from "firebase/app";
import { connectAuthEmulator, getAuth, type Auth } from "firebase/auth";
import {
  connectFirestoreEmulator,
  getFirestore,
  initializeFirestore,
  type Firestore,
} from "firebase/firestore";

import { getClientEnv } from "@/lib/env/client";

/**
 * Browser Firebase SDK. Initialised lazily so importing this module during
 * prerendering never touches the network or throws on missing configuration.
 */
let emulatorsConnected = false;

export function getFirebaseApp(): FirebaseApp {
  if (getApps().length > 0) return getApp();
  const env = getClientEnv();
  return initializeApp({
    apiKey: env.NEXT_PUBLIC_FIREBASE_API_KEY,
    authDomain: env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
    projectId: env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
    appId: env.NEXT_PUBLIC_FIREBASE_APP_ID,
    messagingSenderId: env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  });
}

export function getFirebaseServices(): { auth: Auth; db: Firestore } {
  const app = getFirebaseApp();
  const auth = getAuth(app);
  const useEmulators = getClientEnv().NEXT_PUBLIC_USE_FIREBASE_EMULATORS === "true";

  if (useEmulators && !emulatorsConnected) {
    // The emulator speaks HTTP/1.1, where a browser allows six connections
    // per host and the SDK's long-lived streams can hold several of them,
    // stalling other requests for tens of seconds. Short long-poll cycles
    // release connections quickly. Production keeps the SDK defaults.
    const db = initializeFirestore(app, {
      experimentalForceLongPolling: true,
      experimentalLongPollingOptions: { timeoutSeconds: 5 },
    });
    connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
    connectFirestoreEmulator(db, "127.0.0.1", 8080);
    emulatorsConnected = true;
    return { auth, db };
  }

  return { auth, db: getFirestore(app) };
}
