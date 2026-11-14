import { describe, expect, it, vi } from "vitest";

import { withAuth, type TokenVerifier } from "@/lib/server/with-auth";

vi.mock("@/lib/firebase/admin", () => ({
  getAdminAuth: () => {
    throw new Error("The Admin SDK must not be reached in unit tests.");
  },
}));

const okVerifier: TokenVerifier = async (token) => {
  if (token === "alice-token") {
    return { uid: "alice", email: "Alice@Example.com", email_verified: true };
  }
  if (token === "unverified-token") {
    return { uid: "carol", email: "carol@example.com", email_verified: false };
  }
  throw new Error("auth/id-token-expired");
};

function guarded(allowed: string[] = []) {
  const handler = vi.fn(async (_request: Request, auth: { uid: string; aiAllowed: boolean }) =>
    Response.json({ uid: auth.uid, aiAllowed: auth.aiAllowed }),
  );
  const route = withAuth(handler, { verify: okVerifier, allowedEmails: () => allowed });
  return { handler, route };
}

function request(headers: Record<string, string> = {}, body?: unknown): Request {
  return new Request("https://recall.test/api/session", {
    method: body ? "POST" : "GET",
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe("withAuth", () => {
  it("rejects a request with no token", async () => {
    const { handler, route } = guarded();
    const response = await route(request(), undefined);
    expect(response.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it.each(["alice-token", "Basic alice-token", "Bearer", "Bearer a b"])(
    "rejects a malformed Authorization header: %s",
    async (value) => {
      const { handler, route } = guarded();
      const response = await route(request({ Authorization: value }), undefined);
      expect(response.status).toBe(401);
      expect(handler).not.toHaveBeenCalled();
    },
  );

  it("rejects an expired or invalid token without leaking the reason", async () => {
    const { handler, route } = guarded();
    const response = await route(request({ Authorization: "Bearer expired" }), undefined);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Invalid or expired token." });
    expect(handler).not.toHaveBeenCalled();
  });

  it("rejects an account whose email is not verified", async () => {
    const { handler, route } = guarded();
    const response = await route(
      request({ Authorization: "Bearer unverified-token" }),
      undefined,
    );
    expect(response.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
  });

  it("passes the uid from the token to the handler", async () => {
    const { route } = guarded();
    const response = await route(request({ Authorization: "Bearer alice-token" }), undefined);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ uid: "alice", aiAllowed: false });
  });

  it("ignores a user id supplied by the client", async () => {
    const { handler, route } = guarded();
    await route(
      request(
        { Authorization: "Bearer alice-token", "x-user-id": "bob", "content-type": "application/json" },
        { uid: "bob", userId: "bob" },
      ),
      undefined,
    );
    expect(handler.mock.calls[0]?.[1]).toMatchObject({ uid: "alice" });
  });

  it("admits every verified account when the allowlist is *", async () => {
    const open = guarded(["*"]);
    const response = await open.route(request({ Authorization: "Bearer alice-token" }), undefined);
    expect(await response.json()).toMatchObject({ aiAllowed: true });
    const unverified = await open.route(request({ Authorization: "Bearer unverified-token" }), undefined);
    expect(unverified.status).toBe(403);
  });

  it("matches the AI allowlist case-insensitively and denies by default", async () => {
    const allowed = guarded(["alice@example.com"]);
    const yes = await allowed.route(request({ Authorization: "Bearer alice-token" }), undefined);
    expect(await yes.json()).toMatchObject({ aiAllowed: true });

    const empty = guarded([]);
    const no = await empty.route(request({ Authorization: "Bearer alice-token" }), undefined);
    expect(await no.json()).toMatchObject({ aiAllowed: false });
  });
});
