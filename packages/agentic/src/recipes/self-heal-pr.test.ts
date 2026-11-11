// `self-heal-pr` over the recipe services' doubles: the incident pack it accepts, the edit loop then the repro, and the
// staged write a green repro earns (specs/runs/agentic.md § `self-heal-pr`).
import { Effect, Layer, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { fakeServices, payload, recorder, type FakeOptions } from "./fakes.test-support.ts";
import { selfHealPrRun } from "./runs.ts";
import { REPRO_TIMEOUT_SEC, SelfHealPrInput, selfHealBranch } from "./self-heal-pr.ts";

const REPRO = "pnpm vitest run src/parse.test.ts";

const incident = (over: Record<string, unknown> = {}) => ({
  contractVersion: "v1",
  incidentId: "ci-acme-app-1234",
  class: "ci",
  repo: "acme/app",
  diagnosis: {
    title: "parse drops the last field",
    area: "src/parse.ts",
    diagnosis: "an off-by-one in the split",
    suggestedFix: "keep the trailing field",
  },
  suspectFiles: ["src/parse.ts"],
  repro: { kind: "command", command: REPRO },
  ...over,
});

const decode = Schema.decodeUnknownSync(SelfHealPrInput);

const run = (input: unknown, options: FakeOptions = {}, rec = recorder()) =>
  Effect.runPromise(
    selfHealPrRun.workflow
      .execute(payload("self-heal-pr", decode(input)))
      .pipe(Effect.provide(Layer.provideMerge(selfHealPrRun.layer, fakeServices(rec, options)))),
  ).then((result) => ({ result, rec }));

/** A shell whose repro exits `code`, recording how many edit-loop runs preceded each repro. */
const reproExits = (code: number | null, rec: ReturnType<typeof recorder>, seen: number[]) => ({
  shell: (command: string) => {
    if (command === REPRO) seen.push(rec.prompts.length);
    return { exitCode: code, stdout: "", stderr: "" };
  },
});

describe("self-heal-pr input", () => {
  it("[FD-AGT-063] accepts only an incident/v1 pack of class ci whose repro is a command", () => {
    expect(decode({ incident: incident() }).incident.repro.command).toBe(REPRO);
    const refused = [
      {},
      { incident: null },
      { incident: incident({ class: "application" }) },
      { incident: incident({ class: "demo" }) },
      { incident: incident({ contractVersion: "v2" }) },
      { incident: incident({ repro: undefined }) },
      { incident: incident({ repro: { kind: "derived", command: REPRO } }) },
      { incident: incident({ repro: { kind: "none" } }) },
      { incident: incident({ repro: { kind: "command" } }) },
      { incident: incident({ repro: { kind: "command", command: "" } }) },
      { incident: incident({ repro: { kind: "command", command: "  " } }) },
      { incident: incident({ repro: { kind: "command", command: "\n\t" } }) },
    ];
    for (const input of refused) expect(() => decode(input), JSON.stringify(input)).toThrow();
  });
});

describe("self-heal-pr", () => {
  it("[FD-AGT-064] runs the edit loop, then re-runs the repro once in the same sandbox with a 600 s timeout", async () => {
    const rec = recorder();
    const seen: number[] = [];
    await run({ incident: incident() }, reproExits(0, rec, seen), rec);
    expect(REPRO_TIMEOUT_SEC).toBe(600);
    expect(rec.prompts).toHaveLength(1);
    expect(rec.prompts[0]).toContain(REPRO);
    expect(rec.prompts[0]).toContain("an off-by-one in the split");
    expect(rec.commands).toEqual([REPRO]);
    expect(seen).toEqual([1]);
    expect(rec.timeouts).toEqual([600_000]);
    expect(rec.modelCalls).toEqual([]);
  });

  it("[FD-AGT-064] a dispatch that names a repro timeout re-runs the repro under it", async () => {
    const rec = recorder();
    await run({ incident: incident(), reproTimeoutSec: 120 }, {}, rec);
    expect(rec.timeouts).toEqual([120_000]);
  });

  it("[FD-AGT-065] [FD-AGT-037] a repro that exits 0 stages a draft write labelled self-heal and self-heal:verified", async () => {
    const rec = recorder();
    const { result } = await run(
      { incident: incident(), baseBranch: "develop" },
      reproExits(0, rec, []),
      rec,
    );
    expect(result).toEqual({ _tag: "success" });
    expect(rec.staged).toHaveLength(1);
    expect(rec.staged[0]).toMatchObject({
      branch: selfHealBranch("ci-acme-app-1234"),
      baseBranch: "develop",
      pr: { draft: true, labels: ["self-heal", "self-heal:verified"] },
    });
    expect(rec.staged[0]?.pr.body).toContain(REPRO);
  });

  it("[FD-AGT-066] a repro that exits non-zero opens no pull request and concludes failure no-fix", async () => {
    for (const code of [1, 2, null]) {
      const rec = recorder();
      const { result } = await run({ incident: incident() }, reproExits(code, rec, []), rec);
      expect(result, String(code)).toEqual({ _tag: "failure", reason: "no-fix" });
      expect(rec.staged).toEqual([]);
      expect(rec.intents).toEqual([]);
    }
  });

  it("[FD-AGT-067] an edit loop that cannot start or exits 126 or 127 concludes infra: edit loop unavailable", async () => {
    for (const exit of [null, 126, 127]) {
      const rec = recorder();
      const { result } = await run({ incident: incident() }, { editLoop: () => exit }, rec);
      expect(result, String(exit)).toEqual({
        _tag: "failure",
        reason: "infra: edit loop unavailable",
      });
      expect(rec.commands).toEqual([]);
      expect(rec.staged).toEqual([]);
    }
    // Any other exit, or a signal such as the loop's timeout, leaves the verdict to the repro.
    for (const exit of [1, "killed"] as const) {
      const rec = recorder();
      const { result } = await run({ incident: incident() }, { editLoop: () => exit }, rec);
      expect(result, String(exit)).toEqual({ _tag: "success" });
      expect(rec.commands).toEqual([REPRO]);
    }
    const rec = recorder();
    const { result } = await run(
      { incident: incident() },
      { editLoop: () => "killed", ...reproExits(1, rec, []) },
      rec,
    );
    expect(result).toEqual({ _tag: "failure", reason: "no-fix" });
  });

  it("names one branch per incident under flare-dispatch/self-heal", () => {
    expect(selfHealBranch("CI: acme/app #12")).toMatch(
      /^flare-dispatch\/self-heal-ci-acme-app-12-[0-9a-f]{8}$/,
    );
    expect(selfHealBranch("CI: acme/app #12")).toBe(selfHealBranch("CI: acme/app #12"));
    // Ids whose slugs match, whose slugs the 48-character cut makes equal, or whose slugs are empty differ by hash.
    const repo = "ci:acme/a-repository-name-longer-than-thirty-five-characters";
    const ids = [
      "CI: acme/app #12",
      "ci-acme-app-12",
      `${repo}:1111111111111111111111111111111111111111`,
      `${repo}:2222222222222222222222222222222222222222`,
      "--",
      "::",
    ];
    const branches = ids.map(selfHealBranch);
    expect(new Set(branches).size).toBe(ids.length);
    expect(branches[4]).toMatch(/^flare-dispatch\/self-heal-[0-9a-f]{8}$/);
    for (const b of branches) expect(b.length).toBeLessThanOrEqual(84);
  });
});
