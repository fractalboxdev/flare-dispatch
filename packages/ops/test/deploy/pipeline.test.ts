// The deploy suites of `V-DEPLOY` (specs/verification.md § Harness catalog) for the deploy pipeline: `fd deploy` and
// `fd doctor` over the committed Worker templates and the placeholder overlay, on the fakes of `support.ts`.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { placeholderOverlay } from "../../src/index.ts";
import { V2_WORKERS, type WorkerSpec } from "../../src/cli/index.ts";
import {
  API,
  CONTROL_PLANE,
  deploy,
  fd,
  isWrite,
  OVERLAY,
  RECORD,
  RENDERED,
  ROOT,
  SCRIPT,
  since,
  version,
  world,
} from "./support.ts";

// A second Worker whose template binds the control plane as a service, beside the committed templates.
let edgeDir: string;
let EDGE: WorkerSpec;
beforeAll(() => {
  mkdirSync(join(ROOT, ".tmp"), { recursive: true });
  edgeDir = mkdtempSync(join(ROOT, ".tmp", "deploy-harness-"));
  writeFileSync(
    join(edgeDir, "wrangler.jsonc"),
    `{
  "name": "flare-dispatch-edge",
  "account_id": "{{accountId}}",
  "keep_vars": false,
  "triggers": { "crons": ["* * * * *"] },
  "services": [{ "binding": "CONTROL_PLANE", "service": "${SCRIPT}" }],
}`,
  );
  EDGE = {
    worker: "edge",
    templatePath: relative(ROOT, join(edgeDir, "wrangler.jsonc")),
    hostKey: "docs",
    probePath: "/",
  };
});
afterAll(() => rmSync(edgeDir, { recursive: true, force: true }));

