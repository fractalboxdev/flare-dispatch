import { spendDefaults } from "@fractalboxdev/flare-dispatch-profile";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  cronCheck,
  decodeOverlay,
  parseJsonc,
  placeholderOverlay,
  placeholdersOf,
  renderTemplate,
  spendConfigOf,
  templateInvariants,
} from "./index.ts";

const overlay = (patch: Record<string, unknown> = {}) =>
  JSON.stringify({ ...placeholderOverlay, ...patch });
const rejected = (text: string) =>
  Effect.runSync(Effect.flip(decodeOverlay(text))).issues.map((i) => i.path);

const TEMPLATE = `{
  // The control plane.
  "name": "flare-dispatch-control-plane",
  "account_id": "{{accountId}}",
  "keep_vars": false,
  "vars": { "ALERT_SINK": "{{alerts.sink}}", "OPERATORS": "{{operators}}" },
  "d1_databases": [{ "binding": "DB", "database_name": "fd", "database_id": "{{d1.DB}}" }],
  "triggers": { "crons": ["* * * * *"] },
}`;

describe("operator overlay", () => {
  it("[FD-OPS-002] holds only declared values; a binding, migration or cron in the overlay is refused", () => {
    expect(Effect.runSync(decodeOverlay(overlay())).accountId).toBe(placeholderOverlay.accountId);
    expect(rejected(overlay({ durable_objects: { bindings: [] } }))).toEqual(["durable_objects"]);
    expect(rejected(overlay({ triggers: { crons: ["0 * * * *"] } }))).toEqual(["triggers"]);
    expect(rejected(overlay({ migrations: [] }))).toEqual(["migrations"]);
  });

  it("[FD-OPS-003] an undeclared key is refused naming its path, nested keys included", () => {
    expect(rejected(overlay({ access: { teamDomain: "t", aud: "a", extra: 1 } }))).toEqual([
      "access.extra",
    ]);
    expect(rejected("not json")).toEqual([""]);
  });

  it("[FD-OPS-004] a missing required value is refused naming its path", () => {
    const { github: _g, ...rest } = placeholderOverlay;
    expect(rejected(JSON.stringify(rest))).toEqual(["github"]);
    expect(rejected(overlay({ access: { teamDomain: "t" } }))).toEqual(["access.aud"]);
  });

  it("[FD-OPS-056] an overlay with no alert sink, or a sink that is neither HTTPS nor email, is refused", () => {
    const { alerts: _a, ...rest } = placeholderOverlay;
    expect(rejected(JSON.stringify(rest))).toEqual(["alerts"]);
    expect(rejected(overlay({ alerts: { sink: "http://plain.example.com" } }))).toEqual([
      "alerts.sink",
    ]);
    expect(
      Effect.runSync(decodeOverlay(overlay({ alerts: { sink: "ops@example.com" } }))).alerts.sink,
    ).toBe("ops@example.com");
  });

  it("[FD-PROF-054] [FD-OPS-083] the overlay's spend values replace their defaults; unset ones keep them", () => {
    expect(spendConfigOf(placeholderOverlay)).toEqual(spendDefaults);
    const s = spendConfigOf({
      ...placeholderOverlay,
      spend: { budgetUsd: 120, releaseReserveUsd: 15 },
    });
    expect(s.budget).toBe(120_000_000);
    expect(s.reserves["release-reserve"]).toBe(15_000_000);
    expect(s.overhead_factor).toBe(1.1);
  });

  it("[FD-PROV-077] an overlay whose attestation_max_age is below reattest_interval plus 48 h is refused, each value at its default where the overlay sets none", () => {
    const provenance = (p: Record<string, number>) => overlay({ provenance: p });
    const accepted = (text: string) => Effect.runSync(decodeOverlay(text)).provenance;
    // Defaults: 10 days against 7 days plus 48 h.
    expect(Effect.runSync(decodeOverlay(overlay())).accountId).toBe(placeholderOverlay.accountId);
    // Exactly the interval plus 48 h is the floor.
    expect(accepted(provenance({ attestationMaxAgeDays: 9, reattestIntervalDays: 7 }))).toEqual({
      attestationMaxAgeDays: 9,
      reattestIntervalDays: 7,
    });
    expect(rejected(provenance({ attestationMaxAgeDays: 8, reattestIntervalDays: 7 }))).toEqual([
      "provenance.attestationMaxAgeDays",
    ]);
    expect(rejected(provenance({ attestationMaxAgeDays: 7, reattestIntervalDays: 7 }))).toEqual([
      "provenance.attestationMaxAgeDays",
    ]);
    // One value set, the other at its default.
    expect(rejected(provenance({ attestationMaxAgeDays: 8 }))).toEqual([
      "provenance.attestationMaxAgeDays",
    ]);
    expect(rejected(provenance({ reattestIntervalDays: 9 }))).toEqual([
      "provenance.attestationMaxAgeDays",
    ]);
    expect(accepted(provenance({ reattestIntervalDays: 8 }))).toEqual({ reattestIntervalDays: 8 });
    expect(
      accepted(provenance({ attestationMaxAgeDays: 16, reattestIntervalDays: 14 })),
    ).toBeDefined();
    const issue = Effect.runSync(
      Effect.flip(decodeOverlay(provenance({ attestationMaxAgeDays: 8, reattestIntervalDays: 7 }))),
    ).issues[0];
    expect(issue?.message).toBe(
      "attestation_max_age (8 d) is below reattest_interval (7 d) plus 48 h",
    );
  });
});

