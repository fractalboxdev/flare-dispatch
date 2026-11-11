import { Context, Effect } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { beforeAll, describe, expect, it } from "vitest";
import {
  accessClaims,
  actionsClaims,
  baseConfig,
  jwksLayer,
  makeDoubles,
  makeSigner,
  MEMBER,
  now,
  ORIGIN,
  portsContext,
  TEAM,
  type Doubles,
  type Signer,
} from "./api.test-support.ts";
import { ApiConfig, type ApiConfigShape } from "./config.ts";
import { declaredGroups } from "./groups.ts";
import { ACTIONS_JWKS, accessIssuer } from "./identity.ts";
import { mintLinkToken } from "./link-token.ts";
import { mount, routerGroup, toFetchHandler } from "./router.ts";

/** A stand-in for the cache-artifacts log route, mounted on the link surface. */
const logsGroup = routerGroup(
  "logs",
  [
    {
      method: "GET",
      path: "/v1/executions/:id/logs",
      surface: { _tag: "Link", purpose: "logs", param: "id" },
    },
  ],
  HttpRouter.add(
    "GET",
    "/v1/executions/:id/logs",
    Effect.succeed(HttpServerResponse.text("log lines")),
  ),
);

let access: Signer;
let actions: Signer;
let doubles: Doubles;
let call: (path: string, init?: RequestInit, config?: ApiConfigShape) => Promise<Response>;

beforeAll(async () => {
  access = await makeSigner("access-kid");
  actions = await makeSigner("actions-kid");
  doubles = makeDoubles();
  const handler = toFetchHandler(mount(...declaredGroups, logsGroup), {
    shared: jwksLayer({
      [`${accessIssuer(TEAM)}/cdn-cgi/access/certs`]: [access.jwk],
      [ACTIONS_JWKS]: [actions.jwk],
    }),
  });
  call = (path, init = {}, config = baseConfig()) =>
    handler.fetch(
      new Request(path.startsWith("http") ? path : `${ORIGIN}${path}`, init),
      portsContext(doubles).pipe(Context.add(ApiConfig, config)) as never,
    );
});

const token = (overrides: { objectId?: string; expiresAtS?: number; epoch?: number } = {}) =>
  mintLinkToken("link-key-for-tests", {
    purpose: "logs",
    objectId: overrides.objectId ?? "exec-1",
    expiresAtS: overrides.expiresAtS ?? now() + 600,
    epoch: overrides.epoch ?? 0,
  });

describe("link surface", () => {
  it("[FD-IFC-017]: a log route serves an Access identity or a link token bound to that execution", async () => {
    const jwt = await access.sign(accessClaims(MEMBER));
    expect(
      (await call("/v1/executions/exec-1/logs", { headers: { "cf-access-jwt-assertion": jwt } }))
        .status,
    ).toBe(200);
    expect((await call(`/v1/executions/exec-1/logs?t=${await token()}`)).status).toBe(200);
    const other = await call(`/v1/executions/exec-2/logs?t=${await token()}`);
    expect(other.status).toBe(403);
    expect(((await other.json()) as { error: string }).error).toBe("forbidden");
  });

  it("[FD-IFC-020]: an expired link token answers 403 link_expired", async () => {
    const response = await call(
      `/v1/executions/exec-1/logs?t=${await token({ expiresAtS: now() - 5 })}`,
    );
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: string }).error).toBe("link_expired");
  });

  it("[FD-IFC-021]: a link token below the current epoch answers 403 link_revoked", async () => {
    const response = await call(
      `/v1/executions/exec-1/logs?t=${await token({ epoch: 1 })}`,
      {},
      baseConfig({ linkEpoch: 2 }),
    );
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: string }).error).toBe("link_revoked");
  });

  it("[FD-IFC-013]: a browser with neither is redirected to the Access login; an API caller gets 401", async () => {
    const browser = await call("/v1/executions/exec-1/logs", {
      headers: { accept: "text/html" },
      redirect: "manual",
    });
    expect(browser.status).toBe(302);
    expect(browser.headers.get("location")).toMatch(
      /^https:\/\/team\.example\.com\/cdn-cgi\/access\/login\//,
    );
    expect((await call("/v1/executions/exec-1/logs")).status).toBe(401);
  });

  it("[FD-IFC-035], [FD-IFC-019]: a dispatch answers details and logs links whose token opens that execution's logs", async () => {
    const jwt = await actions.sign(actionsClaims("acme/widgets"));
    doubles.intake = () =>
      Effect.succeed({ _tag: "Admitted", executionId: "exec-1", class: "batch" });
    const response = await call("/v1/dispatch/check", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${jwt}` },
      body: JSON.stringify({ repository: "acme/widgets", inputs: {} }),
    });
    expect(response.status).toBe(202);
    const dispatched = (await response.json()) as Record<string, string>;
    expect(Object.keys(dispatched).sort()).toEqual([
      "class",
      "details_url",
      "execution_id",
      "logs_url",
    ]);
    expect(dispatched["details_url"]).toMatch(
      /^https:\/\/dispatcher\.example\.com\/executions\/exec-1\?t=/,
    );
    const expiry = Number(new URL(dispatched["logs_url"]!).searchParams.get("t")!.split(".")[0]);
    expect(expiry - now()).toBeGreaterThan(86_400 - 10);
    expect(expiry - now()).toBeLessThanOrEqual(86_400);
    expect((await call(dispatched["logs_url"]!)).status).toBe(200);
  });
});
