import { describe, expect, it } from "vitest";

import { EnvError, parseClientEnv } from "@/lib/env/client";
import { parseAllowedEmails, parseServerEnv } from "@/lib/env/server";

const validClient = {
  NEXT_PUBLIC_FIREBASE_API_KEY: "key",
  NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: "demo.firebaseapp.com",
  NEXT_PUBLIC_FIREBASE_PROJECT_ID: "demo",
  NEXT_PUBLIC_FIREBASE_APP_ID: "1:1:web:1",
};

const validServer = {
  FIREBASE_PROJECT_ID: "demo",
  FIREBASE_CLIENT_EMAIL: "svc@demo.iam.gserviceaccount.com",
  FIREBASE_PRIVATE_KEY: "line1\\nline2",
};

describe("client env", () => {
  it("accepts a complete configuration", () => {
    expect(parseClientEnv(validClient).NEXT_PUBLIC_FIREBASE_PROJECT_ID).toBe("demo");
  });

  it("names every missing variable", () => {
    const attempt = () =>
      parseClientEnv({ ...validClient, NEXT_PUBLIC_FIREBASE_API_KEY: undefined, NEXT_PUBLIC_FIREBASE_APP_ID: "" });
    expect(attempt).toThrow(EnvError);
    expect(attempt).toThrow(/NEXT_PUBLIC_FIREBASE_API_KEY/);
    expect(attempt).toThrow(/NEXT_PUBLIC_FIREBASE_APP_ID/);
  });

  it("rejects an emulator flag that is not true or false", () => {
    expect(() =>
      parseClientEnv({ ...validClient, NEXT_PUBLIC_USE_FIREBASE_EMULATORS: "yes" }),
    ).toThrow(EnvError);
  });
});

describe("server env", () => {
  it("restores newlines in the private key", () => {
    expect(parseServerEnv(validServer).FIREBASE_PRIVATE_KEY).toBe("line1\nline2");
  });

  it("allows the Gemini key to be absent before Milestone 6", () => {
    expect(parseServerEnv(validServer).GEMINI_API_KEY).toBeUndefined();
  });

  it("fails without service account credentials", () => {
    expect(() => parseServerEnv({ ...validServer, FIREBASE_PRIVATE_KEY: undefined })).toThrow(
      /FIREBASE_PRIVATE_KEY/,
    );
  });
});

describe("allowed emails", () => {
  it("normalises and drops blanks", () => {
    expect(parseAllowedEmails(" A@x.com, ,b@y.com ")).toEqual(["a@x.com", "b@y.com"]);
  });

  it("is empty when unset, so nobody is allowed by default", () => {
    expect(parseAllowedEmails(undefined)).toEqual([]);
  });
});
