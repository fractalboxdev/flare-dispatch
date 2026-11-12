// The generator of the `stagedWriteGate` differential subject reaches each check the V-DIFF requirements name, and,
// where `lake build oracle` has run, the compiled Lean oracle answers every sampled event as the TypeScript gate does.
// The `diff` job runs the subject on the regressions file and 10,000 traces per pull request.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Effect, Layer } from "effect";
import fc from "fast-check";
import { afterAll, describe, expect, it } from "vitest";
import {
  canonical,
  parseRegressions,
  replayRegressions,
} from "../../../ops/src/verification/diff.ts";
import { memoryD1 } from "../../src/local/d1.test-support.ts";
import { LocalStore, localStoreD1 } from "../../src/local/store.ts";
import {
  CapacityUsage,
  decideWriteback,
  type WritebackDecision,
} from "../../src/local/writeback-gate.ts";
import {
  refusalReason,
  type GateReason,
  type GateVerdict,
} from "../../src/staged-write/manifest.ts";
import { WritebackRecords } from "../../src/writeback/applier.ts";
import { BASE_SHA, fakeGitLayer, fakeRepo } from "../../src/writeback/fake-git.test-support.ts";
import {
  gateEvent,
  modelAuthoredFrom,
  ORACLE_PATH,
  runGate,
  subject,
  WRITEBACK_EXECUTION,
  WRITEBACK_LEASE,
  writebackEvent,
  type GateEvent,
  type WritebackEvent,
} from "./staged-write-gate.diff.ts";

const SAMPLE = fc.sample(gateEvent, { numRuns: 4000, seed: 20261104 });
const verdicts = SAMPLE.map((e) => ({ event: e, verdict: runGate(e) }));
const reasonsOf = (v: GateVerdict): readonly GateReason[] => (v._tag === "reject" ? v.reasons : []);

/** The sampled events whose verdict carries a reason matching `p`. */
const reaching = (p: (r: GateReason, e: GateEvent) => boolean) =>
  verdicts.filter(({ event, verdict }) => reasonsOf(verdict).some((r) => p(r, event)));

const oracleBuilt = existsSync(ORACLE_PATH);

/** Every event the oracle answers differently from the TypeScript gate. */
const disagreements = async (events: readonly GateEvent[]) => {
  const out: GateEvent[] = [];
  for (const e of events)
    if (canonical(await subject.oracle(e)) !== canonical(subject.run(e))) out.push(e);
  return out;
};

afterAll(() => subject.close?.());

const WRITEBACK_SAMPLE = fc.sample(writebackEvent, { numRuns: 1000, seed: 20261112 });

/** The decision the writeback gate owes a verdict: accepted, or rejected with the verdict's reasons. */
const decisionFor = (v: GateVerdict): WritebackDecision =>
  v._tag === "accept"
    ? { _tag: "accepted" }
    : { _tag: "rejected", reason: refusalReason(v.reasons) };

/**
 * `decideWriteback` on each event as its `local.writeback`: one registered `success` execution of the run `check` on
 * the event's lease, the event's blobs, base texts and issued credentials behind the records and the git data, and its
 * usage reports behind `CapacityUsage`.
 */
const decideAll = async (events: readonly WritebackEvent[]) => {
  const store = localStoreD1(memoryD1());
  const repo = fakeRepo();
  let at: WritebackEvent = events[0]!;
  const records = Layer.succeed(WritebackRecords, {
    blobs: () =>
      Effect.sync(() =>
        at.gate.evidence.blobs.map((b) => ({
          ...b,
          bytes: new TextEncoder().encode(b.text ?? ""),
        })),
      ),
    modelCalls: () => Effect.succeed(false),
    issuedCredentials: () => Effect.sync(() => at.gate.evidence.issuedCredentials),
  });
  const usage = Layer.succeed(CapacityUsage, {
    modelCalls: (leaseId, executionId) =>
      Effect.sync(() => modelAuthoredFrom(at.usage, leaseId, executionId)),
  });
  const deps = Layer.mergeAll(store, records, usage, fakeGitLayer(repo));
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* (yield* LocalStore).insert({
        executionId: WRITEBACK_EXECUTION,
        scopeId: "scope",
        executorId: "dev-1",
        leaseId: WRITEBACK_LEASE,
        epoch: 1,
        run: "check",
        reuseKey: "rk",
        repository: "o/r",
        treeHash: "tree",
        baseCommit: BASE_SHA,
        runDigest: "sha256:run",
        imageDigest: "sha256:img",
        platform: "darwin-arm64",
        inputsDigest: "sha256:in",
        environmentNames: [],
        wantsReuse: false,
        wantsWriteback: true,
        nonce: "n",
        registeredAt: 1000,
        startedAt: 2000,
        outcome: "success",
        statementId: null,
        statementAccepted: false,
      });
    }).pipe(Effect.provide(store)),
  );
  const out: { event: WritebackEvent; decision: WritebackDecision }[] = [];
  for (const event of events) {
    at = event;
    repo.files.clear();
    for (const b of event.gate.evidence.base)
      if (!repo.files.has(b.path) && b.text !== null)
        repo.files.set(b.path, new TextEncoder().encode(b.text));
    const config = {
      writebackFor: (run: string) => (run === "check" ? event.gate.spec : undefined),
      rate: Number.MAX_SAFE_INTEGER,
      githubHost: event.gate.evidence.githubHost,
    };
    const intents = [
      {
        intent_key: "run:propose:0",
        kind: "pr.propose",
        payload: { manifest: event.gate.manifest },
      },
    ];
    const decision = await Effect.runPromise(
      decideWriteback(config, event.executionId, intents).pipe(Effect.provide(deps)),
    );
    out.push({ event, decision });
  }
  return out;
};

