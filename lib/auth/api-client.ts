import { getFirebaseServices } from "@/lib/firebase/client";

export class NotSignedInError extends Error {
  constructor() {
    super("You are signed out.");
    this.name = "NotSignedInError";
  }
}

/**
 * fetch() for Recall's own API routes. Attaches the current Firebase ID token
 * as a bearer header.
 *
 * A cached token can be stale in ways the server rejects: expired, or issued
 * before the user confirmed their email. On 401 or 403 the request is retried
 * once with a freshly minted token.
 */
export async function authFetch(path: string, init: RequestInit = {}): Promise<Response> {
  if (!path.startsWith("/api/")) throw new Error("authFetch is only for /api routes.");
  const user = getFirebaseServices().auth.currentUser;
  if (!user) throw new NotSignedInError();

  const send = async (forceRefresh: boolean) => {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${await user.getIdToken(forceRefresh)}`);
    return fetch(path, { ...init, headers });
  };

  const response = await send(false);
  if (response.status !== 401 && response.status !== 403) return response;
  return send(true);
}
