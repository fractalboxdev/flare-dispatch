// The secret, URL and encoded-run scans of the staged-write gate (FD-AGT-029 to FD-AGT-033). Each scan answers where it
// matched and never the matched value.

/** Credential patterns of FD-AGT-029, each with the name a reason reports. */
const CREDENTIAL_PATTERNS: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  { name: "github-token", pattern: /\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{20,}/ },
  { name: "github-token", pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/ },
  { name: "aws-access-key-id", pattern: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/ },
  { name: "private-key", pattern: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/ },
  { name: "slack-token", pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/ },
  {
    name: "json-web-token",
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  },
];

/** The shortest issued credential the scan looks for verbatim; shorter strings match ordinary text. */
const MIN_ISSUED_LENGTH = 8;

/** The name of the first credential pattern the line matches, or null. */
export const credentialIn = (line: string, issued: readonly string[]): string | null => {
  for (const { name, pattern } of CREDENTIAL_PATTERNS) if (pattern.test(line)) return name;
  for (const credential of issued)
    if (credential.length >= MIN_ISSUED_LENGTH && line.includes(credential))
      return "issued-credential";
  return null;
};

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"'`)\]]+/gi;

/** The lower-cased host of every `http` or `https` URL in the text; a URL that does not parse yields `""`. */
export const urlHostsIn = (text: string): readonly string[] =>
  [...text.matchAll(URL_PATTERN)].map((m) => {
    try {
      return new URL(m[0]).hostname.toLowerCase();
    } catch {
      return "";
    }
  });

/**
 * A host is allowed when it is in the link allowlist, compared lower-cased (FD-AGT-031, FD-AGT-032); a subdomain of an
 * allowlisted host is not, and an empty entry admits no host.
 */
export const hostAllowed = (host: string, allowlist: readonly string[]): boolean =>
  host !== "" && allowlist.some((entry) => entry.toLowerCase() === host);

/** A run of at least 64 base64 or hexadecimal characters (FD-AGT-033). */
const ENCODED_RUN = /[A-Za-z0-9+/_-]{64,}/;

export const hasEncodedRun = (text: string): boolean => ENCODED_RUN.test(text);

export const linesOf = (text: string): readonly string[] => text.split(/\r?\n/);

/**
 * The lines of `next` that `base` does not hold, as 1-based line numbers, counting repeats: a line that appears more
 * often in `next` than in `base` counts as added for each extra occurrence.
 */
export const addedLines = (
  next: string,
  base: string | null,
): readonly { readonly line: number; readonly text: string }[] => {
  const remaining = new Map<string, number>();
  for (const line of base === null ? [] : linesOf(base))
    remaining.set(line, (remaining.get(line) ?? 0) + 1);
  const added: { line: number; text: string }[] = [];
  linesOf(next).forEach((text, index) => {
    const left = remaining.get(text) ?? 0;
    if (left > 0) remaining.set(text, left - 1);
    else added.push({ line: index + 1, text });
  });
  return added;
};
