// The deploy suite of `V-DEPLOY` (specs/verification.md § Harness catalog) for the dispatcher's identity configuration
// (specs/interfaces.md § Identity gate, § Link tokens) and its webhook secret (specs/intake.md § Webhook): `fd deploy`
// over the committed control-plane template and an operator overlay, then requests to the deployed Worker on the vars
// the rendered configuration sets and the Worker secrets the account holds.
import { createHmac } from "node:crypto";
import { matchPath, type Surface } from "@fractalboxdev/flare-dispatch-api";
import { bypassed, placeholderOverlay } from "@fractalboxdev/flare-dispatch-ops";
import { Match } from "effect";
import type { Miniflare } from "miniflare";
import { afterAll, describe, expect, it, vi } from "vitest";
import { router } from "../../src/http.ts";
import { account } from "./support.ts";

const DISTINCT = {
  WEBHOOK_SECRET: "webhook-secret-value",
  LINK_KEY: "link-key-value",
  PROVENANCE_KEY: "provenance-key-value",
  OIDC_SIGNING_JWK: "oidc-key-value",
  LOG_KEY: "log-key-value",
  COMPILE_CACHE_SECRET: "compile-cache-value",
  CACHE_TOKEN_SECRET: "cache-token-value",
  INSTALL_STATE_KEY: "install-state-value",
};

/** An overlay whose Access values are blank: the rendered Worker reads no team domain and no audience. */
const NO_ACCESS = { ...placeholderOverlay, access: { teamDomain: " ", aud: " " } };

/** Whether a surface admits a request only on an Access identity (or, for an execution read, an Actions token). */
const gated = (surface: Surface): boolean =>
  Match.value(surface).pipe(
    Match.tagsExhaustive({
      Access: () => true,
      AccessOrActions: () => true,
      Dispatch: () => false,
      AccessIfPresent: () => false,
      Link: () => false,
      OwnCredential: () => false,
      Public: () => false,
    }),
  );

/**
 * One request per gated route of the router the Worker mounts, each parameter and wildcard filled, kept where the
 * route the router picks for that path is gated; then an unclaimed `/v1/` path and the dashboard's pages.
 */
const GATED: readonly { readonly method: string; readonly path: string }[] = [
  ...router.routes
    .map((r) => ({
      method: r.method,
      path: r.path.replace(/:[A-Za-z_]+/g, "x").replace(/\*$/, "x"),
    }))
    .filter(({ path }) => {
      const top = matchPath(router.routes, path)[0];
      return top !== undefined && gated(top.route.surface);
    }),
  { method: "GET", path: "/v1/unclaimed" },
  { method: "GET", path: "/" },
  { method: "GET", path: "/executions/x" },
];

const send = (mf: Miniflare, r: { method: string; path: string }, headers = {}) =>
  mf.dispatchFetch(`https://dispatch.example.com${r.path}`, {
    method: r.method,
    headers: { "content-type": "application/json", ...headers },
    ...(r.method === "GET" || r.method === "HEAD" ? {} : { body: "{}" }),
  });

/** The status and error code of every gated route's answer, by route. */
const answers = async (mf: Miniflare, headers = {}) => {
  const out: Record<string, string> = {};
  for (const r of GATED) {
    const res = await send(mf, r, headers);
    const text = await res.text();
    const error =
      res.headers.get("content-type")?.includes("json") === true
        ? String((JSON.parse(text) as { error?: unknown }).error)
        : "";
    out[`${r.method} ${r.path}`] = `${res.status} ${error}`.trim();
  }
  return out;
};

const served: Miniflare[] = [];
const serve = async (deployed: ReturnType<typeof account>, vars = {}) => {
  const mf = await deployed.serve(vars);
  served.push(mf);
  return mf;
};
afterAll(async () => {
  await Promise.all(served.map((mf) => mf.dispose()));
});

