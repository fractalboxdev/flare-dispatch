// The deploy suites of `V-DEPLOY` for the Worker templates (specs/operability.md § Template and overlay): each Worker
// the deploy carries has one committed template whose account-specific values are placeholders and which sets
// `keep_vars` to `false`, checked the way the `deploy-dry-run` job checks it (`staticDrift`) and the way `fd deploy`'s
// drift stage does, on the fakes of `support.ts`.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  parseJsonc,
  placeholderOverlay,
  renderTemplate,
  type OverlayValues,
} from "../../src/index.ts";
import { staticDrift, V2_WORKERS, type WorkerSpec } from "../../src/cli/index.ts";
import {
  CONTROL_PLANE,
  deploy,
  fd,
  isWrite,
  OVERLAY,
  ROOT,
  SCRIPT,
  since,
  world,
} from "./support.ts";

const DOCS = V2_WORKERS.find((w) => w.worker === "docs")!;
const templateOf = (spec: WorkerSpec) => readFileSync(join(ROOT, spec.templatePath), "utf8");
const DOCS_TEMPLATE = templateOf(DOCS);
const CONTROL_PLANE_TEMPLATE = templateOf(CONTROL_PLANE);
const MINUTE_TICK_LINE = '"triggers": { "crons": ["* * * * *"] },';

/** The committed docs template with one edit, which must apply. */
const editedDocs = (from: string | RegExp, to: string): string => {
  const text = DOCS_TEMPLATE.replace(from, to);
  expect(text).not.toBe(DOCS_TEMPLATE);
  return text;
};

const docsFindings = (template: string) =>
  Effect.runSync(staticDrift(DOCS, template, placeholderOverlay)).findings;

/** An operator's overlay whose hostnames differ from the placeholder overlay's. */
const ACME: OverlayValues = {
  ...placeholderOverlay,
  hostnames: { dispatcher: "dispatch.acme.test", docs: "docs.acme.test" },
};

let dir: string;
let n = 0;
/**
 * The Workers of the deploy, with the docs Worker deployed from `template`, written to a directory of its own under the
 * repository root; `built` puts the site build's `dist` beside it.
 */
const workersWithDocs = (template: string, built = true): readonly WorkerSpec[] => {
  const app = join(dir, `docs-${++n}`);
  mkdirSync(built ? join(app, "dist") : app, { recursive: true });
  const path = join(app, "wrangler.jsonc");
  writeFileSync(path, template);
  return V2_WORKERS.map((s) =>
    s.worker === "docs" ? { ...s, templatePath: relative(ROOT, path) } : s,
  );
};

/** The control-plane template with its cron trigger replaced by `triggers`, written beside the other harness files. */
const controlPlaneWith = (triggers: string): readonly WorkerSpec[] => {
  expect(CONTROL_PLANE_TEMPLATE).toContain(MINUTE_TICK_LINE);
  const path = join(dir, `control-plane-${++n}.jsonc`);
  writeFileSync(path, CONTROL_PLANE_TEMPLATE.replace(MINUTE_TICK_LINE, triggers));
  return [{ ...CONTROL_PLANE, templatePath: relative(ROOT, path) }];
};

const driftStage = (report: {
  readonly stages: readonly { stage: string; ok: boolean; detail: string }[];
}) => report.stages.find((s) => s.stage === "drift");

