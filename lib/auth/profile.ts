import { doc, getDoc, serverTimestamp, setDoc } from "firebase/firestore";

import { getFirebaseServices } from "@/lib/firebase/client";

/**
 * Creates users/{uid} on first entry to the app. Runs only after the email is
 * verified, because security rules reject writes from unverified accounts.
 */
export async function ensureUserProfile(uid: string): Promise<void> {
  const { db } = getFirebaseServices();
  const ref = doc(db, "users", uid);
  const snapshot = await getDoc(ref);
  if (snapshot.exists()) return;
  await setDoc(ref, { createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
}
