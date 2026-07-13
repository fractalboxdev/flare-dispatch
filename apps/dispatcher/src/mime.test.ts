// FlareDispatch Dispatcher — `parseEmail` (mime.ts) unit tests.
//
// The dependency-free MIME extractor only has to be "good enough to surface a
// code / link" for the providers we target, so the cases here are the shapes a
// verification email actually arrives in: multipart/alternative (plain + html),
// quoted-printable bodies (soft `=\n` breaks + `=XX` escapes), base64 bodies,
// a single text/plain, and a malformed blob (which must NOT throw).

import { describe, expect, it } from "vitest";
import { parseEmail } from "./mime";

// CRLF line endings — real SMTP wire format.
const crlf = (s: string): string => s.replace(/\n/g, "\r\n");

describe("parseEmail — multipart/alternative", () => {
  it("prefers the text/plain part for `text` and exposes the html part", () => {
    const raw = crlf(
      [
        "From: auth@provider.example",
        "Subject: Your code",
        'Content-Type: multipart/alternative; boundary="BND"',
        "",
        "--BND",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "Your code is 123456",
        "--BND",
        "Content-Type: text/html; charset=utf-8",
        "",
        "<html><body><p>Your code is <b>123456</b></p></body></html>",
        "--BND--",
        "",
      ].join("\n"),
    );
    const parsed = parseEmail(raw);
    expect(parsed.subject).toBe("Your code");
    expect(parsed.text).toContain("Your code is 123456");
    expect(parsed.html).toContain("<b>123456</b>");
  });
});

describe("parseEmail — quoted-printable", () => {
  it("removes `=\\n` soft breaks and decodes `=3D`", () => {
    const raw = crlf(
      [
        "Subject: Verify",
        "Content-Type: text/plain; charset=utf-8",
        "Content-Transfer-Encoding: quoted-printable",
        "",
        // A soft line break splits "code=" across lines; `=3D` is a literal '='.
        "Click https://app.example/verify?token=3Dabc to log in. This is a very lo=",
        "ng line that was soft-wrapped.",
        "",
      ].join("\n"),
    );
    const parsed = parseEmail(raw);
    // Soft break joined the two physical lines:
    expect(parsed.text).toContain("very long line that was soft-wrapped.");
    // `=3D` decoded to '=':
    expect(parsed.text).toContain("verify?token=abc");
    expect(parsed.text).not.toContain("=3D");
  });
});

describe("parseEmail — base64", () => {
  it("decodes a base64 transfer-encoded body", () => {
    const bodyText = "Your one-time passcode is 987654.";
    const b64 = Buffer.from(bodyText, "utf-8").toString("base64");
    const raw = crlf(
      [
        "Subject: OTP",
        "Content-Type: text/plain; charset=utf-8",
        "Content-Transfer-Encoding: base64",
        "",
        b64,
        "",
      ].join("\n"),
    );
    const parsed = parseEmail(raw);
    expect(parsed.text).toContain("987654");
    expect(parsed.text).toContain("one-time passcode");
  });
});

describe("parseEmail — single text/plain", () => {
  it("returns the body verbatim with no transfer encoding", () => {
    const raw = crlf(
      [
        "Subject: Hello",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "Plain body line one.",
        "Plain body line two.",
        "",
      ].join("\n"),
    );
    const parsed = parseEmail(raw);
    expect(parsed.subject).toBe("Hello");
    expect(parsed.text).toContain("Plain body line one.");
    expect(parsed.text).toContain("Plain body line two.");
    expect(parsed.html).toBeUndefined();
  });

  it("derives stripped text from a single text/html part", () => {
    const raw = crlf(
      [
        "Subject: HTML only",
        "Content-Type: text/html; charset=utf-8",
        "",
        "<html><body><p>Code: <strong>424242</strong></p>" +
          "<script>ignore()</script></body></html>",
        "",
      ].join("\n"),
    );
    const parsed = parseEmail(raw);
    expect(parsed.html).toContain("424242");
    // Crude tag-strip surfaces the code as text and drops the <script>:
    expect(parsed.text).toContain("424242");
    expect(parsed.text).not.toContain("ignore()");
  });
});

describe("parseEmail — defensive", () => {
  it("does not throw on a malformed blob and returns a best-effort text", () => {
    const garbage = "\x00\x01\x02 not a real email at all \xff\xfe no headers here";
    expect(() => parseEmail(garbage)).not.toThrow();
    const parsed = parseEmail(garbage);
    expect(typeof parsed.text).toBe("string");
  });

  it("handles raw bytes (Uint8Array / ArrayBuffer) without throwing", () => {
    const raw = crlf(
      ["Subject: Bytes", "Content-Type: text/plain", "", "byte body 555000", ""].join(
        "\n",
      ),
    );
    const bytes = new TextEncoder().encode(raw);
    expect(parseEmail(bytes).text).toContain("555000");
    expect(
      parseEmail(bytes.buffer.slice(0) as ArrayBuffer).text,
    ).toContain("555000");
  });

  it("empty input yields empty text, no throw", () => {
    expect(parseEmail("")).toEqual({ text: "" });
  });
});
