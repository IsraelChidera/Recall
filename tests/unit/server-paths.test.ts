import { describe, expect, it } from "vitest";

import { InvalidPathError, userDocPath } from "@/lib/server/paths";

describe("userDocPath", () => {
  it("builds paths inside the user's own space", () => {
    expect(userDocPath("alice")).toBe("users/alice");
    expect(userDocPath("alice", "tasks", "t1")).toBe("users/alice/tasks/t1");
  });

  it.each([
    ["a slash in an id", ["tasks", "t1/../../bob"]],
    ["a parent traversal", ["tasks", ".."]],
    ["an empty id", ["tasks", ""]],
    ["an odd number of segments", ["tasks"]],
    ["an oversize id", ["tasks", "x".repeat(129)]],
  ])("rejects %s", (_label, segments) => {
    expect(() => userDocPath("alice", ...segments)).toThrow(InvalidPathError);
  });

  it("rejects a malformed uid", () => {
    expect(() => userDocPath("alice/tasks", "tasks", "t1")).toThrow(InvalidPathError);
    expect(() => userDocPath("")).toThrow(InvalidPathError);
  });
});
