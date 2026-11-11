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
});
