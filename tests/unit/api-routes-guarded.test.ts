import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return routeFiles(path);
    return /^route\.tsx?$/.test(name) ? [path] : [];
  });
}

/**
 * The Admin SDK bypasses Firestore rules, so an unguarded route is a hole.
 * Every exported HTTP method in app/api must be assigned from withAuth(...).
 */
describe("API routes", () => {
  const files = routeFiles("app/api");

  it("finds at least one route to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)("%s wraps every handler in withAuth", (file) => {
    const source = readFileSync(file, "utf8");
    const exported = METHODS.filter((method) =>
      new RegExp(`export\\s+(?:const|async\\s+function|function)\\s+${method}\\b`).test(source),
    );
    expect(exported.length).toBeGreaterThan(0);
    for (const method of exported) {
      expect(source, `${method} in ${file}`).toMatch(
        new RegExp(`export\\s+const\\s+${method}\\s*=\\s*withAuth\\(`),
      );
    }
  });
});
