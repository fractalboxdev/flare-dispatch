// The rehearsal-reuse scenario of the `sim` job (specs/verification.md § V-SIM, specs/local-scheduler.md § Rehearsal
// reuse). A seeded fleet of rehearsals registers under one reuse key in the local store's D1 tables; each device then
// reports a start (or none), an outcome and a device-signed statement the control plane accepted or rejected, and each
// rehearsal ran under a capacity-lease epoch the control plane issued, re-bound or never issued. One pull-request run
// is then admitted for a check with reuse on, and the `ReusePolicy` port answers which rehearsal stands in for it.
//
// - `rehearsal-reuse` (FD-LOCAL-078): the seed fixes each rehearsal's provenance (tree hash, base commit, run-definition
//   digest, image digest, platform, environment names), its start relative to its registration, its statement, its
//   lease epoch, the repository's equivalent platforms, a matching rehearsal in another tenant scope, and failures of
//   the epoch read. `checkReuse` asserts that a named rehearsal meets every condition and that, with no read failing,
//   the newest rehearsal that meets every condition is named.
import { PostureSource, ReusePolicy } from "@fractalboxdev/mameko-ports";
import { Effect, Layer } from "effect";
import {
  seededRandom,
  throwOnViolations,
  type SimScenario,
  type SimViolation,
} from "../../../ops/src/verification/harness.ts";
import { memoryD1 } from "../../src/local/d1.test-support.ts";
import {
  ReuseInputs,
  ReuseReadFailed,
  reusePolicyLayer,
  type RepoReusePolicy,
} from "../../src/local/reuse.ts";
import { LocalStore, localStoreD1, type RegistrationRecord } from "../../src/local/store.ts";

export const SCENARIO = "rehearsal-reuse";

const SCOPE = "acme/app";
const REUSE_KEY = "rk-lint";
const PLATFORMS = ["darwin-arm64", "linux-arm64", "linux-x64"] as const;
const T0 = 1_800_000_000_000;

const rng = (seed: number) => {
  const next = seededRandom(seed);
  return {
    next,
    int: (n: number) => Math.floor(next() * n),
    chance: (p: number) => next() < p,
    pick: <A>(xs: readonly A[]): A => xs[Math.floor(next() * xs.length)]!,
  };
};

/** The provenance the pull-request run was admitted with. */
interface RunProvenance {
  readonly treeHash: string;
  readonly baseCommit: string;
  readonly runDigest: string;
  readonly imageDigest: string;
  readonly platform: string;
  readonly environmentNames: readonly string[];
}

type Statement = "none" | "rejected" | "accepted";

/** One seeded rehearsal: what it registered and what its device and the control plane later recorded of it. */
interface Rehearsal {
  readonly record: RegistrationRecord;
  readonly startedAt: number | null;
  readonly outcome: string | null;
  readonly statement: Statement;
  readonly epochIssued: boolean;
  readonly epochReadFails: boolean;
}

/** A defect that keeps a rehearsal from standing in, for a run over many seeds to show each was exercised. */
export type Defect =
  | "not-started"
  | "started-before-registration"
  | "epoch-not-issued"
  | "statement-none"
  | "statement-rejected"
  | "outcome-not-success"
  | "tree-hash"
  | "base-commit"
  | "run-digest"
  | "image-digest"
  | "platform"
  | "environment-names"
  | "run";

export interface ReuseOutcome {
  /** The defects some rehearsal of this seed carried as its only one. */
  readonly soleDefects: ReadonlySet<Defect>;
  readonly named: boolean;
  /** The named rehearsal ran on a platform the repository names as equivalent to the run's, not the same one. */
  readonly namedOnEquivalentPlatform: boolean;
  /** No rehearsal of the run's scope met every condition. */
  readonly noneEligible: boolean;
  readonly epochReadFailed: boolean;
  /** A rehearsal in another tenant scope met every condition. */
  readonly otherScopeMatch: boolean;
}

const platformsMatch = (policy: RepoReusePolicy, a: string, b: string) =>
  a === b || policy.equivalentPlatforms.some((g) => g.includes(a) && g.includes(b));

const sameNames = (a: readonly string[], b: readonly string[]) =>
  JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

