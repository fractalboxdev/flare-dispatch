import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { accessTeam, AUD, ISSUER, requestWith, TEAM } from "./access.test-support.ts";
import {
  deniedResponse,
  identityListed,
  JwksCache,
  requireAccess,
  requireOperator,
  verifyAccessJwt,
} from "./index.ts";

const refusal = (effect: Effect.Effect<unknown, { status: number; code: string }>) =>
  Effect.runPromise(Effect.flip(effect)).then((e) => [e.status, e.code]);

describe("Access gate", () => {
  it("[FD-OPS-064] a valid Access JWT against the overlay's aud and team domain yields the identity", async () => {
    const team = await accessTeam();
    const identity = await Effect.runPromise(
      requireAccess(requestWith(await team.token()), team.config),
    );
    expect(identity).toEqual({
      email: "ops@acme.com",
      commonName: null,
      subject: "sub-1",
      name: "ops@acme.com",
    });
    const cookie = new Request("https://dispatch.example.com/", {
      headers: { Cookie: `other=1; CF_Authorization=${await team.token()}` },
    });
    expect((await Effect.runPromise(requireAccess(cookie, team.config))).name).toBe("ops@acme.com");
    const service = await team.token({ email: undefined, common_name: "ci.access" });
    expect((await Effect.runPromise(requireAccess(requestWith(service), team.config))).name).toBe(
      "ci.access",
    );
  });

  it("[FD-OPS-064] RS256 only, a kid the JWKS publishes, the overlay's issuer and audience, 60 s of skew", async () => {
    const team = await accessTeam();
    const keys = [{ kid: "k1", kty: "RSA" }];
    expect(
      await verifyAccessJwt(await team.token(), {
        keys,
        aud: AUD,
        issuer: ISSUER,
        nowSeconds: team.nowS,
      }),
    ).toBeNull();
    const verify = (jwt: string, nowSeconds = team.nowS) =>
      team.config
        .jwks(ISSUER)
        .keysFor("k1", Date.now())
        .then((k) => verifyAccessJwt(jwt, { keys: k!, aud: AUD, issuer: ISSUER, nowSeconds }));
    expect(await verify(await team.token())).not.toBeNull();
    expect(await verify(await team.token({ aud: "other" }))).toBeNull();
    expect(await verify(await team.token({ iss: "https://evil.cloudflareaccess.com" }))).toBeNull();
    expect(
      await verify(
        await team.sign(
          { iss: ISSUER, aud: AUD, exp: team.nowS + 300 },
          { alg: "HS256", kid: "k1" },
        ),
      ),
    ).toBeNull();
    expect(
      await verify(
        await team.sign({ iss: ISSUER, aud: AUD, exp: team.nowS + 300 }, { alg: "RS256" }),
      ),
    ).toBeNull();
    const exp = team.nowS + 10;
    expect(await verify(await team.token({ exp }), exp + 60)).not.toBeNull();
    expect(await verify(await team.token({ exp }), exp + 61)).toBeNull();
  });

  it("[FD-OPS-064] no JWT answers 401, or a redirect to the Access login for a browser; a bad one 403, never 500", async () => {
    const team = await accessTeam();
    expect(await refusal(requireAccess(requestWith(null), team.config))).toEqual([
      401,
      "unauthenticated",
    ]);
    const browser = await Effect.runPromise(
      Effect.flip(
        requireAccess(requestWith(null, "/", { headers: { Accept: "text/html" } }), team.config),
      ),
    );
    const redirect = deniedResponse(browser, "r1");
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get("location")).toContain(
      `https://${TEAM}/cdn-cgi/access/login/dispatch.example.com`,
    );
    expect(await refusal(requireAccess(requestWith("not.a.jwt"), team.config))).toEqual([
      403,
      "forbidden",
    ]);
    expect(await refusal(requireAccess(requestWith("@@@.@@@.@@@"), team.config))).toEqual([
      403,
      "forbidden",
    ]);
    const body = await deniedResponse(
      await Effect.runPromise(Effect.flip(requireAccess(requestWith("x.y.z"), team.config))),
      "req-9",
    ).json();
    expect(body).toEqual({
      error: "forbidden",
      message: "invalid Cloudflare Access token",
      request_id: "req-9",
    });
  });

  it("[FD-OPS-064] an overlay with no team domain or audience answers 503 not_configured, with no unauthenticated mode", async () => {
    const team = await accessTeam();
    const jwt = await team.token();
    expect(
      await refusal(requireAccess(requestWith(jwt), { ...team.config, aud: undefined })),
    ).toEqual([503, "not_configured"]);
    expect(
      await refusal(requireAccess(requestWith(jwt), { ...team.config, teamDomain: "" })),
    ).toEqual([503, "not_configured"]);
  });

  it("[FD-OPS-078] the operator gate admits only an identity the overlay's operators list, and answers 403 to any other", async () => {
    const team = await accessTeam();
    const operators = ["OPS@acme.com", "deploy.access"];
    expect(
      (
        await Effect.runPromise(
          requireOperator(requestWith(await team.token()), team.config, operators),
        )
      ).name,
    ).toBe("ops@acme.com");
    expect(
      await refusal(
        requireOperator(
          requestWith(await team.token({ email: "dev@acme.com" })),
          team.config,
          operators,
        ),
      ),
    ).toEqual([403, "forbidden"]);
    expect(
      identityListed(
        { email: null, commonName: "deploy.access", subject: "s", name: "deploy.access" },
        operators,
      ),
    ).toBe(true);
    expect(await refusal(requireOperator(requestWith(null), team.config, operators))).toEqual([
      401,
      "unauthenticated",
    ]);
  });

  it("refetches the JWKS on an unknown kid at most every 30 s", async () => {
    const team = await accessTeam();
    const cache = new JwksCache(ISSUER, team.fetcher);
    await cache.keysFor("k1", 0);
    await cache.keysFor("k9", 1_000);
    await cache.keysFor("k9", 2_000);
    expect(team.fetches()).toBe(2);
    await cache.keysFor("k9", 31_000);
    expect(team.fetches()).toBe(3);
  });
});
