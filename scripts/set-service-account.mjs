#!/usr/bin/env node
/**
 * Writes the Firebase service account into .env.local in the right format.
 *
 * Usage:
 *   1. Firebase console > Project settings > Service accounts >
 *      Generate new private key. A JSON file downloads.
 *   2. node scripts/set-service-account.mjs path/to/that-file.json
 *   3. Delete the JSON file, or keep it somewhere safe outside this folder.
 *
 * It sets FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY,
 * replacing any existing values, and leaves every other line alone. The key is
 * never printed. Runs locally and makes no network requests.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const [jsonPath, envPath = ".env.local"] = process.argv.slice(2);
if (!jsonPath) {
  console.error("Usage: node scripts/set-service-account.mjs <service-account.json> [.env.local]");
  process.exit(1);
}

let account;
try {
  account = JSON.parse(readFileSync(jsonPath, "utf8"));
} catch {
  console.error("That file could not be read as JSON. Use the file downloaded from the Firebase console.");
  process.exit(1);
}

const { project_id: projectId, client_email: clientEmail, private_key: privateKey } = account;
if (
  typeof projectId !== "string" ||
  typeof clientEmail !== "string" ||
  typeof privateKey !== "string" ||
  !privateKey.includes("BEGIN PRIVATE KEY")
) {
  console.error("This is not a service account key file: project_id, client_email or private_key is missing.");
  process.exit(1);
}

const values = {
  FIREBASE_PROJECT_ID: projectId,
  FIREBASE_CLIENT_EMAIL: clientEmail,
  // One line, with \n written out, in double quotes: the form lib/env/server.ts expects.
  FIREBASE_PRIVATE_KEY: `"${privateKey.replace(/\r?\n/g, "\\n")}"`,
};

const original = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
const eol = original.includes("\r\n") ? "\r\n" : "\n";
const lines = original.length > 0 ? original.split(/\r?\n/) : [];
const remaining = new Set(Object.keys(values));

const updated = lines.map((line) => {
  const key = /^([A-Z_]+)=/.exec(line)?.[1];
  if (!key || !(key in values)) return line;
  if (!remaining.has(key)) return null; // a duplicate of a key already written
  remaining.delete(key);
  return `${key}=${values[key]}`;
});
for (const key of remaining) updated.push(`${key}=${values[key]}`);

writeFileSync(envPath, updated.filter((line) => line !== null).join(eol).replace(/(\r?\n)*$/, eol));
console.log(`Updated ${envPath} for project ${projectId} (${clientEmail}).`);
console.log("The private key was written but not shown. Restart `npm run dev` to pick it up.");
