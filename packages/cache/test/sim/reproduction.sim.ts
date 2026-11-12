// The reproduction deadline as a V-SIM scenario (specs/provenance.md FD-PROV-068). Each seed logs a release's cloud
// statement, sets the release's `deadline_at`, and logs the reproduction's countersigned device statement at a seeded
// log time before the deadline, at it, after it, or never. A driver compares the two at seeded times on one simulated
// clock, from the release's log time to an hour past the deadline, inserting the reproduction statement into the
// log-append store once the clock reaches its log time. The scenario checks that every comparison before the deadline
// with no statement logged answers `Awaiting`, every comparison from the deadline on with no statement logged by it
// concludes the release `failure` with `provenance: reproduction unavailable`, and a statement logged by the deadline
// reproduces the release whenever it is compared.
//
// `scenarios` is what the `sim` job runs (packages/ops/scripts/harness.ts): each seed fails on any violation.
import { AlarmPort } from "@fractalboxdev/mameko-ports";
import { Cause, Effect, Exit, Layer, Logger, Option } from "effect";
import {
  seededRandom,
  throwOnViolations,
  type SimScenario,
  type SimViolation,
} from "../../../ops/src/verification/harness.ts";
import { utf8 } from "../../src/crypto.ts";
import {
  envelopeEntry,
  LogAppendStatus,
  LogAppendStore,
  RepositoryVisibility,
  type LogAppendIntent,
} from "../../src/provenance/append.ts";
import { memoryLogAppendStore } from "../../src/provenance/append.test-support.ts";
import { countersign } from "../../src/provenance/countersign.ts";
import {
  DSSE_PAYLOAD_TYPE,
  dssePae,
  parseProvenanceKey,
  signPae,
  unsignedEnvelope,
  type DsseEnvelope,
  type ProvenanceKey,
} from "../../src/provenance/dsse.ts";
import type { ProvenancePublicKey } from "../../src/provenance/release.ts";
import {
  REPRODUCTION_UNAVAILABLE,
  ReproductionOutcome,
  ReproductionRefused,
  settleReproduction,
  type ReleaseExecution,
} from "../../src/provenance/reproduction.ts";
import { statementOf, type StatementBody } from "../../src/provenance/statement.ts";

const START = Date.UTC(2026, 0, 1);
const RELEASE_ID = "exec-release-sim";
const REPRO_ID = "exec-repro-sim";
const COMMIT = "e".repeat(40);
const sha = (c: string) => `sha256:${c.repeat(64)}`;
const SUBJECTS = [{ name: "app.tar.gz", digest: { sha256: "a".repeat(64) } }];
const Logless = Logger.layer([]);

const release: ReleaseExecution = {
  executionId: RELEASE_ID,
  repository: "acme/widgets",
  ref: "refs/tags/v1.0.0",
  run: "release",
  commit: COMMIT,
  definitionDigest: sha("c"),
  imageDigest: sha("f"),
  inputs: {},
};

const body = (executionId: string, kind: "cloudflare" | "device"): StatementBody => ({
  lease: {
    execution_id: executionId,
    epoch: 1,
    nonce: "n-0123456789abcdef",
    executor_id: kind === "device" ? "mac-1" : "cf-7",
    executor_kind: kind,
    run: { name: "release", kind: "build", definition_digest: sha("c"), inputs_digest: sha("d") },
    repository: "acme/widgets",
    ref: "refs/tags/v1.0.0",
    commit_sha: COMMIT,
    image_digest: sha("f"),
    class: kind === "device" ? "interactive" : "release",
    policy_version: "7",
    confidentiality: "unclassified",
    binding_kind: "execution-lease",
  },
  outcome: "success",
  commands: [{ name: "build", exit_status: 0 }],
  lockfiles: [],
  fetches: [],
  locked_dependencies: [],
  restored_cache: [],
  egress_log_digest: sha("2"),
  step_log_digest: sha("3"),
  models: [],
});

const signed = async (statementBody: StatementBody, key: ProvenanceKey): Promise<DsseEnvelope> => {
  const payload = utf8(JSON.stringify(statementOf(statementBody, SUBJECTS)));
  return { ...unsignedEnvelope(payload), signatures: [await signPae(key, dssePae(DSSE_PAYLOAD_TYPE, payload))] };
};

const logged = async (envelope: DsseEnvelope, executionId: string, at: number): Promise<LogAppendIntent> => {
  const { json, digest } = await envelopeEntry(envelope);
  return {
    envelopeDigest: digest,
    executionId,
    repository: "acme/widgets",
    log: "private",
    envelope: json,
    verifiers: [],
    status: LogAppendStatus.Logged({
      attempts: 1,
      entry: { log: "private", logIndex: 0, entryId: digest, integratedTime: at },
    }),
  };
};

