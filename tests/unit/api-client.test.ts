import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getIdToken = vi.fn(async (force?: boolean) => (force ? "fresh" : "cached"));
let currentUser: { getIdToken: typeof getIdToken } | null = { getIdToken };

vi.mock("@/lib/firebase/client", () => ({
  getFirebaseServices: () => ({ auth: { currentUser } }),
}));

import { authFetch, NotSignedInError } from "@/lib/auth/api-client";

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  currentUser = { getIdToken };
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  getIdToken.mockClear();
});

const bearer = (call: number) =>
  new Headers(fetchMock.mock.calls[call]?.[1]?.headers).get("Authorization");

describe("authFetch", () => {
  it("sends the cached token and returns a successful response", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const response = await authFetch("/api/session");
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(bearer(0)).toBe("Bearer cached");
  });

  it.each([401, 403])("retries once with a fresh token after %i", async (status) => {
    fetchMock
      .mockResolvedValueOnce(new Response("{}", { status }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const response = await authFetch("/api/session");
    expect(response.status).toBe(200);
    expect(bearer(1)).toBe("Bearer fresh");
  });

  it("does not loop when the fresh token is also rejected", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 401 }));
    const response = await authFetch("/api/session");
    expect(response.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("refuses non-API paths so the token never goes to another origin", async () => {
    await expect(authFetch("https://example.com/api/x")).rejects.toThrow(/only for \/api/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws when signed out", async () => {
    currentUser = null;
    await expect(authFetch("/api/session")).rejects.toThrow(NotSignedInError);
  });
});
