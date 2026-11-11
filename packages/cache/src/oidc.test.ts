import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";
import { fromBase64url } from "./crypto.ts";
import { handleJwks, issueOidcToken, jwks, OIDC_RESERVED_CLAIMS, type OidcKeys } from "./oidc.ts";
import { failureOf } from "./support.test-support.ts";

const keyPair = async (kid: string) => {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  return {
    private: { ...((await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey), kid },
    public: { ...((await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey), kid },
  };
};
const NOW = 1_700_000_000_000;
const decode = (jwt: string) =>
  JSON.parse(new TextDecoder().decode(fromBase64url(jwt.split(".")[1]!))) as Record<string, unknown>;

describe("OIDC issuer", () => {
  it("[FD-PROV-049] a key retired by rotation stays in the JWKS for at least 3600 s", async () => {
    const current = await keyPair("k2");
    const old = await keyPair("k1");
    const keys: OidcKeys = { current: current.private as OidcKeys["current"], retired: [{ jwk: old.public as OidcKeys["current"], retiredAt: NOW }] };
    const kids = (at: number) => jwks(keys, at).keys.map((k) => k.kid);
    expect(kids(NOW + 3599_000)).toEqual(["k2", "k1"]);
    expect(kids(NOW + 3600_000)).toEqual(["k2"]);
    expect(jwks(keys, NOW + 3600_000, 60).keys).toHaveLength(1);
    expect(jwks(keys, NOW + 1000, 60).keys).toHaveLength(2);
    for (const k of jwks(keys, NOW).keys) expect(k).not.toHaveProperty("d");
    const r = handleJwks(new Request("https://ci.example.com/.well-known/jwks.json"), keys, NOW)!;
    expect(((await r.json()) as { keys: unknown[] }).keys).toHaveLength(2);
    // A token signed by the retired key still verifies against the served set within the window.
    const before: OidcKeys = { current: old.private as OidcKeys["current"], retired: [] };
    const token = await Effect.runPromise(issueOidcToken(before, "https://ci.example.com", { run: "check", executionId: "e1", audience: "sts.amazonaws.com" }, NOW));
    const served = jwks(keys, NOW + 900_000).keys.find((k) => k.kid === "k1")!;
    const pub = await crypto.subtle.importKey("jwk", served as JsonWebKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const [h, p, s] = token.jwt.split(".");
    expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, fromBase64url(s!)!.buffer as ArrayBuffer, new TextEncoder().encode(`${h}.${p}`))).toBe(true);
  });

  it("[FD-PROV-050] sub is <run>:<execution_id>, the lifetime defaults to 900 s and caps at 3600 s, and reserved claims are refused", async () => {
    const k = await keyPair("k1");
    const keys: OidcKeys = { current: k.private as OidcKeys["current"], retired: [] };
    const issue = (over: object = {}) =>
      Effect.runPromiseExit(issueOidcToken(keys, "https://ci.example.com/", { run: "deploy", executionId: "e-9", audience: "aud", ...over }, NOW));
    const t = await issue();
    if (Exit.isFailure(t)) throw new Error("refused");
    const claims = decode(t.value.jwt);
    expect(claims).toMatchObject({ sub: "deploy:e-9", iss: "https://ci.example.com", aud: "aud", exp: NOW / 1000 + 900 });
    const max = await issue({ ttlSec: 3600 });
    expect(Exit.isSuccess(max)).toBe(true);
    expect(failureOf(await issue({ ttlSec: 3601 }))).toMatchObject({ reason: "ttl" });
    for (const claim of OIDC_RESERVED_CLAIMS)
      expect(failureOf(await issue({ claims: { [claim]: "x" } }))).toMatchObject({ reason: "reserved-claim" });
    const custom = await issue({ claims: { repo: "acme/widgets" } });
    expect(Exit.isSuccess(custom) && decode(custom.value.jwt).repo).toBe("acme/widgets");
  });
});