const keyPair = async (kid: string) => {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const priv = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  const pub = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  return {
    private: parseProvenanceKey(JSON.stringify({ ...priv, kid }))!,
    public: { ...pub, kid } as ProvenancePublicKey,
  };
};

/** Where the seed logs the reproduction statement, relative to the release's `deadline_at`. */
const PLACEMENTS = ["before", "at", "after", "never"] as const;

export interface SimOutcome {
  readonly violations: readonly SimViolation[];
  readonly reached: Readonly<Record<string, number>>;
}

export const simulateReproductionDeadline = async (seed: number): Promise<SimOutcome> => {
  const random = seededRandom(seed);
  const violations: SimViolation[] = [];
  const reached: Record<string, number> = {};
  const reach = (k: string) => (reached[k] = (reached[k] ?? 0) + 1);
  const violate = (message: string) => violations.push({ id: "FD-PROV-068", message });

  const provenance = await keyPair("prov-1");
  const device = await keyPair("device-1");
  // The release's run ceiling: 1 to 6 hours from its log time.
  const deadlineAt = START + Math.floor((1 + random() * 5) * 3_600_000);
  const placement = PLACEMENTS[Math.floor(random() * PLACEMENTS.length)]!;
  const loggedAt =
    placement === "before"
      ? START + Math.floor(random() * (deadlineAt - START))
      : placement === "at"
        ? deadlineAt
        : placement === "after"
          ? deadlineAt + 1 + Math.floor(random() * 1_800_000)
          : undefined;
  reach(placement);

  const store = memoryLogAppendStore();
  const cloud = await logged(await signed(body(RELEASE_ID, "cloudflare"), provenance.private), RELEASE_ID, START);
  store.intents.set(cloud.envelopeDigest, cloud);
  const reproduction =
    loggedAt === undefined
      ? undefined
      : await logged(
          await Effect.runPromise(countersign(await signed(body(REPRO_ID, "device"), device.private), provenance.private)),
          REPRO_ID,
          loggedAt,
        );
  const layer = Layer.mergeAll(
    Layer.succeed(LogAppendStore, store),
    Layer.succeed(RepositoryVisibility, { of: () => Effect.succeed("private") }),
    Layer.succeed(AlarmPort, { deliver: () => Effect.void }),
    Logless,
  );

  // Comparisons at seeded times from the release's log time to an hour past the deadline, the deadline itself among them.
  const end = deadlineAt + 3_600_000;
  const times = [deadlineAt - 1, deadlineAt, ...Array.from({ length: 6 }, () => START + Math.floor(random() * (end - START)))]
    .filter((t) => t >= START)
    .sort((a, b) => a - b);
  for (const now of times) {
    if (reproduction !== undefined && loggedAt! <= now) store.intents.set(reproduction.envelopeDigest, reproduction);
    const exit = await Effect.runPromiseExit(
      settleReproduction(
        { release, reproductionExecutionId: REPRO_ID, deadlineAt },
        [provenance.public],
        provenance.private,
        now,
      ).pipe(Effect.provide(layer)),
    );
    const outcome = Exit.isSuccess(exit) ? exit.value : undefined;
    const error = Exit.match(exit, {
      onSuccess: () => undefined,
      onFailure: (cause) => Option.getOrUndefined(Cause.findErrorOption(cause)),
    });
    const reason = error instanceof ReproductionRefused ? error.reason : undefined;
    const loggedByDeadline = loggedAt !== undefined && loggedAt <= deadlineAt && loggedAt <= now;
    if (loggedByDeadline) {
      if (outcome === undefined || !ReproductionOutcome.$is("Reproduced")(outcome))
        violate(`at ${now - START} the statement logged at ${loggedAt! - START} by the deadline did not reproduce`);
      else reach("reproduced");
    } else if (now < deadlineAt) {
      if (outcome === undefined || !ReproductionOutcome.$is("Awaiting")(outcome))
        violate(`at ${now - START}, before the deadline ${deadlineAt - START}, the release did not await its reproduction`);
      else reach("awaiting");
    } else if (reason !== REPRODUCTION_UNAVAILABLE)
      violate(
        `at ${now - START}, from the deadline ${deadlineAt - START} on with no statement logged by it, the release concluded ${reason ?? "without failure"}`,
      );
    else {
      reach("unavailable");
      if (loggedAt !== undefined && loggedAt <= now) reach("lateIgnored");
    }
  }
  return { violations, reached };
};

/** The scenario the `sim` job runs, 100 seeds on a pull request and 10,000 nightly (FD-VER-024). */
export const scenarios: readonly SimScenario[] = [
  {
    name: "reproduction-deadline",
    ids: ["FD-PROV-068"],
    run: async (seed) => throwOnViolations((await simulateReproductionDeadline(seed)).violations),
  },
];
