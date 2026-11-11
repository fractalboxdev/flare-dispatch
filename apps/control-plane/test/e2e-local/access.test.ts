// The identity gates of the deployed Worker, reached over HTTP: every `/v1/*` route whose surface names no other check,
// and every dashboard page and route, verify the Access JWT against the overlay's `access.teamDomain` and `access.aud`
// before any route logic runs.
import type { RouteSpec } from "@fractalboxdev/flare-dispatch-api";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { router } from "../../src/http.ts";
import { OPERATOR } from "../support.ts";
import { startStack, WEBHOOK_SECRET, type Stack } from "./stack.ts";

let stack: Stack;

beforeAll(async () => {
  stack = await startStack();
});

afterAll(async () => {
  await stack?.close();
});

/** A concrete path for a route pattern: each `:param` and a trailing `*` filled in. */
const concrete = (path: string) =>
  path.replace(/:[A-Za-z_]+/g, "01E2EGATE0000000000000000").replace(/\*$/, "x");

const send = (method: string, path: string, headers: Record<string, string>) =>
  fetch(`${stack.url}${path}`, {
    method,
    headers: { accept: "application/json", ...headers },
    redirect: "manual",
    ...(method === "GET" || method === "HEAD"
      ? {}
      : {
          body: "{}",
          headers: { accept: "application/json", "content-type": "application/json", ...headers },
        }),
  });

/** A JWT no key of the team signed. */
const FORGED = { "cf-access-jwt-assertion": "eyJhbGciOiJSUzI1NiJ9.e30.c2ln" };

/** The paths the operability routes serve beside the declared groups: the dashboard, the fleet and the install flow. */
const OPERABILITY_PATHS: readonly (readonly [string, string])[] = [
  ["GET", "/"],
  ["GET", "/executions/01E2EGATE0000000000000000"],
  ["GET", "/v1/ops/fleet"],
  ["GET", "/v1/github/install/new"],
  ["GET", "/v1/github/install/callback"],
  ["GET", "/v1/spend"],
];

/** A `/v1/` path no route claims. */
const UNCLAIMED: readonly (readonly [string, string])[] = [
  ["GET", "/v1/no-such-route"],
  ["POST", "/v1/executions/01E2EGATE0000000000000000/no-such-action"],
];

const accessGated = (route: RouteSpec) => route.surface._tag === "Access";

describe("the Access gate on the HTTP API", () => {
  // The routes the Worker's router mounts, each with the surface its group declares.
  const declared = router.routes
    .filter(accessGated)
    .map((r) => [r.method, concrete(r.path)] as const);

  it("[FD-IFC-010] answers 401 with no Access JWT and 403 with one the team did not sign, on every route outside the surfaces that name another check", async () => {
    expect(declared.length).toBeGreaterThan(10);
    for (const [method, path] of [...declared, ...OPERABILITY_PATHS, ...UNCLAIMED]) {
      const none = await send(method, path, {});
      expect({ method, path, status: none.status }).toEqual({ method, path, status: 401 });
      expect(((await none.json()) as { error: string }).error).toBe("unauthenticated");
      const forged = await send(method, path, FORGED);
      expect({ method, path, status: forged.status }).toEqual({ method, path, status: 403 });
    }
  });

  it("[FD-IFC-010] serves the surfaces whose identity column names another check without an Access JWT", async () => {
    // Public: `/health` and `/.well-known/*` answer with no identity at all.
    expect((await send("GET", "/health", {})).status).toBe(200);
    for (const route of router.routes) {
      if (route.surface._tag !== "Public") continue;
      const r = await send(route.method, concrete(route.path), {});
      expect([401, 403]).not.toContain(r.status);
    }
    // The webhook's HMAC alone admits a delivery that carries no Access JWT.
    const ping = stack.github.delivery("ping", "ping.json", WEBHOOK_SECRET);
    const webhook = await fetch(`${stack.url}/v1/webhooks/github`, {
      method: "POST",
      headers: ping.headers,
      body: ping.body,
    });
    expect(webhook.status).toBe(200);
    // The compile cache checks its own token: an Access JWT changes nothing about its answer.
    const path = "/v1/compile-cache/acme/widgets/ns/key";
    const bare = await send("GET", path, {});
    const withAccess = await send("GET", path, await stack.access(OPERATOR));
    expect(bare.status).not.toBe(401);
    expect(withAccess.status).toBe(bare.status);
  });
});

describe("the dashboard's identity gate", () => {
  /** Every dashboard page and JSON route, each with the status a valid operator token gets past the gate. */
  const pages: readonly (readonly [string, number])[] = [
    ["/", 200],
    ["/executions/01E2EGATE0000000000000000", 404],
    ["/v1/executions", 200],
    ["/v1/ops/health", 200],
    ["/v1/ops/fleet", 200],
  ];

  it("[FD-OPS-064] admits a token only with the overlay's access.aud and access.teamDomain", async () => {
    const valid = await stack.team.jwt(OPERATOR);
    const otherAud = await stack.team.jwtWith(OPERATOR, { aud: ["another-application"] });
    const otherTeam = await stack.team.jwtWith(OPERATOR, {
      iss: "https://another-team.cloudflareaccess.com",
    });
    expect(stack.overlay.access.teamDomain).toBe(stack.team.teamDomain);
    for (const [path, status] of pages) {
      const header = (jwt: string) => ({ "cf-access-jwt-assertion": jwt });
      expect({ path, status: (await send("GET", path, header(valid))).status }).toEqual({
        path,
        status,
      });
      for (const jwt of [otherAud, otherTeam]) {
        const r = await send("GET", path, header(jwt));
        expect({ path, status: r.status }).toEqual({ path, status: 403 });
        expect(await r.text()).not.toContain("<table");
      }
    }
  });

  it("[FD-OPS-064] sends a browser with no identity to the overlay team's Access login", async () => {
    const r = await fetch(`${stack.url}/`, {
      headers: { accept: "text/html", "sec-fetch-mode": "navigate" },
      redirect: "manual",
    });
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toMatch(
      new RegExp(`^${stack.overlay.access.teamDomain}/cdn-cgi/access/login/`),
    );
  });
});
