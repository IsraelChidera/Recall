import { describe, expect, it } from "vitest";

import { authErrorMessage, passwordProblem } from "@/lib/auth/errors";

describe("auth error messages", () => {
  it("gives the same message for unknown user and wrong password", () => {
    const unknownUser = authErrorMessage({ code: "auth/user-not-found" });
    const wrongPassword = authErrorMessage({ code: "auth/wrong-password" });
    const invalid = authErrorMessage({ code: "auth/invalid-credential" });
    expect(unknownUser).toBe(wrongPassword);
    expect(wrongPassword).toBe(invalid);
  });

  it("falls back to a generic message and never echoes raw errors", () => {
    expect(authErrorMessage(new Error("internal detail"))).toBe(
      "Something went wrong. Please try again.",
    );
    expect(authErrorMessage({ code: "auth/something-new" })).not.toMatch(/auth\//);
  });
});

describe("password policy", () => {
  it("requires at least 10 characters", () => {
    expect(passwordProblem("short")).toMatch(/10/);
    expect(passwordProblem("long-enough-password")).toBeNull();
  });
});
