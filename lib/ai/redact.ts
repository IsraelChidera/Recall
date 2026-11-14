/**
 * Removes obvious identifiers and secrets before any text is sent to an AI
 * provider. This reduces exposure; it does not make text anonymous. Names,
 * places and the substance of a conversation are still sent.
 */
const RULES: ReadonlyArray<readonly [RegExp, string]> = [
  // Private key blocks.
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[secret]"],
  // Credentials embedded in URLs: scheme://user:password@host
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, "$1[secret]@"],
  // Well-known token shapes.
  [/\b(?:sk|pk|rk)[-_](?:live|test|proj|ant)?[-_]?[A-Za-z0-9_-]{16,}\b/g, "[secret]"],
  [/\bAIza[0-9A-Za-z_-]{30,}\b/g, "[secret]"],
  [/\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/g, "[secret]"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, "[secret]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[secret]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[secret]"],
  // key=value style secrets.
  [
    /\b((?:api[_-]?key|secret|token|password|passwd|pwd|private[_-]?key)\s*[:=]\s*)["']?[^\s"',;]{6,}["']?/gi,
    "$1[secret]",
  ],
  // Email addresses.
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[email]"],
  // Long opaque strings (keys, hashes). UUIDs are shorter and keep their hyphens.
  [/\b[A-Za-z0-9_+/=-]{40,}\b/g, "[secret]"],
  // Card-like numbers: 13 to 19 digits, optionally grouped.
  [/(?<![\w.-])(?:\d[ -]?){12,18}\d(?![\w-])/g, "[number]"],
  // Any other run of nine or more digits (account numbers, ids).
  [/(?<![\w.])\d{9,}(?![\w])/g, "[number]"],
  // Phone numbers: country or area code, then two or three groups.
  [/(?<![\w.])\+?\d{1,3}[\s.-]?\(?\d{2,4}\)?[\s.-]?\d{3,4}[\s.-]?\d{3,4}(?![\w-])/g, "[number]"],
];

export function redact(text: string): string {
  let result = text;
  for (const [pattern, replacement] of RULES) result = result.replace(pattern, replacement);
  return result;
}