describe("fd deploy over the committed templates and the placeholder overlay", () => {
  it("[FD-OPS-003] rejects an overlay key the value schema does not declare, naming its path, before any Cloudflare call", async () => {
    const w = world();
    const overlay = JSON.stringify({
      ...placeholderOverlay,
      alerts: { ...placeholderOverlay.alerts, pager: "https://pager.example.com" },
    });
    const report = await deploy(w, overlay);
    expect(report.ok).toBe(false);
    expect(report.stages).toEqual([
      { stage: "decode", ok: false, detail: expect.stringContaining("alerts.pager") },
    ]);
    expect(w.calls).toEqual([]);
    expect(w.runs).toEqual([]);
  });

  it("[FD-OPS-004] rejects an overlay that lacks a required value, naming its path, before any Cloudflare call", async () => {
    const w = world();
    const { aud: _aud, ...access } = placeholderOverlay.access;
    const report = await deploy(w, JSON.stringify({ ...placeholderOverlay, access }));
    expect(report.ok).toBe(false);
    expect(report.stages).toEqual([
      { stage: "decode", ok: false, detail: expect.stringContaining("access.aud") },
    ]);
    expect(w.calls).toEqual([]);
    expect(w.runs).toEqual([]);
  });

  it("[FD-OPS-009] runs decode, render, drift, migrations, deploys and probes in order, and stops at the first stage that fails", async () => {
    const w = world();
    const report = await deploy(w);
    expect(report.stages.map((s) => [s.stage, s.ok])).toEqual([
      ["decode", true],
      ["render", true],
      ["drift", true],
      ["migrations", true],
      ["deploy", true],
      ["probes", true],
      ["record", true],
    ]);
    // The drift check's last read, the deploy, the probe and the record, in that order; no other write.
    const at = (call: string) => w.calls.indexOf(call);
    const order = [
      at("GET api.github.com/repos/acme/fd/rules/branches/main"),
      at(`wrangler deploy ${SCRIPT}`),
      at("GET dispatch.example.com/health"),
      at(`PUT api.cloudflare.com${API}/r2/buckets/flare-dispatch-artifacts/objects/${RECORD}`),
    ];
    expect(order.every((i, n) => i >= 0 && (n === 0 || i > order[n - 1]!))).toBe(true);
    expect(w.calls.filter(isWrite)).toEqual([
      `wrangler deploy ${SCRIPT}`,
      `PUT api.cloudflare.com${API}/r2/buckets/flare-dispatch-artifacts/objects/${RECORD}`,
    ]);

    // A failing deploy stage: nothing after it runs.
    w.state.wranglerFails = true;
    const from = w.calls.length;
    const failed = await deploy(w);
    expect(failed.ok).toBe(false);
    expect(failed.stages.map((s) => [s.stage, s.ok])).toEqual([
      ["decode", true],
      ["render", true],
      ["drift", true],
      ["migrations", true],
      ["deploy", false],
    ]);
    expect(since(w, from).filter((c) => c.includes("/health") || c.startsWith("PUT "))).toEqual([]);

    // A failing drift stage: no deploy step runs.
    w.state.wranglerFails = false;
    w.scripts.get(SCRIPT)!.crons = ["*/5 * * * *"];
    const before = w.calls.length;
    const drifted = await deploy(w);
    expect(drifted.stages.at(-1)).toMatchObject({ stage: "drift", ok: false });
    expect(since(w, before).filter(isWrite)).toEqual([]);
  });

  it("[FD-OPS-010] deploys a Worker only after every Worker it binds as a service, matched by script name", async () => {
    const w = world();
    // The edge Worker is listed first; its service binding names the control plane's script.
    const report = await deploy(w, OVERLAY, { workers: [EDGE, CONTROL_PLANE] });
    expect(report.ok).toBe(true);
    expect(w.calls.filter((c) => c.startsWith("wrangler deploy"))).toEqual([
      `wrangler deploy ${SCRIPT}`,
      "wrangler deploy flare-dispatch-edge",
    ]);
  });

  it("[FD-OPS-013] a failed post-deploy probe exits non-zero, pages deploy-probe-failed and prints each Worker's rollback line", async () => {
    // First deploy: the Durable Object migrations v1 and v2 are new, so the control plane must fix forward.
    const first = world();
    first.state.health = 503;
    const fresh = await deploy(first);
    expect(fresh.ok).toBe(false);
    expect(fresh.stages.at(-1)).toMatchObject({ stage: "probes", ok: false });
    expect(fresh.stages.at(-1)!.detail).toContain(
      "control-plane: fix forward: rollback blocked by migration v1",
    );

    // A later deploy carrying no migration: the rollback command names the previous version and the script.
    const w = world();
    expect((await deploy(w)).ok).toBe(true);
    w.state.health = 503;
    const report = await deploy(w);
    expect(report.ok).toBe(false);
    const probes = report.stages.at(-1)!;
    expect(probes).toMatchObject({ stage: "probes", ok: false });
    expect(probes.detail.split("\n")).toEqual([
      "control-plane: GET /health failed",
      `wrangler rollback ${version(1)} --name ${SCRIPT}`,
    ]);
    expect(w.alarms).toEqual([
      expect.objectContaining({ alarm: "deploy-probe-failed", severity: "page", state: "raised" }),
    ]);
  });

  it("[FD-OPS-014] never rolls a Worker back: after a failed probe the new version stays deployed until the operator acts", async () => {
    const w = world();
    expect((await deploy(w)).ok).toBe(true);
    w.state.health = 503;
    const from = w.calls.length;
    expect((await deploy(w)).ok).toBe(false);
    expect(w.runs.some((args) => args.includes("rollback"))).toBe(false);
    expect(
      since(w, from).filter((c) => /^(POST|PUT|PATCH|DELETE) api\.cloudflare\.com/.test(c)),
    ).toEqual([]);
    expect(w.scripts.get(SCRIPT)!.versions).toEqual([version(1), version(2)]);
  });

  it("[FD-OPS-015] a clean deploy stores each Worker's rendered configuration in the artifacts bucket as the record", async () => {
    // A failed probe stores no record.
    const failed = world();
    failed.state.health = 503;
    await deploy(failed);
    expect(failed.objects.has(RECORD)).toBe(false);

    const w = world();
    w.putSecret(SCRIPT, "GITHUB_APP_PRIVATE_KEY", "pem-value");
    expect((await deploy(w)).ok).toBe(true);
    const record = JSON.parse(w.objects.get(RECORD)!) as { rendered: string; secrets: string[] };
    expect(record.rendered).toBe(RENDERED);
    expect(record.secrets).toEqual(["GITHUB_APP_PRIVATE_KEY"]);
    const put = w.calls.findIndex((c) => c.startsWith("PUT ") && c.endsWith(RECORD));
    expect(put).toBeGreaterThan(w.calls.indexOf("GET dispatch.example.com/health"));
  });

  it("[FD-OPS-016] reads each deployed Worker's settings through the Cloudflare API and compares them with the record before any deploy step", async () => {
    const w = world();
    expect((await deploy(w)).ok).toBe(true);
    const from = w.calls.length;
    expect((await deploy(w)).ok).toBe(true);
    const second = since(w, from);
    const beforeWrite = second.slice(0, second.findIndex(isWrite));
    for (const read of [
      `${API}/workers/scripts/${SCRIPT}/settings`,
      `${API}/workers/scripts/${SCRIPT}/schedules`,
      `${API}/workers/domains?service=${SCRIPT}`,
      `${API}/containers/applications`,
      `${API}/r2/buckets/flare-dispatch-artifacts/objects/${RECORD}`,
    ])
      expect(beforeWrite).toContain(`GET api.cloudflare.com${read}`);

    // The record compares like with like: right after a deploy, nothing drifts, Container images included.
    const clean = await Effect.runPromise(fd(w).doctor(OVERLAY));
    expect(clean.stages.at(-1)).toEqual({ stage: "drift", ok: true, detail: "" });

    // A Container application resized out of band is a drift.
    w.scripts.get(SCRIPT)!.containers[0]!.max_instances = 1;
    const resized = await Effect.runPromise(fd(w).doctor(OVERLAY));
    expect(resized.stages.at(-1)).toMatchObject({ stage: "drift", ok: false });
    expect(resized.stages.at(-1)!.detail).toContain("control-plane.containers.leanpool");
  });

  it("[FD-OPS-017] a deployed setting that differs from the record fails the drift check with both values, secrets by name only", async () => {
    const w = world();
    w.putSecret(SCRIPT, "GITHUB_APP_PRIVATE_KEY", "pem-value");
    expect((await deploy(w)).ok).toBe(true);
    const cp = w.scripts.get(SCRIPT)!;
    cp.bindings = cp.bindings.map((b) =>
      b["name"] === "ALERT_SINK" ? { ...b, text: "https://other.example.com/hook" } : b,
    );
    cp.crons = ["*/5 * * * *"];
    w.putSecret(SCRIPT, "ROGUE_TOKEN", "hunter2-value");
    w.putSecret(SCRIPT, "GITHUB_APP_PRIVATE_KEY", "rotated-pem-value");
    const from = w.calls.length;
    const report = await deploy(w);
    expect(report.ok).toBe(false);
    const drift = report.stages.at(-1)!;
    expect(drift).toMatchObject({ stage: "drift", ok: false });
    expect(drift.detail.split("\n").sort()).toEqual([
      'control-plane.crons: deployed ["*/5 * * * *"], recorded ["* * * * *"]',
      "control-plane.secrets.ROGUE_TOKEN: secret ROGUE_TOKEN present on the deployed Worker, absent in the record",
      'control-plane.vars.ALERT_SINK: deployed "https://other.example.com/hook", recorded "https://alerts.example.com/hook"',
    ]);
    expect(drift.detail).not.toMatch(/hunter2-value|pem-value/);
    expect(since(w, from).filter(isWrite)).toEqual([]);
  });

  it("[FD-OPS-024] fd doctor runs every drift check over the committed templates and changes no Cloudflare or GitHub state", async () => {
    const w = world();
    expect((await deploy(w)).ok).toBe(true);
    const before = w.snapshot();
    const from = w.calls.length;
    const report = await Effect.runPromise(fd(w, { workers: V2_WORKERS }).doctor(OVERLAY));
    expect(report.stages.map((s) => s.stage)).toEqual(["decode", "render", "drift"]);
    const doctor = since(w, from);
    for (const read of [
      `GET api.cloudflare.com${API}/workers/scripts/${SCRIPT}/settings`,
      `GET api.cloudflare.com${API}/workers/scripts/flare-dispatch-docs/settings`,
      `GET api.cloudflare.com${API}/r2/buckets/flare-dispatch-artifacts/objects/${RECORD}`,
      "GET api.github.com/app",
      "GET api.github.com/repos/acme/fd/rules/branches/main",
    ])
      expect(doctor).toContain(read);
    expect(doctor.filter((c) => c.includes("api.cloudflare.com") && !c.startsWith("GET "))).toEqual(
      [],
    );
    // The one GitHub POST mints the read-only installation token the ruleset read needs.
    expect(doctor.filter((c) => c.includes("api.github.com") && !c.startsWith("GET "))).toEqual([
      "POST api.github.com/app/installations/9/access_tokens",
    ]);
    expect(doctor.filter((c) => c.startsWith("wrangler "))).toEqual([]);
    expect(w.files.size).toBe(0);
    expect(w.alarms).toEqual([]);
    expect(w.snapshot()).toBe(before);
  });
});
