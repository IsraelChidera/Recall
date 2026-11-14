import "server-only";

const SEGMENT = /^[A-Za-z0-9_-]{1,128}$/;

export class InvalidPathError extends Error {
  constructor() {
    super("Invalid document identifier.");
    this.name = "InvalidPathError";
  }
}

/**
 * Builds a Firestore document path inside the authenticated user's space.
 *
 * `uid` must come from `withAuth`. Identifiers supplied by a client are
 * validated so they can never contain a slash or traverse to another user.
 */
export function userDocPath(uid: string, ...segments: string[]): string {
  if (!SEGMENT.test(uid) || segments.length % 2 !== 0) throw new InvalidPathError();
  for (const segment of segments) {
    if (!SEGMENT.test(segment)) throw new InvalidPathError();
  }
  return ["users", uid, ...segments].join("/");
}
