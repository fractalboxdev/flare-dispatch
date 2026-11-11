// The route group as the Worker mounts it: `intakeLayer` over `githubLiveLayer`, a GitHub reached through `fetch`,
// and mameko's admission on a SQLite D1.
import { generateKeyPairSync } from "node:crypto";
import { githubLiveLayer, SideOutputConfig } from "@fractalboxdev/flare-dispatch-github";
import { buildProfile } from "@fractalboxdev/flare-dispatch-profile";
import { AlarmPort } from "@fractalboxdev/mameko-ports";
import { Effect, Layer, ManagedRuntime } from "effect";
import { describe, expect, it } from "vitest";
import { AccessIdentity } from "./dispatch.ts";
import {
  APP_ID,
  BASE,
  bodyOf,
  CATALOG,
  DEFAULT_MANIFEST,
  HEAD,
  pullRequestPayload,
  REPO,
  SECRET,
  signedWebhook,
} from "./harness.test-support.ts";
import { intakeLayer, profileClassResolver } from "./layer.ts";
import { ExecutionCanceller } from "./ports.ts";
import { handleIntake } from "./routes.ts";
import { migratedD1 } from "./testing.ts";

const PEM = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs1", format: "pem" })
  .toString();

const github = (manifestText: string, calls: string[], required: readonly string[] = []) =>
  (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const route = `${init?.method ?? "GET"} ${url.pathname}`;
    calls.push(route);
    const ok = (body: unknown, status = 200) => Response.json(body, { status });
    switch (route) {
      case `GET /repos/${REPO}/installation`:
        return ok({ id: 7 });
      case "POST /app/installations/7/access_tokens":
        return ok({ token: "ghs_test", expires_at: "2099-01-01T00:00:00Z" }, 201);
      case `GET /repos/${REPO}`:
        return ok({ default_branch: "main" });
      case `GET /repos/${REPO}/branches/main`:
        return ok({ commit: { sha: BASE } });
      case `GET /repos/${REPO}/rules/branches/main`:
        return ok(
          required.length === 0
            ? []
            : [
                {
                  type: "required_status_checks",
                  parameters: { required_status_checks: required.map((context) => ({ context })) },
                },
              ],
        );
      case `GET /repos/${REPO}/contents/.github/flare-dispatch.json`:
        return ok({
          type: "file",
          size: manifestText.length,
          encoding: "base64",
          content: Buffer.from(manifestText).toString("base64"),
        });
      case `POST /repos/${REPO}/check-runs`:
        return ok(
          {
            id: 1,
            name: "flare-dispatch/manifest",
            external_id: null,
            status: "completed",
            conclusion: "failure",
            output: { title: null, summary: null },
          },
          201,
        );
      default:
        return ok({ message: "Not Found" }, 404);
    }
  }) as typeof globalThis.fetch;

const worker = async (manifestText = DEFAULT_MANIFEST, required: readonly string[] = []) => {
  const db = await migratedD1();
  const calls: string[] = [];
  const fetch = github(manifestText, calls, required);
  const alarms = Layer.succeed(AlarmPort, { deliver: () => Effect.void });
  const githubLayer = githubLiveLayer({ appId: String(APP_ID), privateKeyPem: PEM, fetch }).pipe(
    Layer.provide(
      Layer.mergeAll(
        alarms,
        Layer.succeed(SideOutputConfig, {
          appBot: { login: "app[bot]", name: "app[bot]", email: "app@example.com" },
          slack: undefined,
          fetch,
        }),
      ),
    ),
  );
  const intake = intakeLayer({
    db,
    fetch,
    settings: {
      catalog: (name) => CATALOG[name],
      profile: buildProfile("production"),
      appId: APP_ID,
      webhookSecret: SECRET,
      webhookEvents: undefined,
      oidcAudience: undefined,
      dispatchers: [],
      allows: () => true,
      confidentiality: () => "unclassified",
    },
  });
  const layer = Layer.mergeAll(
    intake,
    Layer.succeed(AccessIdentity, { identity: () => Effect.succeed(null) }),
    Layer.succeed(ExecutionCanceller, { cancel: () => Effect.void }),
  ).pipe(
    Layer.provideMerge(profileClassResolver.pipe(Layer.provide(alarms))),
    Layer.provideMerge(intake),
    Layer.provideMerge(githubLayer),
  );
  const runtime = ManagedRuntime.make(layer);
  return {
    db,
    calls,
    handle: (r: Request, path: string) => runtime.runPromise(handleIntake(r, path)),
  };
};

describe("the intake routes on the live Layers", () => {
  it("[FD-INT-001] [FD-INT-016] a signed pull request reaches admission through the App's token and reads", async () => {
    const w = await worker();
    const r = await w.handle(
      await signedWebhook("pull_request", pullRequestPayload()),
      "webhooks/github",
    );
    expect(r!.status).toBe(202);
    expect((await bodyOf(r)).executions).toHaveLength(2);
    const executions = w.db.sqlite.prepare("select run, class from executions order by run").all();
    expect(executions).toEqual([
      { run: "check", class: "interactive" },
      { run: "lint", class: "batch" },
    ]);
    expect(w.calls).toContain(`GET /repos/${REPO}/branches/main`);
    expect(w.db.sqlite.prepare("select sha from intake_records").all()).toEqual([
      { sha: HEAD },
      { sha: HEAD },
    ]);
  });

  it("[FD-PROF-013] [FD-PROF-014] a gating run whose check the base branch's ruleset requires resolves to required", async () => {
    const w = await worker(DEFAULT_MANIFEST, ["flare-dispatch/check:ci"]);
    await w.handle(await signedWebhook("pull_request", pullRequestPayload()), "webhooks/github");
    expect(w.db.sqlite.prepare("select run, class from executions order by run").all()).toEqual([
      { run: "check", class: "required" },
      { run: "lint", class: "batch" },
    ]);
    expect(w.calls).toContain(`GET /repos/${REPO}/rules/branches/main`);
  });

  it("[FD-INT-018] an invalid manifest posts the failing flare-dispatch/manifest check run through the App", async () => {
    const w = await worker('{"version": 2}');
    await w.handle(await signedWebhook("pull_request", pullRequestPayload()), "webhooks/github");
    expect(w.calls).toContain(`POST /repos/${REPO}/check-runs`);
    expect(w.db.sqlite.prepare("select reason from shed order by id").all()).toEqual([
      { reason: "manifest: invalid" },
    ]);
  });

  it("[FD-INT-034] [FD-IFC-027] a dispatch with no OIDC audience configured and no Access identity answers 401", async () => {
    const w = await worker();
    const r = await w.handle(
      new Request("https://cp.example.com/v1/dispatch/check", { method: "POST", body: "{}" }),
      "dispatch/check",
    );
    expect(r!.status).toBe(401);
  });
});