beforeAll(() => {
  mkdirSync(join(ROOT, ".tmp"), { recursive: true });
  dir = mkdtempSync(join(ROOT, ".tmp", "templates-harness-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("the committed Worker templates", () => {
  it("[FD-OPS-001] every Worker the deploy carries has its own committed template, and every account-specific value in it is a placeholder the overlay fills", () => {
    expect(V2_WORKERS.map((w) => w.worker)).toEqual(["control-plane", "docs"]);
    const paths = V2_WORKERS.map((w) => w.templatePath);
    expect(new Set(paths).size).toBe(paths.length);
    for (const spec of V2_WORKERS) {
      expect(existsSync(join(ROOT, spec.templatePath)), spec.templatePath).toBe(true);
      expect(
        Effect.runSync(staticDrift(spec, templateOf(spec), placeholderOverlay)).findings,
        spec.worker,
      ).toEqual([]);
    }

    // The docs Worker's custom domain is the overlay's `hostnames.docs`, and nothing else in its template changes.
    expect(parseJsonc(DOCS_TEMPLATE)["routes"]).toEqual([
      { pattern: "{{hostnames.docs}}", custom_domain: true },
    ]);
    const rendered = Effect.runSync(renderTemplate("docs", DOCS_TEMPLATE, ACME));
    expect(rendered).toBe(DOCS_TEMPLATE.replace('"{{hostnames.docs}}"', '"docs.acme.test"'));
    expect(parseJsonc(rendered)["routes"]).toEqual([
      { pattern: "docs.acme.test", custom_domain: true },
    ]);

    // A hostname written into the template fails the drift check, naming the path.
    expect(docsFindings(editedDocs('"{{hostnames.docs}}"', '"docs.acme.test"'))).toEqual([
      {
        check: "placeholder",
        path: "docs.routes[0].pattern",
        detail: "an account-specific value is not a placeholder",
        severity: "failure",
      },
    ]);
  });

  it("[FD-OPS-001] fd deploy deploys the docs Worker on its hostname from the overlay, and a hostname written into its template stops the deploy at the drift stage", async () => {
    const w = world();
    const report = await deploy(w, OVERLAY, { workers: workersWithDocs(DOCS_TEMPLATE) });
    expect(driftStage(report)).toMatchObject({ ok: true });
    expect(report.ok).toBe(true);
    expect(w.calls).toContain("wrangler deploy flare-dispatch-docs");
    expect(w.scripts.get("flare-dispatch-docs")?.domains).toEqual([
      placeholderOverlay.hostnames["docs"],
    ]);

    const hardCoded = world();
    const failed = await deploy(hardCoded, OVERLAY, {
      workers: workersWithDocs(editedDocs('"{{hostnames.docs}}"', '"docs.acme.test"')),
    });
    expect(failed.ok).toBe(false);
    expect(driftStage(failed)).toMatchObject({ ok: false });
    expect(driftStage(failed)!.detail).toContain("docs.routes[0].pattern");
    expect(hardCoded.calls.filter(isWrite)).toEqual([]);
  });

  it("[FD-OPS-009] fd deploy with no site build beside the docs template stops at the drift stage, before any migration or deploy", async () => {
    const w = world();
    const report = await deploy(w, OVERLAY, { workers: workersWithDocs(DOCS_TEMPLATE, false) });
    expect(report.ok).toBe(false);
    expect(driftStage(report)).toMatchObject({ ok: false });
    expect(driftStage(report)!.detail).toContain("docs.assets.directory");
    expect(report.stages.map((s) => s.stage)).not.toContain("migrations");
    expect(w.calls.filter(isWrite)).toEqual([]);
  });

  it("[FD-OPS-012] every committed template sets keep_vars to false, and a docs template that does not fails the drift check and stops fd deploy", async () => {
    for (const spec of V2_WORKERS)
      expect(parseJsonc(templateOf(spec))["keep_vars"], spec.worker).toBe(false);

    const keepVarsFinding = {
      check: "keep_vars",
      path: "docs.keep_vars",
      detail: "every template sets keep_vars to false",
      severity: "failure",
    };
    const dropped = editedDocs(/\n\s*"keep_vars": false,/, "");
    const kept = editedDocs('"keep_vars": false', '"keep_vars": true');
    expect(docsFindings(dropped)).toEqual([keepVarsFinding]);
    expect(docsFindings(kept)).toEqual([keepVarsFinding]);

    for (const template of [dropped, kept]) {
      const w = world();
      const report = await deploy(w, OVERLAY, { workers: workersWithDocs(template) });
      expect(report.ok).toBe(false);
      expect(driftStage(report)).toMatchObject({ ok: false });
      expect(driftStage(report)!.detail).toContain("docs.keep_vars");
      expect(w.calls.filter(isWrite)).toEqual([]);
    }
  });
});

describe("the cron set of each committed template and deployed Worker", () => {
  it("[FD-INT-050] the dispatcher's template declares only the minute tick and the docs template none, and fd deploy stops at the drift stage on a rendered configuration with any other cron set", async () => {
    const crons = (text: string) =>
      (parseJsonc(text)["triggers"] as { crons?: unknown } | undefined)?.crons;
    expect(crons(CONTROL_PLANE_TEMPLATE)).toEqual(["* * * * *"]);
    expect(crons(DOCS_TEMPLATE)).toBeUndefined();

    for (const [triggers, set] of [
      ['"triggers": { "crons": ["*/5 * * * *"] },', '["*/5 * * * *"]'],
      ['"triggers": { "crons": ["* * * * *", "0 * * * *"] },', '["* * * * *","0 * * * *"]'],
      ['"triggers": { "crons": [] },', "[]"],
      ["", "[]"],
    ] as const) {
      const [spec] = controlPlaneWith(triggers);
      expect(
        Effect.runSync(staticDrift(spec!, templateOf(spec!), placeholderOverlay)).findings,
        triggers,
      ).toEqual([
        {
          check: "cron",
          path: "control-plane.triggers.crons",
          detail: `cron set ${set} is not ["* * * * *"]`,
          severity: "failure",
        },
      ]);
      const w = world();
      const report = await deploy(w, OVERLAY, { workers: [spec!] });
      expect(report.ok, triggers).toBe(false);
      expect(report.stages.at(-1), triggers).toEqual({
        stage: "drift",
        ok: false,
        detail: `control-plane.triggers.crons: cron set ${set} is not ["* * * * *"]`,
      });
      expect(w.calls.filter(isWrite), triggers).toEqual([]);
    }

    // A static-assets Worker runs no scheduled handler: a cron trigger on the docs template fails the check.
    const docsWithCron = editedDocs(
      '"keep_vars": false,',
      '"keep_vars": false,\n  "triggers": { "crons": ["* * * * *"] },',
    );
    expect(docsFindings(docsWithCron)).toEqual([
      {
        check: "cron",
        path: "docs.triggers.crons",
        detail: 'cron set ["* * * * *"] on a Worker with no script',
        severity: "failure",
      },
    ]);
    const w = world();
    const report = await deploy(w, OVERLAY, { workers: workersWithDocs(docsWithCron) });
    expect(report.ok).toBe(false);
    expect(driftStage(report)).toMatchObject({ ok: false });
    expect(driftStage(report)!.detail).toContain("docs.triggers.crons");
    expect(w.calls.filter(isWrite)).toEqual([]);
  });

  it("[FD-INT-050] fd deploy and fd doctor fail a deployed Worker whose live cron set differs from its template's, with or without a record of the last deploy", async () => {
    const w = world();
    const workers = workersWithDocs(DOCS_TEMPLATE);
    expect((await deploy(w, OVERLAY, { workers })).ok).toBe(true);
    expect(w.scripts.get(SCRIPT)!.crons).toEqual(["* * * * *"]);
    expect(w.scripts.get("flare-dispatch-docs")!.crons).toEqual([]);

    // The cron triggers change out of band, and the records of the last deploy are gone.
    w.scripts.get(SCRIPT)!.crons = ["*/5 * * * *"];
    w.scripts.get("flare-dispatch-docs")!.crons = ["0 * * * *"];
    w.objects.clear();
    const expected = [
      'control-plane.crons: deployed cron set ["*/5 * * * *"] is not ["* * * * *"]',
      'docs.crons: deployed cron set ["0 * * * *"] is not []',
    ];

    const doctor = await Effect.runPromise(fd(w, { workers }).doctor(OVERLAY));
    expect(doctor.ok).toBe(false);
    expect(doctor.stages.at(-1)).toMatchObject({ stage: "drift", ok: false });
    expect(doctor.stages.at(-1)!.detail.split("\n").sort()).toEqual(
      expected.map((line) => `failure ${line}`),
    );

    const from = w.calls.length;
    const report = await deploy(w, OVERLAY, { workers });
    expect(report.ok).toBe(false);
    expect(driftStage(report)).toMatchObject({ ok: false });
    expect(driftStage(report)!.detail.split("\n").sort()).toEqual(expected);
    expect(report.stages.map((s) => s.stage)).not.toContain("deploy");
    expect(since(w, from).filter(isWrite)).toEqual([]);

    // The minute tick restored, the deploy goes out again.
    w.scripts.get(SCRIPT)!.crons = ["* * * * *"];
    w.scripts.get("flare-dispatch-docs")!.crons = [];
    expect((await deploy(w, OVERLAY, { workers })).ok).toBe(true);
  });
});