describe("stagedWriteGate differential subject", () => {
  it("[FD-AGT-019] the generator reaches path-invalid for each invalid form, a duplicate included", () => {
    const hits = reaching((r) => r.kind === "path-invalid");
    const paths = hits.flatMap(({ verdict }) =>
      reasonsOf(verdict).flatMap((r) => (r.kind === "path-invalid" ? [r] : [])),
    );
    expect(paths.some((r) => r.path?.startsWith("/"))).toBe(true);
    expect(paths.some((r) => new TextEncoder().encode(r.path ?? "").length > 1024)).toBe(true);
    expect(paths.some((r) => r.path?.includes("\\"))).toBe(true);
    expect(paths.some((r) => r.path?.includes("\0"))).toBe(true);
    expect(paths.some((r) => /(^|\/)\.git(\/|$)/i.test(r.path ?? ""))).toBe(true);
    expect(paths.some((r) => r.detail === "duplicate")).toBe(true);
  });

  it("[FD-AGT-020] the generator reaches protected-path for runs/, infra/, .github/workflows/ and wrangler.jsonc", () => {
    const protectedPaths = reaching(
      (r, e) => r.kind === "protected-path" && e.modelAuthored,
    ).flatMap(({ verdict }) =>
      reasonsOf(verdict).flatMap((r) =>
        r.kind === "protected-path" ? [r.path!.toLowerCase()] : [],
      ),
    );
    for (const prefix of ["runs/", "infra/", ".github/workflows/"])
      expect(protectedPaths.some((p) => p.startsWith(prefix))).toBe(true);
    expect(protectedPaths.some((p) => p.endsWith("wrangler.jsonc"))).toBe(true);
    // KELVIN SIGN lower-cases to `k`, so `.github/worKflows/` is a workflow path to the gate and the model alike.
    expect(protectedPaths.some((p) => p.startsWith(".github/workflows/"))).toBe(true);
  });

  it("[FD-AGT-021] the generator reaches protected-path for wrangler.json and wrangler.toml", () => {
    const names = reaching((r) => r.kind === "protected-path").flatMap(({ verdict }) =>
      reasonsOf(verdict).flatMap((r) =>
        r.kind === "protected-path" ? [r.path!.toLowerCase().split("/").at(-1)] : [],
      ),
    );
    expect(names).toContain("wrangler.json");
    expect(names).toContain("wrangler.toml");
  });

  it("[FD-AGT-022] the generator reaches workflows-not-opted-in on writes that are not model-authored", () => {
    expect(
      reaching((r, e) => r.kind === "workflows-not-opted-in" && !e.modelAuthored).length,
    ).toBeGreaterThan(0);
  });

  it("[FD-AGT-023] the generator reaches sensitive-not-opted-in", () => {
    expect(reaching((r) => r.kind === "sensitive-not-opted-in").length).toBeGreaterThan(0);
  });

  it("[FD-AGT-024] the generator reaches outside-allowlist, and with an empty allowlist every entry is outside it", () => {
    expect(reaching((r) => r.kind === "outside-allowlist").length).toBeGreaterThan(0);
    const empty = verdicts.filter(
      ({ event }) => event.spec.allowlist.length === 0 && event.manifest.entries.length > 0,
    );
    expect(empty.length).toBeGreaterThan(0);
    for (const { event, verdict } of empty)
      expect(reasonsOf(verdict).filter((r) => r.kind === "outside-allowlist").length).toBe(
        event.manifest.entries.length,
      );
  });

  it("[FD-AGT-017] the generator reaches rejections carrying reasons of several entries and every reason kind", () => {
    const kinds = new Set(verdicts.flatMap(({ verdict }) => reasonsOf(verdict).map((r) => r.kind)));
    expect([...kinds].sort()).toEqual(
      [
        "blob-missing",
        "branch-invalid",
        "digest-mismatch",
        "encoded-run",
        "mode-invalid",
        "outside-allowlist",
        "path-invalid",
        "protected-path",
        "secret-detected",
        "sensitive-not-opted-in",
        "too-large",
        "too-many-files",
        "url-not-allowed",
        "workflows-not-opted-in",
      ].sort(),
    );
    const multi = verdicts.filter(
      ({ verdict }) =>
        new Set(reasonsOf(verdict).flatMap((r) => (r.path === undefined ? [] : [r.path]))).size > 2,
    );
    expect(multi.length).toBeGreaterThan(0);
  });
});

