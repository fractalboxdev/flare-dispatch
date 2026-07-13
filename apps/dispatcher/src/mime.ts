// FlareDispatch Dispatcher — a small, dependency-free MIME extractor.
//
// The inbound Cloudflare Email Routing `email()` handler (routes/email-handler.ts)
// buffers the raw RFC 5322 message and needs the plain-text body (and, for the
// crude single-part HTML case, the stripped text) so `waitForOtp` can extract an
// OTP code / magic link. We deliberately AVOID `postal-mime` (or any npm MIME
// lib): the dispatcher Worker is built without a network install step in CI, and
// the surface we need — headers + transfer-encoding + multipart split — is small
// enough to do by hand. The bar is "good enough to find a 6-digit code or a link
// in the providers we target", not a conformant RFC 2045 parser.
//
// Hard invariant: malformed input MUST NOT throw — every entry point returns a
// best-effort `{ text }` instead. A thrown parse on the email path is worse than
// a degraded extraction (CF's behaviour on a thrown `email()` is undocumented).

/** What a parsed message yields. `text` is always present (possibly empty). */
export interface ParsedEmail {
  readonly subject?: string;
  /** Plain-text body, transfer-decoded. The OTP code / link is read from this. */
  text: string;
  /** HTML body, when a `text/html` part exists. Stored NOWHERE — see handler. */
  html?: string;
}

/** Decode an `ArrayBuffer | Uint8Array | string` to a JS string. UTF-8 first;
 * on any decode error, fall back to latin1 (1:1 byte→codepoint) so we never
 * throw on non-UTF-8 input (legacy `Content-Transfer-Encoding: 8bit` mail). */
const decodeBytes = (raw: ArrayBuffer | Uint8Array | string): string => {
  if (typeof raw === "string") return raw;
  const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  try {
    return new TextDecoder("utf-8").decode(bytes);
  } catch {
    try {
      return new TextDecoder("latin1").decode(bytes);
    } catch {
      // Last resort: byte-by-byte latin1.
      let out = "";
      for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]!);
      return out;
    }
  }
};

/** Split a raw message/part into [headerBlock, body] at the first blank line.
 * Handles both CRLF and LF line endings. No blank line → all headers, empty
 * body (degenerate, but defensive). */
const splitHeadersBody = (raw: string): [string, string] => {
  const crlf = raw.indexOf("\r\n\r\n");
  const lf = raw.indexOf("\n\n");
  // Pick the earliest separator that exists.
  let idx = -1;
  let sepLen = 0;
  if (crlf !== -1 && (lf === -1 || crlf <= lf)) {
    idx = crlf;
    sepLen = 4;
  } else if (lf !== -1) {
    idx = lf;
    sepLen = 2;
  }
  if (idx === -1) return [raw, ""];
  return [raw.slice(0, idx), raw.slice(idx + sepLen)];
};

/** Parse a header block into a lowercased-key map, unfolding continuation lines
 * (a line starting with SP or TAB continues the previous header — RFC 5322
 * §2.2.3). Last-wins on duplicate keys (fine for the headers we read). */
const parseHeaders = (headerBlock: string): Map<string, string> => {
  const headers = new Map<string, string>();
  const lines = headerBlock.split(/\r?\n/);
  const unfolded: string[] = [];
  for (const line of lines) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && unfolded.length > 0) {
      unfolded[unfolded.length - 1] += " " + line.trim();
    } else {
      unfolded.push(line);
    }
  }
  for (const line of unfolded) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key.length > 0) headers.set(key, value);
  }
  return headers;
};

/** Extract a `;`-delimited parameter (e.g. `boundary=`, `charset=`) from a
 * structured header value, stripping surrounding quotes. Case-insensitive name. */
const headerParam = (value: string | undefined, name: string): string | undefined => {
  if (value === undefined) return undefined;
  const re = new RegExp(`${name}\\s*=\\s*"?([^";]+)"?`, "i");
  const m = value.match(re);
  return m ? m[1]!.trim() : undefined;
};

