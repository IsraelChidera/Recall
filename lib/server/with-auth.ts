import "server-only";

import { parseAllowedEmails } from "@/lib/env/server";
import { getAdminAuth } from "@/lib/firebase/admin";

/** Identity taken from a verified Firebase ID token. Never from the request body. */
export type AuthContext = {
  uid: string;
  email: string | null;
  /** True when the address is on the ALLOWED_EMAILS list for AI analysis. */
  aiAllowed: boolean;
};

export type VerifiedToken = {
  uid: string;
  email?: string;
  email_verified?: boolean;
};

export type TokenVerifier = (idToken: string) => Promise<VerifiedToken>;

type Options = {
  /** Injected in tests. Defaults to the Admin SDK with revocation checking. */
  verify?: TokenVerifier;
  allowedEmails?: () => string[];
};

function json(status: number, error: string): Response {
  return Response.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

const defaultVerify: TokenVerifier = (idToken) =>
  getAdminAuth().verifyIdToken(idToken, true);

/**
 * Wraps a route handler so it only runs for a verified, email-confirmed user.
 *
 * The Admin SDK bypasses Firestore Security Rules, so this guard is the only
 * thing standing between a request and another user's data. Every handler
 * under app/api must be wrapped with it, and must build Firestore paths from
 * `auth.uid` alone. A unit test enforces the wrapping.
 */
export function withAuth<Context>(
  handler: (request: Request, auth: AuthContext, context: Context) => Promise<Response>,
  options: Options = {},
): (request: Request, context: Context) => Promise<Response> {
  const verify = options.verify ?? defaultVerify;
  const allowedEmails =
    options.allowedEmails ?? (() => parseAllowedEmails(process.env.ALLOWED_EMAILS));

  return async (request, context) => {
    const token = bearerToken(request);
    if (!token) return json(401, "Missing bearer token.");

    let decoded: VerifiedToken;
    try {
      decoded = await verify(token);
    } catch {
      // Expired, revoked, malformed or signed for another project. The reason
      // is deliberately not echoed back.
      return json(401, "Invalid or expired token.");
    }

    if (!decoded.uid) return json(401, "Invalid or expired token.");
    if (decoded.email_verified !== true) return json(403, "Email address is not verified.");

    const email = decoded.email?.toLowerCase() ?? null;
    const auth: AuthContext = {
      uid: decoded.uid,
      email,
      aiAllowed: email !== null && allowedEmails().includes(email),
    };

    return handler(request, auth, context);
  };
}