/** Every defect of one rehearsal against the run, from the requirement's conditions alone. */
const defectsOf = (
  x: Rehearsal,
  run: RunProvenance,
  runName: string,
  policy: RepoReusePolicy,
): Defect[] => {
  const r = x.record;
  const d: Defect[] = [];
  if (x.startedAt === null) d.push("not-started");
  else if (x.startedAt < r.registeredAt) d.push("started-before-registration");
  if (!x.epochIssued) d.push("epoch-not-issued");
  if (x.statement === "none") d.push("statement-none");
  if (x.statement === "rejected") d.push("statement-rejected");
  if (x.outcome !== "success") d.push("outcome-not-success");
  if (r.treeHash !== run.treeHash) d.push("tree-hash");
  if (r.baseCommit !== run.baseCommit) d.push("base-commit");
  if (r.runDigest !== run.runDigest) d.push("run-digest");
  if (r.imageDigest !== run.imageDigest) d.push("image-digest");
  if (!platformsMatch(policy, r.platform, run.platform)) d.push("platform");
  if (!sameNames(r.environmentNames, run.environmentNames)) d.push("environment-names");
  if (r.run !== runName) d.push("run");
  return d;
};

/** The seeded fleet: each field of a rehearsal drifts from the run's with a small chance. */
const plan = (seed: number) => {
  const r = rng(seed);
  const run: RunProvenance = {
    treeHash: "tree-1",
    baseCommit: "b".repeat(40),
    runDigest: "sha256:run-1",
    imageDigest: "sha256:img-1",
    platform: r.pick(PLATFORMS),
    environmentNames: r.chance(0.5) ? ["CI"] : ["CI", "E2E"],
  };
  const policy: RepoReusePolicy = {
    reuse: true,
    equivalentPlatforms: r.chance(0.5) ? [["darwin-arm64", "linux-arm64"]] : [],
  };
  const fleet = 1 + r.int(6);
  // Distinct registration times, in a seeded order, so the newest is well defined.
  const slots = Array.from({ length: fleet }, (_, i) => i);
  for (let i = slots.length - 1; i > 0; i--) {
    const j = r.int(i + 1);
    [slots[i], slots[j]] = [slots[j]!, slots[i]!];
  }
  const drift = 0.1;
  const rehearsals: Rehearsal[] = slots.map((slot, i) => {
    const registeredAt = T0 + slot * 60_000 + r.int(30_000);
    const timing = r.next();
    const startedAt =
      timing < 0.1
        ? null
        : timing < 0.22
          ? registeredAt - 1 - r.int(5_000)
          : registeredAt + r.int(20_000);
    const s = r.next();
    const statement: Statement = s < 0.1 ? "none" : s < 0.2 ? "rejected" : "accepted";
    const record: RegistrationRecord = {
      executionId: `01JREHEARSAL${String(i).padStart(14, "0")}`,
      scopeId: SCOPE,
      executorId: `dev-${r.int(3)}`,
      leaseId: `L${i}`,
      epoch: 1 + r.int(3),
      run: r.chance(drift / 2) ? "other-check" : "lint",
      reuseKey: REUSE_KEY,
      repository: SCOPE,
      treeHash: r.chance(drift) ? "tree-2" : run.treeHash,
      baseCommit: r.chance(drift) ? "c".repeat(40) : run.baseCommit,
      runDigest: r.chance(drift) ? "sha256:run-2" : run.runDigest,
      imageDigest: r.chance(drift) ? "sha256:img-2" : run.imageDigest,
      platform: r.chance(0.3) ? r.pick(PLATFORMS) : run.platform,
      inputsDigest: `sha256:in-${i}`,
      environmentNames: r.chance(drift)
        ? r.pick([["CI"], ["CI", "E2E"], ["E2E"], []])
        : [...run.environmentNames].reverse(),
      wantsReuse: true,
      wantsWriteback: r.chance(0.5),
      nonce: `nonce-${i}`,
      registeredAt,
      startedAt: null,
      outcome: null,
      statementId: null,
      statementAccepted: false,
    };
    return {
      record,
      startedAt,
      outcome: r.chance(0.12) ? r.pick(["failure", "cancelled", null]) : "success",
      statement,
      epochIssued: !r.chance(0.12),
      epochReadFails: r.chance(0.04),
    };
  });
  // A rehearsal in another tenant scope that matches the run on everything.
  const otherScope: Rehearsal | null = r.chance(0.4)
    ? {
        record: {
          ...rehearsals[0]!.record,
          executionId: "01JOTHERSCOPE0000000000000",
          scopeId: "other/app",
          repository: SCOPE,
          leaseId: "L-other",
          treeHash: run.treeHash,
          baseCommit: run.baseCommit,
          runDigest: run.runDigest,
          imageDigest: run.imageDigest,
          platform: run.platform,
          environmentNames: run.environmentNames,
          run: "lint",
          registeredAt: T0 + 10 * 60_000,
        },
        startedAt: T0 + 10 * 60_000 + 1,
        outcome: "success",
        statement: "accepted",
        epochIssued: true,
        epochReadFails: false,
      }
    : null;
  return { run, policy, rehearsals, otherScope };
};