describe("fd deploy and the dispatcher's identity gate", () => {
  it("[FD-IFC-014] a deploy whose overlay sets no Access team domain or audience serves 503 not_configured on every gated route, and an overlay without the values never deploys", async () => {
    expect(GATED.length).toBeGreaterThan(20);
    expect(GATED).toEqual(
      expect.arrayContaining([
        { method: "GET", path: "/v1/executions" },
        { method: "POST", path: "/v1/ops/halt" },
      ]),
    );

    const unset = account(DISTINCT, NO_ACCESS);
    const report = await unset.deploy();
    expect(report.ok).toBe(true);
    expect(unset.vars()).toMatchObject({ ACCESS_TEAM_DOMAIN: " ", ACCESS_AUD: " " });
    const mf = await serve(unset);
    const expected = Object.fromEntries(
      GATED.map((r) => [`${r.method} ${r.path}`, "503 not_configured"]),
    );
    expect(await answers(mf)).toEqual(expected);
    // A token changes nothing: with no team to verify it against, the gate refuses before reading it.
    expect(await answers(mf, { "cf-access-jwt-assertion": "e30.e30.c2ln" })).toEqual(expected);

    // The same routes on a deploy whose overlay sets both values ask for an identity instead.
    const set = account(DISTINCT);
    expect((await set.deploy()).ok).toBe(true);
    const configured = await answers(await serve(set));
    for (const [route, answer] of Object.entries(configured))
      expect(answer, route).not.toBe("503 not_configured");

    // An overlay that omits the values, or leaves them empty, fails decode, so no Worker deploys from it.
    const { access: _access, ...withoutAccess } = placeholderOverlay;
    for (const overlay of [
      withoutAccess,
      { ...placeholderOverlay, access: { teamDomain: "", aud: "" } },
    ]) {
      const refused = account(DISTINCT, overlay as typeof placeholderOverlay);
      const failed = await refused.deploy();
      expect(failed.ok).toBe(false);
      expect(failed.stages.map((s) => [s.stage, s.ok])).toEqual([["decode", false]]);
      expect(failed.stages[0]!.detail).toContain("access");
      expect(refused.vars()).toEqual({});
    }
  });

  it("[FD-IFC-015] no deployment the template renders serves a gated route without identity: Access set or unset, production or development, and the Worker itself refuses every one, whether or not Access sits in front of it", async () => {
    const modes = [
      { name: "production, Access set", overlay: placeholderOverlay, vars: {} },
      { name: "production, Access unset", overlay: NO_ACCESS, vars: {} },
      {
        name: "development, Access set",
        overlay: placeholderOverlay,
        vars: { DEPLOYMENT: "development" },
      },
      {
        name: "development, Access unset",
        overlay: NO_ACCESS,
        vars: { DEPLOYMENT: "development" },
      },
    ];
    for (const mode of modes) {
      const deployed = account(DISTINCT, mode.overlay);
      expect((await deployed.deploy()).ok, mode.name).toBe(true);
      const mf = await serve(deployed, mode.vars);
      for (const [route, answer] of Object.entries(await answers(mf)))
        expect(
          ["401 unauthenticated", "302", "503 not_configured"],
          `${mode.name}: ${route}`,
        ).toContain(answer);
    }

    // Each request above reaches the Worker with no Access in front of it, so the refusal is the Worker's own on every
    // route. Access bypasses none of the gated routes at the edge either (FD-OPS-088).
    expect(GATED.filter((r) => bypassed(r.path)).map((r) => r.path)).toEqual([]);
  });

  it("[FD-IFC-023] fd deploy fails its post-deploy probe and pages when the link key equals the webhook secret, the OIDC key or the provenance key, and passes with every key distinct", async () => {
    const ok = account(DISTINCT);
    expect((await ok.deploy()).ok).toBe(true);
    expect(ok.probes).toEqual([
      {
        status: 200,
        body: { status: "ok", deployment: "production", plane_id: "flare-dispatch" },
      },
    ]);

    for (const name of ["WEBHOOK_SECRET", "OIDC_SIGNING_JWK", "PROVENANCE_KEY"] as const) {
      const clash = account({ ...DISTINCT, [name]: DISTINCT.LINK_KEY });
      const logged: unknown[] = [];
      const log = vi
        .spyOn(console, "error")
        .mockImplementation((...args) => void logged.push(...args));
      const failed = await clash.deploy().finally(() => log.mockRestore());
      expect(failed.ok, name).toBe(false);
      expect(failed.stages.at(-1), name).toMatchObject({ stage: "probes", ok: false });
      expect(failed.stages.at(-1)!.detail).toContain("control-plane: GET /health failed");
      expect(clash.probes, name).toEqual([{ status: 503, body: { status: "misconfigured" } }]);
      expect(clash.alarms[0], name).toMatch(/^deploy-probe-failed: /);
      // `/health` is public: the body names neither binding of the clash nor the shared value.
      const body = JSON.stringify(clash.probes);
      for (const leak of ["LINK_KEY", name, DISTINCT.LINK_KEY])
        expect(body, name).not.toContain(leak);
      // The operator reads the refused binding and the reason in the Worker log.
      expect(logged.join("\n"), name).toContain(`LINK_KEY: the link key equals ${name}`);
    }
  });
});

describe("fd deploy and the webhook secret", () => {
  const sign = (secret: string, body: string) =>
    `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const PING = JSON.stringify({ zen: "ok", hook_id: 1, installation: { id: 7 } });
  const webhook = (mf: Miniflare, event: string, signature?: string) =>
    mf.dispatchFetch("https://dispatch.example.com/v1/webhooks/github", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": event,
        "x-github-delivery": `delivery-${event}`,
        ...(signature === undefined ? {} : { "x-hub-signature-256": signature }),
      },
      body: PING,
    });
  const rows = async (mf: Miniflare, table: string) =>
    (await (await mf.getD1Database("DB")).prepare(`select count(*) as n from ${table}`).first<{
      n: number;
    }>())!.n;

  it("[FD-INT-022] a deploy whose account holds no webhook secret answers every webhook 503 webhook_unconfigured and submits nothing", async () => {
    const { WEBHOOK_SECRET: _secret, ...withoutSecret } = DISTINCT;
    for (const [name, secrets] of [
      ["absent", withoutSecret],
      ["empty", { ...withoutSecret, WEBHOOK_SECRET: "" }],
    ] as const) {
      const deployed = account(secrets);
      expect((await deployed.deploy()).ok, name).toBe(true);
      const mf = await serve(deployed);
      for (const response of [
        await webhook(mf, "ping"),
        await webhook(mf, "ping", sign(DISTINCT.WEBHOOK_SECRET, PING)),
        await webhook(mf, "push", sign("", PING)),
        await webhook(mf, "pull_request", "sha256=00"),
      ]) {
        expect(response.status, name).toBe(503);
        expect(await response.json(), name).toMatchObject({ error: "webhook_unconfigured" });
      }
      expect(await rows(mf, "intake_deliveries"), name).toBe(0);
      expect(await rows(mf, "intake_records"), name).toBe(0);
    }

    // With the secret, the same signed delivery is verified and recorded.
    const configured = account(DISTINCT);
    expect((await configured.deploy()).ok).toBe(true);
    const mf = await serve(configured);
    const accepted = await webhook(mf, "ping", sign(DISTINCT.WEBHOOK_SECRET, PING));
    expect(accepted.status).toBeLessThan(300);
    expect(await rows(mf, "intake_deliveries")).toBe(1);
  });
});
