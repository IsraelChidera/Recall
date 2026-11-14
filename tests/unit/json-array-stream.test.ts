import { describe, expect, it } from "vitest";

import { JsonArrayElementSplitter, JsonArrayStreamError } from "@/lib/import/json-array-stream";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Splits `json` into chunks of `size` bytes and returns the parsed elements. */
function split(json: string, size: number): unknown[] {
  const bytes = encoder.encode(json);
  const splitter = new JsonArrayElementSplitter();
  const out: unknown[] = [];
  for (let offset = 0; offset < bytes.length; offset += size) {
    for (const element of splitter.push(bytes.slice(offset, offset + size))) {
      out.push(JSON.parse(decoder.decode(element)));
    }
  }
  splitter.end();
  return out;
}

const tricky = [
  { text: 'brackets ] [ } { and "quotes" and \\ backslash', n: 1 },
  { nested: { list: [1, [2, [3, { deep: "]}" }]]] }, empty: {}, none: [] },
  { unicode: "naïve — 日本語 — 🧠 emoji — é", escaped: "line\nbreak\ttab é \\\" end\\" },
  "a plain string with , and ] inside",
  42,
  -1.5e3,
  true,
  null,
  [],
  {},
];

describe("JsonArrayElementSplitter", () => {
  it.each([1, 2, 3, 5, 7, 16, 64, 4096])(
    "returns every element intact at chunk size %i",
    (size) => {
      expect(split(JSON.stringify(tricky), size)).toEqual(tricky);
      expect(split(JSON.stringify(tricky, null, 2), size)).toEqual(tricky);
    },
  );

  it("handles an empty array and surrounding whitespace", () => {
    expect(split("[]", 1)).toEqual([]);
    expect(split(" \n[ \n ]\n ", 2)).toEqual([]);
  });

  it("tolerates a byte order mark", () => {
    expect(split("﻿[1,2]", 1)).toEqual([1, 2]);
  });

  it("buffers one element at a time, not the whole document", () => {
    const element = { text: "x".repeat(1_000) };
    const bytes = encoder.encode(JSON.stringify(Array.from({ length: 500 }, () => element)));
    const splitter = new JsonArrayElementSplitter();
    let count = 0;
    for (let offset = 0; offset < bytes.length; offset += 8_192) {
      count += splitter.push(bytes.slice(offset, offset + 8_192)).length;
    }
    splitter.end();
    expect(count).toBe(500);
    expect(bytes.length).toBeGreaterThan(500_000);
    expect(splitter.peakBufferedBytes).toBeLessThan(2_000);
  });

  it("rejects a document whose root is not an array", () => {
    expect(() => split('{"a":1}', 4)).toThrow(JsonArrayStreamError);
  });

  it("rejects a truncated document", () => {
    expect(() => split('[{"a":1},{"b":', 4)).toThrow(/ended before/);
    expect(() => split("", 4)).toThrow(/empty/);
  });

  it("rejects content after the array", () => {
    expect(() => split("[1] x", 2)).toThrow(/after the end/);
  });

  it("enforces the per-element size limit", () => {
    const splitter = new JsonArrayElementSplitter(100);
    expect(() => splitter.push(encoder.encode(`["${"x".repeat(500)}"]`))).toThrow(/size limit/);
  });
});
