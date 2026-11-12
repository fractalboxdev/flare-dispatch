import { ModelClient, modelGatewayClientLayer } from "@fractalboxdev/flare-dispatch-agentic";
import {
  agenticRuns,
  type CloudAgenticServices,
} from "@fractalboxdev/flare-dispatch-agentic/executor";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { buildProfile, credentialedGrantLabels } from "@fractalboxdev/flare-dispatch-profile";
import {
  attachGrants,
  carriesCredential,
  executionGrantRules,
  MODEL_GATEWAY_PATH,
} from "./egress.ts";
import { runsFor } from "./runs.ts";

const HOST = "cp.example.com";
const LEASE_TOKEN = "fd-lease-token-0123456789abcdef";
const rules = executionGrantRules(HOST);
const proxy = (request: Request) =>
  attachGrants(
    request,
    ["model-gateway"],
    (g) => (g === "model-gateway" ? LEASE_TOKEN : undefined),
    rules,
  );

describe("the model-gateway grant", () => {
  it("[FD-AGT-010] the proxy alone attaches the per-lease token to the sandbox's model request", async () => {
    const leftSandbox: Request[] = [];
    const upstream: Request[] = [];
    const layer = modelGatewayClientLayer({
      url: `https://${HOST}${MODEL_GATEWAY_PATH}completions`,
      forbidden: [],
      fetch: (async (url: string, init: RequestInit) => {
        const request = new Request(url, init);
        leftSandbox.push(request.clone());
        upstream.push(proxy(request));
        return new Response(JSON.stringify({ text: "ok" }));
      }) as unknown as typeof fetch,
    });
    const answer = await Effect.runPromise(
      Effect.flatMap(ModelClient, (m) =>
        m.complete({
          callSite: "c",
          tier: "transform",
          messages: [{ role: "user", content: "hi" }],
        }),
      ).pipe(Effect.provide(layer)),
    );
    expect(answer).toBe("ok");
    expect(leftSandbox[0]?.headers.get("authorization")).toBeNull();
    expect(await leftSandbox[0]?.text()).not.toContain(LEASE_TOKEN);
    expect(upstream[0]?.headers.get("authorization")).toBe(`Bearer ${LEASE_TOKEN}`);
  });

  it("[FD-AGT-010] covers only the model route over HTTPS, and replaces a token the job authors", () => {
    const auth = (url: string, headers: Record<string, string> = {}) =>
      proxy(new Request(url, { headers })).headers.get("authorization");
    expect(auth(`https://${HOST}/v1/model/completions`, { authorization: "Bearer forged" })).toBe(
      `Bearer ${LEASE_TOKEN}`,
    );
    expect(auth(`https://${HOST}/v1/executions/x-1/logs`)).toBeNull();
    expect(auth(`https://${HOST}/v1/model/../executions/x-1/logs`)).toBeNull();
    expect(
      auth(`https://${HOST}/v1/dispatch/check`, { authorization: "Bearer forged" }),
    ).toBeNull();
    expect(auth("https://evil.example.com/v1/model/completions")).toBeNull();
    expect(auth(`http://${HOST}/v1/model/completions`)).toBeNull();
    expect(
      attachGrants(
        new Request("https://api.cloudflare.com/client/v4"),
        ["cf-api"],
        () => "cf",
        rules,
      ).headers.get("authorization"),
    ).toBe("Bearer cf");
  });
});

describe("credentialed grants", () => {
  it("[FD-ISO-022] cf-api carries a credential and no base grant does, so only a run declaring one loses gha", () => {
    expect(carriesCredential("cf-api")).toBe(true);
    for (const grant of ["package-registries", "git-remote", "model-gateway", "unknown"])
      expect(carriesCredential(grant)).toBe(false);
    const profile = buildProfile("production", 4);
    expect(credentialedGrantLabels(profile, undefined, carriesCredential)).toEqual([]);
    expect(
      credentialedGrantLabels(profile, { setup: ["cf-api"], agent: [] }, carriesCredential),
    ).toEqual(["credentialed-grant"]);
  });
});

describe("the cloud runner entry", () => {
  it("serves the agentic recipes on the cloud executor, each with the cloud Layers provided", () => {
    const layers = Layer.empty as unknown as Layer.Layer<CloudAgenticServices>;
    const cloud = runsFor("development", { kind: "cloud", layers });
    expect(cloud.map((r) => r.spec.name)).toEqual(agenticRuns.map((r) => r.spec.name));
    for (const run of cloud)
      expect(run.layer).not.toBe(agenticRuns.find((a) => a.spec.name === run.spec.name)?.layer);
    expect(runsFor("development").map((r) => r.spec.name)).toEqual(["check", "oxlint", "gate-job"]);
  });
});
