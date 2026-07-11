// Unit tests for the GitHub App JWT signer.
//
// Asserts the signer produces a structurally valid RS256 JWT: three base64url
// segments, an `{alg:RS256,typ:JWT}` header, the required `iat`/`exp`/`iss`
// claims with `exp` inside GitHub's 10-minute ceiling, and a signature that
// verifies against the matching public key.

import { describe, expect, it } from "vitest";
import { TEST_APP_PRIVATE_KEY } from "./__fixtures__/test-key";
import { signAppJwt } from "./jwt";

/** base64url-decode a JWT segment to UTF-8 text. */
const decodeSegment = (segment: string): string => {
  const b64 = segment.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64.padEnd(Math.ceil(b64.length / 4) * 4, "=");
  return Buffer.from(padded, "base64").toString("utf8");
};

/** base64url-decode a JWT segment to bytes. */
const decodeBytes = (segment: string): Uint8Array => {
  const b64 = segment.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64.padEnd(Math.ceil(b64.length / 4) * 4, "=");
  return new Uint8Array(Buffer.from(padded, "base64"));
};

describe("signAppJwt", () => {
  it("produces a three-segment RS256 JWT with the required claims", async () => {
    const nowSec = 1_700_000_000;
    const jwt = await signAppJwt({
      appId: 42,
      privateKeyPem: TEST_APP_PRIVATE_KEY,
      nowSec,
    });

    const segments = jwt.split(".");
    expect(segments).toHaveLength(3);

    const header = JSON.parse(decodeSegment(segments[0]!));
    expect(header).toEqual({ alg: "RS256", typ: "JWT" });

    const claims = JSON.parse(decodeSegment(segments[1]!));
    expect(claims.iss).toBe("42");
    // iat is backdated 60s for clock skew; exp is within GitHub's 10-min cap.
    expect(claims.iat).toBe(nowSec - 60);
    expect(claims.exp).toBeGreaterThan(nowSec);
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(10 * 60);
  });

  it("clamps an over-long requested lifetime to the 10-minute ceiling", async () => {
    const nowSec = 1_700_000_000;
    const jwt = await signAppJwt({
      appId: 7,
      privateKeyPem: TEST_APP_PRIVATE_KEY,
      nowSec,
      lifetimeSec: 60 * 60, // ask for an hour — must be clamped
    });
    const claims = JSON.parse(decodeSegment(jwt.split(".")[1]!));
    expect(claims.exp - nowSec).toBeLessThanOrEqual(10 * 60);
  });

  it("signs with a signature that verifies against the public key", async () => {
    const jwt = await signAppJwt({
      appId: 1,
      privateKeyPem: TEST_APP_PRIVATE_KEY,
    });
    const [headerSeg, payloadSeg, sigSeg] = jwt.split(".");

    // Derive the public key from the private key to verify the RS256 signature.
    const der = new Uint8Array(
      Buffer.from(
        TEST_APP_PRIVATE_KEY.replace(/-----[A-Z ]+-----/g, "").replace(
          /\s+/g,
          "",
        ),
        "base64",
      ),
    );
    const privKey = await crypto.subtle.importKey(
      "pkcs8",
      der.slice().buffer,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      true,
      ["sign"],
    );
    const jwk = await crypto.subtle.exportKey("jwk", privKey);
    const pubKey = await crypto.subtle.importKey(
      "jwk",
      { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );

    const ok = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      pubKey,
      decodeBytes(sigSeg!).slice().buffer,
      new TextEncoder().encode(`${headerSeg}.${payloadSeg}`),
    );
    expect(ok).toBe(true);
  });
});
