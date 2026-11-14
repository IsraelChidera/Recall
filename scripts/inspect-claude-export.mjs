#!/usr/bin/env node
/**
 * Prints the STRUCTURE of a Claude data export. It never prints message text.
 *
 * Usage:
 *   1. Download every ZIP from the export (conversations-000.zip,
 *      projects-000.zip, ...) and unzip each into its own subfolder of one
 *      parent folder.
 *   2. node scripts/inspect-claude-export.mjs /path/to/unzipped-folder
 *   3. Share the output. Review it first: it contains key names, value types,
 *      counts and lengths only.
 *
 * What is printed for each JSON path:
 *   - how often it appears, and the value types seen
 *   - string lengths (min / avg / max) and detected format (uuid, datetime, url)
 *   - array lengths (min / avg / max)
 *   - nothing inside tool-call `input` objects beyond the fact they exist
 *   - actual values ONLY for a fixed list of structural keys such as `sender`
 *     and `type`, and only when they are short and few.
 *
 * No dependencies. Runs entirely on your machine. Makes no network requests.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";

/** Keys whose values describe structure, not content. */
const STRUCTURAL_KEYS = new Set(["sender", "type", "role", "platform", "file_type", "file_kind"]);
/** Free-form subtrees (tool arguments) whose key names could reveal content. */
const OPAQUE_KEYS = new Set(["input"]);
const MAX_PATHS = 400;
const MAX_DISTINCT = 15;
const MAX_VALUE_LENGTH = 40;
const MAX_PARSE_BYTES = 450 * 1024 * 1024;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
const URL_LIKE = /^https?:\/\//i;

function stringFormat(value) {
  if (value.length === 0) return "empty";
  if (UUID.test(value)) return "uuid";
  if (DATETIME.test(value)) return "datetime";
  if (URL_LIKE.test(value)) return "url";
  return "text";
}

function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function newStat() {
  return {
    count: 0,
    types: new Map(),
    formats: new Map(),
    strLen: { min: Infinity, max: 0, sum: 0, n: 0 },
    arrLen: { min: Infinity, max: 0, sum: 0, n: 0 },
    values: new Set(),
    valuesOverflow: false,
  };
}

function bump(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function track(range, length) {
  range.min = Math.min(range.min, length);
  range.max = Math.max(range.max, length);
  range.sum += length;
  range.n += 1;
}

function walk(value, path, key, stats) {
  let stat = stats.get(path);
  if (!stat) {
    // Objects with unbounded dynamic keys would flood the report and could
    // leak content through key names, so new paths stop at a fixed ceiling.
    if (stats.size >= MAX_PATHS) {
      stats.truncated = true;
      return;
    }
    stat = newStat();
    stats.set(path, stat);
  }
  stat.count += 1;
  const type = typeOf(value);
  bump(stat.types, type);

  if (type === "string") {
    track(stat.strLen, value.length);
    bump(stat.formats, stringFormat(value));
    if (STRUCTURAL_KEYS.has(key) && value.length <= MAX_VALUE_LENGTH && !stat.valuesOverflow) {
      stat.values.add(value);
      if (stat.values.size > MAX_DISTINCT) {
        stat.values.clear();
        stat.valuesOverflow = true;
      }
    }
  } else if (type === "array") {
    track(stat.arrLen, value.length);
    for (const item of value) walk(item, `${path}[]`, key, stats);
  } else if (type === "object" && !OPAQUE_KEYS.has(key)) {
    for (const [childKey, child] of Object.entries(value)) {
      walk(child, `${path}.${childKey}`, childKey, stats);
    }
  }
}

function fmtMap(map) {
  return [...map.entries()].map(([name, n]) => `${name}×${n}`).join(", ");
}

function fmtRange(range) {
  if (range.n === 0) return "";
  return `min ${range.min} / avg ${Math.round(range.sum / range.n)} / max ${range.max}`;
}

function report(file, stats) {
  for (const path of [...stats.keys()].sort()) {
    const stat = stats.get(path);
    const parts = [`count ${stat.count}`, `types: ${fmtMap(stat.types)}`];
    if (stat.strLen.n > 0) {
      parts.push(`string length: ${fmtRange(stat.strLen)}`);
      parts.push(`formats: ${fmtMap(stat.formats)}`);
    }
    if (stat.arrLen.n > 0) parts.push(`array length: ${fmtRange(stat.arrLen)}`);
    if (stat.values.size > 0) parts.push(`values: ${[...stat.values].sort().join(" | ")}`);
    console.log(`  ${path.replace("$", file)}\n      ${parts.join("; ")}`);
  }
}

function listFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? listFiles(path) : [path];
  });
}

function main() {
  const target = process.argv[2];
  if (!target) {
    console.error("Usage: node scripts/inspect-claude-export.mjs <folder containing the unzipped export>");
    process.exit(1);
  }

  // The export arrives as several ZIPs (conversations-000.zip, projects-000.zip
  // and so on). Unzip them all under one folder; subfolders are walked.
  const files = statSync(target).isDirectory() ? listFiles(target) : [target];

  console.log("Claude export structure report (no message text)\n");
  console.log("Files:");
  for (const file of files) {
    const size = statSync(file).size;
    console.log(`  ${relative(target, file) || basename(file)}  ${(size / 1024 / 1024).toFixed(2)} MB`);
  }

  for (const file of files.filter((name) => name.toLowerCase().endsWith(".json"))) {
    const name = relative(target, file) || basename(file);
    const size = statSync(file).size;
    console.log(`\n== ${name} ==`);
    if (size > MAX_PARSE_BYTES) {
      console.log(`  Skipped: ${(size / 1024 / 1024).toFixed(0)} MB is too large to parse in one piece. Report this size.`);
      continue;
    }
    let data;
    try {
      data = JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
      console.log(`  Could not parse as JSON: ${error instanceof Error ? error.name : "error"}`);
      continue;
    }
    const stats = new Map();
    walk(data, "$", "", stats);
    report(name, stats);
    if (stats.truncated) {
      console.log(`  Note: more than ${MAX_PATHS} distinct paths; the rest were not recorded.`);
    }
  }
}

main();