/**
 * Runs one seed of `rehearsal-reuse` and asserts FD-LOCAL-078 on it. Safety: a named rehearsal is one of the run's
 * scope, registered (and so given its nonce) no later than it started, under an epoch the control plane issued or
 * re-bound, matching the run on tree hash, base commit, run-definition digest, image digest, platform (or a platform
 * the repository names as equivalent) and environment names, with an accepted `device-signed` statement. Liveness:
 * when no read fails, the newest rehearsal that meets every condition is named, and none is named when no rehearsal
 * meets them.
 */
export const checkReuse = async (seed: number): Promise<ReuseOutcome> => {
  const { run, policy, rehearsals, otherScope } = plan(seed);
  const db = memoryD1();
  const store = localStoreD1(db);
  const fleet = otherScope === null ? rehearsals : [...rehearsals, otherScope];
  const byLease = new Map(fleet.map((x) => [x.record.leaseId, x]));
  const epochReads: string[] = [];
  const inputs = Layer.succeed(ReuseInputs, {
    repoPolicy: () => Effect.succeed(policy),
    readRequiredSet: () => Effect.succeed([]),
    epochIssued: (leaseId, epoch) =>
      Effect.suspend(() => {
        epochReads.push(`${leaseId}#${epoch}`);
        const x = byLease.get(leaseId);
        if (x === undefined || x.record.epoch !== epoch) return Effect.succeed(false);
        return x.epochReadFails
          ? Effect.fail(new ReuseReadFailed({ source: "capacity", detail: "injected" }))
          : Effect.succeed(x.epochIssued);
      }),
  });
  const posture = Layer.succeed(PostureSource, {
    posture: () => Effect.succeed("managed-workstation" as const),
  });

  // Each rehearsal registers, then its device reports what it did.
  await Effect.runPromise(
    Effect.gen(function* () {
      const s = yield* LocalStore;
      for (const x of fleet) {
        yield* s.insert(x.record);
        if (x.startedAt !== null) yield* s.recordStart(x.record.executionId, x.startedAt);
        if (x.outcome !== null) yield* s.recordOutcome(x.record.executionId, x.outcome);
        if (x.statement !== "none")
          yield* s.recordStatement(
            x.record.executionId,
            `stmt-${x.record.executionId}`,
            x.statement === "accepted",
          );
      }
    }).pipe(Effect.provide(store)),
  );

  const request = {
    scopeId: SCOPE,
    repository: SCOPE,
    baseBranch: "main",
    checkName: "flare-dispatch/check:lint",
    run: "lint",
    placementRule: "local-first",
    intentKinds: ["check.summary"],
    inputsDigest: "sha256:in-run",
    ...run,
  };
  const named = await Effect.runPromise(
    Effect.flatMap(ReusePolicy, (p) => p.reuse(request, REUSE_KEY)).pipe(
      Effect.provide(reusePolicyLayer.pipe(Layer.provide(Layer.mergeAll(store, inputs, posture)))),
    ),
  );

  const violations: SimViolation[] = [];
  const v = (message: string) =>
    violations.push({ id: "FD-LOCAL-078", message: `seed ${seed}: ${message}` });
  const defects = new Map(
    rehearsals.map((x) => [x.record.executionId, defectsOf(x, run, "lint", policy)]),
  );
  const eligible = rehearsals
    .filter((x) => defects.get(x.record.executionId)!.length === 0)
    .sort((a, b) => b.record.registeredAt - a.record.registeredAt);
  const epochReadFailed = epochReads.some(
    (k) => byLease.get(k.split("#")[0]!)?.epochReadFails === true,
  );

  if (named !== null) {
    const x = rehearsals.find((y) => y.record.executionId === named);
    if (x === undefined) v(`named ${named}, which is not a rehearsal of scope ${SCOPE}`);
    else {
      const d = defects.get(named)!;
      if (d.length > 0) v(`named ${named}, which fails ${d.join(", ")}`);
    }
  }
  if (!epochReadFailed) {
    const expected = eligible[0]?.record.executionId ?? null;
    if (named !== expected) v(`named ${named ?? "none"}, expected ${expected ?? "none"}`);
  }
  throwOnViolations(violations);

  const soleDefects = new Set<Defect>();
  for (const d of defects.values()) if (d.length === 1) soleDefects.add(d[0]!);
  const namedRecord = rehearsals.find((x) => x.record.executionId === named)?.record;
  return {
    soleDefects,
    named: named !== null,
    namedOnEquivalentPlatform: namedRecord !== undefined && namedRecord.platform !== run.platform,
    noneEligible: eligible.length === 0,
    epochReadFailed,
    otherScopeMatch: otherScope !== null,
  };
};

export const scenarios: readonly SimScenario[] = [
  {
    name: SCENARIO,
    ids: ["FD-LOCAL-078"],
    run: async (seed) => {
      await checkReuse(seed);
    },
  },
];