/** The mime type (before the first `;`), lowercased. */
const mimeType = (contentType: string | undefined): string =>
  (contentType ?? "text/plain").split(";")[0]!.trim().toLowerCase();

/** RFC 2047 decode of an encoded-word subject like
 * `=?UTF-8?B?...?=` / `=?UTF-8?Q?...?=`. Best-effort: leaves anything it can't
 * decode untouched. Many providers send a plain ASCII subject, so this is a
 * nicety, not load-bearing. */
const decodeEncodedWords = (value: string): string =>
  value.replace(
    /=\?[^?]+\?([bBqQ])\?([^?]*)\?=/g,
    (_match, enc: string, data: string) => {
      try {
        if (enc.toLowerCase() === "b") {
          return decodeBase64(data);
        }
        // Q-encoding: `_` is space; `=XX` is a hex byte.
        const qp = data.replace(/_/g, " ");
        return decodeQuotedPrintable(qp);
      } catch {
        return _match;
      }
    },
  );

/** Decode a base64 string (whitespace-tolerant) to a JS string. UTF-8 aware:
 * `atob` yields a latin1 byte string, which we re-decode as UTF-8 so multibyte
 * chars survive. Never throws — returns "" on malformed input. */
const decodeBase64 = (data: string): string => {
  try {
    const clean = data.replace(/\s+/g, "");
    if (clean.length === 0) return "";
    const binary = atob(clean);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder("utf-8").decode(bytes);
  } catch {
    return "";
  }
};

/** Decode quoted-printable (RFC 2045 §6.7): `=\n` / `=\r\n` soft line breaks
 * are removed; `=XX` is a hex byte. We collect raw bytes then UTF-8 decode so a
 * multibyte char split across `=XX=XX` reassembles. Never throws. */
const decodeQuotedPrintable = (data: string): string => {
  try {
    // Drop soft line breaks first (`=` at end of line). Tolerant of trailing
    // whitespace before the newline, which some encoders emit.
    const noSoftBreaks = data.replace(/=[ \t]*\r?\n/g, "");
    const bytes: number[] = [];
    for (let i = 0; i < noSoftBreaks.length; i++) {
      const ch = noSoftBreaks[i]!;
      if (ch === "=" && i + 2 < noSoftBreaks.length) {
        const hex = noSoftBreaks.slice(i + 1, i + 3);
        if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
          bytes.push(parseInt(hex, 16));
          i += 2;
          continue;
        }
      }
      // Push the char's bytes (latin1 codepoints are 0..255; higher codepoints
      // shouldn't appear in QP source, but encode them to stay lossless).
      const code = ch.charCodeAt(0);
      if (code < 256) {
        bytes.push(code);
      } else {
        for (const b of new TextEncoder().encode(ch)) bytes.push(b);
      }
    }
    return new TextDecoder("utf-8").decode(new Uint8Array(bytes));
  } catch {
    return data;
  }
};

/** Transfer-decode a part body by its `Content-Transfer-Encoding`. Unknown /
 * absent / `7bit` / `8bit` / `binary` → passthrough. */
const transferDecode = (body: string, encoding: string | undefined): string => {
  const enc = (encoding ?? "").trim().toLowerCase();
  if (enc === "base64") return decodeBase64(body);
  if (enc === "quoted-printable") return decodeQuotedPrintable(body);
  return body;
};

/** Split a multipart body on its `--boundary` delimiters into raw parts. The
 * preamble (before the first boundary) and the closing `--boundary--` epilogue
 * are dropped. Each returned chunk is a raw part (headers + body). */