describe("renderer", () => {
  it("[FD-OPS-005] replaces each placeholder with its value and changes no other byte", () => {
    const out = Effect.runSync(renderTemplate("cp", TEMPLATE, placeholderOverlay));
    expect(out).toContain('"account_id": "00000000000000000000000000000000"');
    expect(out).toContain('"OPERATORS": ["operator@example.com"]');
    expect(out).toContain("// The control plane.");
    // Splitting both texts at the placeholders leaves identical pieces in between.
    const pieces = TEMPLATE.split(/"\{\{[^}]+\}\}"/);
    let rest = out;
    for (const piece of pieces) {
      const at = rest.indexOf(piece);
      expect(at).toBeGreaterThanOrEqual(0);
      rest = rest.slice(at + piece.length);
    }
    expect(placeholdersOf(out)).toEqual([]);
  });

  it("[FD-OPS-006] is pure: the same inputs render byte-identical text", () => {
    const a = Effect.runSync(renderTemplate("cp", TEMPLATE, placeholderOverlay));
    const b = Effect.runSync(renderTemplate("cp", TEMPLATE, structuredClone(placeholderOverlay)));
    expect(a).toBe(b);
  });

  it("[FD-PROF-054] renders the spend placeholders from the overlay, each spend value it leaves out at its default", () => {
    const template = `{"vars": {"SPEND": "{{spend}}", "B": "{{spend.budgetUsd}}", "D": "{{spend.measuredReserveDays}}"}}`;
    const unset = parseJsonc(Effect.runSync(renderTemplate("cp", template, placeholderOverlay)));
    expect(unset["vars"]).toEqual({
      SPEND: {
        budgetUsd: 50,
        fixedUsd: 0,
        releaseReserveUsd: 10,
        opsReserveUsd: 5,
        measuredReserveMinUsd: 20,
        measuredReserveDays: 10,
        overheadFactor: 1.1,
      },
      B: 50,
      D: 10,
    });
    const set = parseJsonc(
      Effect.runSync(
        renderTemplate("cp", template, {
          ...placeholderOverlay,
          spend: { budgetUsd: 120, fixedUsd: 4.5, measuredReserveDays: 14, overheadFactor: 1.25 },
        }),
      ),
    );
    expect(set["vars"]).toEqual({
      SPEND: {
        budgetUsd: 120,
        fixedUsd: 4.5,
        releaseReserveUsd: 10,
        opsReserveUsd: 5,
        measuredReserveMinUsd: 20,
        measuredReserveDays: 14,
        overheadFactor: 1.25,
      },
      B: 120,
      D: 14,
    });
  });

  it("[FD-INT-027] renders intake.webhookEvents as null where the overlay sets no list, keeping an empty list empty", () => {
    const template = `{"vars": {"WEBHOOK_EVENTS": "{{intake.webhookEvents}}"}}`;
    const varsOf = (o: typeof placeholderOverlay) =>
      parseJsonc(Effect.runSync(renderTemplate("cp", template, o)))["vars"];
    expect(varsOf(placeholderOverlay)).toEqual({ WEBHOOK_EVENTS: null });
    expect(varsOf({ ...placeholderOverlay, intake: {} })).toEqual({ WEBHOOK_EVENTS: null });
    expect(varsOf({ ...placeholderOverlay, intake: { webhookEvents: [] } })).toEqual({
      WEBHOOK_EVENTS: [],
    });
    expect(
      varsOf({ ...placeholderOverlay, intake: { webhookEvents: ["push", "pull_request"] } }),
    ).toEqual({ WEBHOOK_EVENTS: ["push", "pull_request"] });
  });

  it("renders dispatchers and dispatch.oidcAudience, none and empty where the overlay sets neither", () => {
    const template = `{"vars": {"DISPATCHERS": "{{dispatchers}}", "AUD": "{{dispatch.oidcAudience}}"}}`;
    const varsOf = (o: typeof placeholderOverlay) =>
      parseJsonc(Effect.runSync(renderTemplate("cp", template, o)))["vars"];
    expect(varsOf(placeholderOverlay)).toEqual({ DISPATCHERS: [], AUD: "" });
    expect(
      varsOf({
        ...placeholderOverlay,
        dispatchers: ["ci@example.com"],
        dispatch: { oidcAudience: "https://dispatch.example.com" },
      }),
    ).toEqual({ DISPATCHERS: ["ci@example.com"], AUD: "https://dispatch.example.com" });
  });

  it("[FD-IFC-089] renders dispatch.scoped into DISPATCH_SCOPED, none where the overlay names none", () => {
    const template = `{"vars": {"DISPATCH_SCOPED": "{{dispatch.scoped}}"}}`;
    const varsOf = (o: typeof placeholderOverlay) =>
      parseJsonc(Effect.runSync(renderTemplate("cp", template, o)))["vars"];
    expect(varsOf(placeholderOverlay)).toEqual({ DISPATCH_SCOPED: [] });
    expect(varsOf({ ...placeholderOverlay, dispatch: { oidcAudience: "aud" } })).toEqual({
      DISPATCH_SCOPED: [],
    });
    const scoped = [
      {
        identity: "scan-bot.access",
        runs: ["security-rescan"],
        repositories: ["acme/widgets"],
        classCeiling: "batch",
      },
    ];
    expect(varsOf({ ...placeholderOverlay, dispatch: { scoped } })).toEqual({
      DISPATCH_SCOPED: scoped,
    });
  });

  it("[FD-GH-093] holds records.url as an HTTPS URL and renders it into RECORDS_URL, empty where the overlay sets none", () => {
    const url = "https://records.example.com/hook";
    expect(Effect.runSync(decodeOverlay(overlay({ records: { url } }))).records).toEqual({ url });
    expect(rejected(overlay({ records: { url: "http://records.example.com/hook" } }))).toEqual([
      "records.url",
    ]);
    expect(rejected(overlay({ records: { url, secret: "x" } }))).toEqual(["records.secret"]);
    const template = `{"vars": {"RECORDS_URL": "{{records.url}}"}}`;
    const varsOf = (o: typeof placeholderOverlay) =>
      parseJsonc(Effect.runSync(renderTemplate("cp", template, o)))["vars"];
    expect(varsOf(placeholderOverlay)).toEqual({ RECORDS_URL: "" });
    expect(varsOf({ ...placeholderOverlay, records: { url } })).toEqual({ RECORDS_URL: url });
  });

  it("[FD-OPS-004] a placeholder whose value the overlay lacks fails the render, naming it", () => {
    const err = Effect.runSync(
      Effect.flip(renderTemplate("cp", `{"x": "{{kv.SESSIONS}}"}`, placeholderOverlay)),
    );
    expect(err.paths).toEqual(["kv.SESSIONS"]);
  });
});

