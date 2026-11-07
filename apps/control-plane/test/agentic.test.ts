// The one `EffectApplier`: the agentic `pr.propose` and `pr.close` appliers over the GitHub package's applier.
import { GitData, GitDataError } from "@fractalboxdev/flare-dispatch-agentic";
import { lookupRun } from "@fractalboxdev/flare-dispatch-catalog";
import { EffectApplier, type IntentRow } from "@fractalboxdev/mameko-ports";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { writebackApplier, writebackRecordsDeferred } from "../src/agentic.ts";

const row = (kind: string, payload: unknown): IntentRow =>
  ({
    executionId: "01EXEC",
    epoch: 1,
    intentKey: kind,
    kind,
    scopeId: "acme/widgets",
    limitKey: "installation:1",
    payload,
  }) as unknown as IntentRow;

const base = (seen: string[]) =>
  Layer.succeed(EffectApplier, {
    apply: (r) =>
      Effect.sync(() => (seen.push(r.kind), { _tag: "applied" as const, externalRef: "base" })),
    lookup: () => Effect.succeed({ _tag: "absent" as const }),
    reconcile: () => Effect.succeed({ _tag: "absent" as const }),
  });

/** Git data whose every call fails as GitHub refusing it, so a routed row answers the agentic applier's refusal. */
const refusingGit = Layer.succeed(
  GitData,
  new Proxy({} as GitData["Service"], {
    get: (_target, call) => () =>
      Effect.fail(new GitDataError({ call: String(call), status: 403, detail: "refused" })),
  }),
);

const applierWith = (seen: string[]) =>
  writebackApplier("flare-dispatch[bot]").pipe(
    Layer.provide(Layer.mergeAll(base(seen), refusingGit, writebackRecordsDeferred)),
  );

const apply = (seen: string[], r: IntentRow) =>
  Effect.runPromise(
    Effect.flatMap(EffectApplier, (a) => a.apply(r)).pipe(Effect.provide(applierWith(seen))),
  );

describe("the writeback appliers inside the one applier", () => {
  it("FD-AGT-009 routes pr.close to the agentic applier, which checks its branch before any GitHub call", async () => {
    const seen: string[] = [];
    const answer = await apply(
      seen,
      row("pr.close", { repo: { owner: "acme", name: "widgets" }, branch: "main", base: "main" }),
    );
    expect(seen).toEqual([]);
    expect(answer).toMatchObject({ _tag: "refused", reason: "writeback: branch-invalid" });
  });

  it("FD-AGT-009 refuses a pr.propose whose payload does not decode, without the GitHub applier", async () => {
    const seen: string[] = [];
    expect(await apply(seen, row("pr.propose", {}))).toMatchObject({
      _tag: "refused",
      reason: "writeback: payload-invalid",
    });
    expect(seen).toEqual([]);
  });

  it("FD-GH-001 leaves every other kind to the GitHub package's applier", async () => {
    const seen: string[] = [];
    expect(await apply(seen, row("check.conclude", {}))).toMatchObject({ externalRef: "base" });
    expect(seen).toEqual(["check.conclude"]);
  });

  it("FD-AGT-001 lists each agentic recipe with a body in the catalogue, on a cloud executor", () => {
    for (const name of ["pr-review", "improve-pr", "spec-drift-pr", "ci-triage-pr"]) {
      const found = lookupRun("production", name);
      expect(found._tag).toBe("Available");
      if (found._tag !== "Available") continue;
      expect(found.entry.executors).toEqual(["cloud"]);
      expect(found.entry.agentic?.declaration.needsModel).toBeDefined();
    }
    expect(lookupRun("production", "release-notes")._tag).toBe("NotInCatalogue");
  });
});
