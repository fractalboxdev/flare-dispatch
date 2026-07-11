// Tests for the in-memory `Oidc` fake.
//
// The fake emits real JWT-shaped strings (`header.payload.sig`) where header
// and payload are base64url-encoded JSON, so a test can decode them and
// assert on `audience`, `subject`, `claims`, `ttlSec`. The "signature" is a
// fixed placeholder; tests should never verify it.

import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { Oidc, OIDC_TOKEN_MAX_TTL_SEC } from "../services/oidc";
import { makeOidcFake } from "./oidc-fake";

const decodeSegment = (seg: string): unknown => {
  // base64url → base64 → atob → JSON.
  const b64 = seg.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  return JSON.parse(atob(b64 + pad));
};

const decodeJwt = (
  jwt: string,
): { header: Record<string, unknown>; payload: Record<string, unknown> } => {
  const [headerSeg, payloadSeg] = jwt.split(".");
  return {
    header: decodeSegment(headerSeg!) as Record<string, unknown>,
    payload: decodeSegment(payloadSeg!) as Record<string, unknown>,
  };
};

describe("makeOidcFake — sign()", () => {
  it("returns a JWT-shaped string with header+payload+signature segments", async () => {
    const { layer } = makeOidcFake({ now: 1_700_000_000_000 });
    const token = await Effect.runPromise(
      Effect.flatMap(Oidc, (o) =>
        o.sign({ audience: "sts.amazonaws.com" }),
      ).pipe(Effect.provide(layer)),
    );
    expect(token.jwt.split(".").length).toBe(3);
    expect(token.expiresAt).toBeGreaterThan(1_700_000_000_000);

    const { header, payload } = decodeJwt(token.jwt);
    expect(header.alg).toBe("ES256");
    expect(header.typ).toBe("JWT");
    expect(payload.aud).toBe("sts.amazonaws.com");
    expect(typeof payload.iat).toBe("number");
    expect(typeof payload.exp).toBe("number");
    expect((payload.exp as number) - (payload.iat as number)).toBe(900); // default TTL
  });

  it("respects custom subject + claims", async () => {
    const { layer, state } = makeOidcFake({ now: 1_700_000_000_000 });
    const token = await Effect.runPromise(
      Effect.flatMap(Oidc, (o) =>
        o.sign({
          audience: "sts.amazonaws.com",
          subject: "ai-code-review:01ABC",
          ttlSec: 300,
          claims: { role: "bedrock-reader", repo: "owner/name" },
        }),
      ).pipe(Effect.provide(layer)),
    );
    const { payload } = decodeJwt(token.jwt);
    expect(payload.sub).toBe("ai-code-review:01ABC");
    expect(payload.role).toBe("bedrock-reader");
    expect(payload.repo).toBe("owner/name");
    expect((payload.exp as number) - (payload.iat as number)).toBe(300);
    expect(state.signCalls).toHaveLength(1);
    expect(state.signCalls[0]!.subject).toBe("ai-code-review:01ABC");
  });

  it("caps the TTL at OIDC_TOKEN_MAX_TTL_SEC (3600)", async () => {
    const { layer } = makeOidcFake({ now: 1_700_000_000_000 });
    const token = await Effect.runPromise(
      Effect.flatMap(Oidc, (o) =>
        o.sign({ audience: "sts.amazonaws.com", ttlSec: 100_000 }),
      ).pipe(Effect.provide(layer)),
    );
    const { payload } = decodeJwt(token.jwt);
    expect((payload.exp as number) - (payload.iat as number)).toBe(
      OIDC_TOKEN_MAX_TTL_SEC,
    );
  });

  it("records every sign call for assertions", async () => {
    const { layer, state } = makeOidcFake();
    await Effect.runPromise(
      Effect.gen(function* () {
        const o = yield* Oidc;
        yield* o.sign({ audience: "sts.amazonaws.com" });
        yield* o.sign({ audience: "vault.example", subject: "x" });
      }).pipe(Effect.provide(layer)),
    );
    expect(state.signCalls.map((c) => c.audience)).toEqual([
      "sts.amazonaws.com",
      "vault.example",
    ]);
  });
});

describe("makeOidcFake — issuer()", () => {
  it("returns the configured issuer URL", async () => {
    const { layer } = makeOidcFake({
      issuer: "https://flare-dispatch.example.com",
    });
    const iss = await Effect.runPromise(
      Effect.flatMap(Oidc, (o) => o.issuer()).pipe(Effect.provide(layer)),
    );
    expect(iss).toBe("https://flare-dispatch.example.com");
  });
});