describe("template invariants", () => {
  it("[FD-OPS-001] [FD-OPS-012] every account-specific value is a placeholder and keep_vars is false", () => {
    expect(templateInvariants("cp", parseJsonc(TEMPLATE))).toEqual([]);
    const bad = parseJsonc(
      TEMPLATE.replace('"{{d1.DB}}"', '"6c2b1f9e-real-id"').replace(
        '"keep_vars": false',
        '"keep_vars": true',
      ),
    );
    expect(templateInvariants("cp", bad).map((f) => f.check)).toEqual(["placeholder", "keep_vars"]);
  });

  it("[FD-INT-050] a cron set other than the single minute tick fails", () => {
    expect(cronCheck("cp", ["* * * * *"])).toEqual([]);
    expect(cronCheck("cp", [])).toHaveLength(1);
    expect(cronCheck("cp", ["* * * * *", "0 * * * *"])).toHaveLength(1);
  });

  it("[FD-INT-050] a template with a Worker script carries the minute tick, and a static-assets template carries no cron trigger", () => {
    const script = { main: "src/worker.ts", keep_vars: false };
    expect(templateInvariants("cp", { keep_vars: false }).map((f) => f.path)).toEqual([
      "cp.triggers.crons",
    ]);
    expect(
      templateInvariants("cp", { ...script, assets: { directory: "./public" } }).map((f) => f.path),
    ).toEqual(["cp.triggers.crons"]);
    expect(templateInvariants("cp", script).map((f) => f.path)).toEqual(["cp.triggers.crons"]);
    expect(templateInvariants("cp", { ...script, triggers: { crons: ["* * * * *"] } })).toEqual([]);
    const assets = { assets: { directory: "./dist" }, keep_vars: false };
    expect(templateInvariants("docs", assets)).toEqual([]);
    expect(
      templateInvariants("docs", { ...assets, triggers: { crons: ["* * * * *"] } }).map(
        (f) => `${f.check} ${f.path}`,
      ),
    ).toEqual(["cron docs.triggers.crons"]);
  });

  it("[FD-OPS-094] holds the scan bundle's pin, envelope file and signing keys and the advisory settings, refusing a digest that is not a SHA-256 and an undeclared scan key", () => {
    const jwk = { kty: "EC", crv: "P-256", x: "x", y: "y", kid: "bundle-2026" };
    const scan = {
      bundleDigest: "a".repeat(64),
      bundleFile: "deploy/scan-bundle.dsse.json",
      bundleKeys: [
        { publicKey: jwk, notBefore: "2026-11-01T00:00:00Z", notAfter: "2027-11-01T00:00:00Z" },
      ],
      advisoryEcosystems: ["npm", "PyPI"],
      advisoryMaxAgeHours: 24,
    };
    expect(Effect.runSync(decodeOverlay(overlay({ scan }))).scan).toEqual(scan);
    expect(rejected(overlay({ scan: { bundleDigest: `sha256:${"a".repeat(64)}` } }))).toEqual([
      "scan.bundleDigest",
    ]);
    expect(rejected(overlay({ scan: { bundleDigest: "A".repeat(64) } }))).toEqual([
      "scan.bundleDigest",
    ]);
    expect(rejected(overlay({ scan: { bundleSignature: "x" } }))).toEqual(["scan.bundleSignature"]);
    expect(
      rejected(overlay({ scan: { bundleKeys: [{ publicKey: { ...jwk, kty: "RSA" } }] } })),
    ).toEqual(["scan.bundleKeys.0.publicKey.kty"]);
  });
});
