// A throwaway Access team: an RSA key that signs RS256 JWTs and a fetch that serves its JWKS.
import { JwksCache, type AccessConfig } from "./access.ts";

export const TEAM = "acme.cloudflareaccess.com";
export const ISSUER = `https://${TEAM}`;
export const AUD = "aud-tag";

const b64url = (data: string | Uint8Array) =>
  btoa(typeof data === "string" ? data : String.fromCharCode(...data))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

export const accessTeam = async () => {
  const { privateKey, publicKey } = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", publicKey)) as JsonWebKey;
  const keys = [{ kid: "k1", kty: "RSA", alg: "RS256", n: jwk.n, e: jwk.e }];
  let fetches = 0;
  const fetcher = (async (url: string) => {
    fetches++;
    return url === `${ISSUER}/cdn-cgi/access/certs`
      ? Response.json({ keys })
      : new Response(null, { status: 404 });
  }) as unknown as typeof fetch;
  const sign = async (
    claims: Record<string, unknown>,
    header: Record<string, unknown> = { alg: "RS256", kid: "k1" },
  ) => {
    const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
    const sig = new Uint8Array(
      await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, new TextEncoder().encode(input)),
    );
    return `${input}.${b64url(sig)}`;
  };
  const nowS = Math.floor(Date.now() / 1000);
  const token = (claims: Record<string, unknown> = {}) =>
    sign({
      iss: ISSUER,
      aud: [AUD],
      exp: nowS + 300,
      sub: "sub-1",
      email: "ops@acme.com",
      ...claims,
    });
  const config: AccessConfig = {
    teamDomain: TEAM,
    aud: AUD,
    jwks: (issuer) => new JwksCache(issuer, fetcher),
  };
  return { sign, token, config, fetcher, fetches: () => fetches, nowS };
};

export const requestWith = (jwt: string | null, path = "/", init: RequestInit = {}) =>
  new Request(`https://dispatch.example.com${path}`, {
    ...init,
    headers: {
      ...(jwt === null ? {} : { "Cf-Access-Jwt-Assertion": jwt }),
      ...(init.headers as Record<string, string>),
    },
  });