const splitMultipart = (body: string, boundary: string): string[] => {
  const delimiter = `--${boundary}`;
  const segments = body.split(delimiter);
  const parts: string[] = [];
  // segments[0] is the preamble; skip it. The closing delimiter leaves a final
  // segment starting with `--` (or empty) — skip those too.
  for (let i = 1; i < segments.length; i++) {
    let seg = segments[i]!;
    if (seg.startsWith("--")) break; // closing boundary `--boundary--`
    // A boundary line is `--boundary\r\n`; strip the leading CRLF/LF the split
    // leaves on the front of the part.
    seg = seg.replace(/^\r?\n/, "");
    // Strip the trailing CRLF before the next delimiter.
    seg = seg.replace(/\r?\n$/, "");
    if (seg.length > 0) parts.push(seg);
  }
  return parts;
};

/** Crude HTML→text: drop `<script>`/`<style>` blocks, strip tags, collapse
 * whitespace, decode a handful of common entities. Good enough to surface a
 * code / link that the HTML alternative carried. */
const htmlToText = (html: string): string =>
  html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]*\n[ \t]*\n+/g, "\n\n")
    .trim();

/** Recursively walk a part, filling `text` / `html` on the accumulator. Picks
 * the first `text/plain` for `text` and first `text/html` for `html`. For
 * `multipart/alternative` we still prefer text/plain (handled implicitly: we
 * fill `text` from the plain part regardless of order). */
const walkPart = (
  raw: string,
  acc: { text?: string; html?: string },
  depth: number,
): void => {
  if (depth > 20) return; // pathological nesting guard
  const [headerBlock, body] = splitHeadersBody(raw);
  const headers = parseHeaders(headerBlock);
  const contentType = headers.get("content-type");
  const type = mimeType(contentType);
  const cte = headers.get("content-transfer-encoding");

  if (type.startsWith("multipart/")) {
    const boundary = headerParam(contentType, "boundary");
    if (boundary === undefined) {
      // Malformed multipart with no boundary — treat the body as text.
      if (acc.text === undefined) acc.text = body;
      return;
    }
    for (const part of splitMultipart(body, boundary)) {
      walkPart(part, acc, depth + 1);
    }
    return;
  }

  const decoded = transferDecode(body, cte);
  if (type === "text/html") {
    if (acc.html === undefined) acc.html = decoded;
    // Only derive text from HTML if no text/plain has filled it (and won't —
    // the caller backfills from html at the end if needed).
  } else {
    // text/plain and anything else textual → use as the plain body.
    if (acc.text === undefined) acc.text = decoded;
  }
};

/**
 * Parse a raw RFC 5322 email into its subject + plain-text (+ optional HTML)
 * body. Dependency-free, defensive: any internal failure degrades to a
 * best-effort `{ text }` rather than throwing.
 */
export const parseEmail = (
  raw: ArrayBuffer | Uint8Array | string,
): ParsedEmail => {
  let decoded: string;
  try {
    decoded = decodeBytes(raw);
  } catch {
    return { text: "" };
  }

  try {
    const [topHeaderBlock] = splitHeadersBody(decoded);
    const topHeaders = parseHeaders(topHeaderBlock);
    const subjectRaw = topHeaders.get("subject");
    const subject = subjectRaw !== undefined ? decodeEncodedWords(subjectRaw) : undefined;

    const acc: { text?: string; html?: string } = {};
    walkPart(decoded, acc, 0);

    // If we got HTML but no plain text, derive text from the HTML.
    let text = acc.text;
    if (text === undefined && acc.html !== undefined) {
      text = htmlToText(acc.html);
    }
    // Single-part text/html case sets html but text stays undefined until here.
    if (text === undefined) {
      // Best-effort: whole body, in case the type sniffing missed it.
      const [, body] = splitHeadersBody(decoded);
      text = body;
    }

    const result: ParsedEmail = { text };
    if (subject !== undefined) (result as { subject?: string }).subject = subject;
    if (acc.html !== undefined) (result as { html?: string }).html = acc.html;
    return result;
  } catch {
    // Total failure — hand back whatever body we can find, never throw.
    try {
      const [, body] = splitHeadersBody(decoded);
      return { text: body };
    } catch {
      return { text: decoded };
    }
  }
};