describe("local.writeback differential subject", () => {
  it("[FD-LOCAL-094] the generator reaches usage reports with a model call for the execution, with calls for other executions or leases only, and with none", () => {
    const authored = WRITEBACK_SAMPLE.filter((e) => e.gate.modelAuthored);
    const otherOnly = WRITEBACK_SAMPLE.filter((e) => !e.gate.modelAuthored && e.usage.length > 0);
    expect(authored.length).toBeGreaterThan(0);
    expect(otherOnly.some((e) => e.usage.some((c) => c.leaseId === WRITEBACK_LEASE))).toBe(true);
    expect(otherOnly.some((e) => e.usage.some((c) => c.executionId === WRITEBACK_EXECUTION))).toBe(
      true,
    );
    expect(WRITEBACK_SAMPLE.some((e) => e.usage.length === 0)).toBe(true);
    expect(
      authored.some((e) => reasonsOf(runGate(e.gate)).some((r) => r.kind === "protected-path")),
    ).toBe(true);
    expect(
      otherOnly.some(
        (e) =>
          runGate(e.gate)._tag === "accept" &&
          runGate({ ...e.gate, modelAuthored: true })._tag === "reject",
      ),
    ).toBe(true);
  });

  it("[FD-LOCAL-094] the writeback gate decides every sampled proposal as stagedWriteGate does with the run's writeback block, model-authored from the lease's usage report", async () => {
    const decided = await decideAll(WRITEBACK_SAMPLE);
    const wrong = decided.filter(
      ({ event, decision }) => canonical(decision) !== canonical(decisionFor(runGate(event.gate))),
    );
    expect(wrong).toEqual([]);
    expect(decided.some(({ decision }) => decision._tag === "accepted")).toBe(true);
    expect(
      decided.some(
        ({ event, decision }) =>
          event.gate.modelAuthored &&
          decision._tag === "rejected" &&
          decision.reason.startsWith("writeback: protected-path"),
      ),
    ).toBe(true);
  }, 60_000);
});

// The unit job installs no Lean toolchain, so it skips this block; the `diff` job builds the oracle and runs the
// subject itself.
describe.skipIf(!oracleBuilt)("stagedWriteGate against the compiled oracle", () => {
  it("[FD-AGT-016] [FD-AGT-017] [FD-AGT-019] [FD-AGT-020] [FD-AGT-021] [FD-AGT-022] [FD-AGT-023] [FD-AGT-024] the oracle answers every kept regression and every sampled event as the gate the applier runs", async () => {
    const regressions = parseRegressions(
      readFileSync(
        fileURLToPath(new URL("../../../../formal/regressions.jsonl", import.meta.url)),
        "utf8",
      ),
    );
    expect(await replayRegressions(subject, regressions)).toBeNull();
    expect(await disagreements(SAMPLE)).toEqual([]);
  }, 60_000);

  it("[FD-LOCAL-094] the oracle answers every sampled local.writeback as the writeback gate decides it", async () => {
    const wrong: WritebackEvent[] = [];
    for (const { event, decision } of await decideAll(WRITEBACK_SAMPLE))
      if (canonical(decisionFor(await subject.oracle(event.gate))) !== canonical(decision))
        wrong.push(event);
    expect(wrong).toEqual([]);
  }, 60_000);
});
