// The countersign-and-log step as a V-REPLAY workflow (specs/provenance.md FD-PROV-034). One run accepts a device
// statement, countersigns it, records its log-append intent and drains the intents into the private log. The journal
// keeps the countersign step's envelope, the log-append intents (the `provenance_log_appends` rows) and the private
// log's entries; a second run over it reruns the record and drain steps, as an engine replay whose step results were
// lost after the countersign. The intents live in memory (append.test-support.ts): the harness runs in Node without
// workerd.
//
// Effects: `intent` for each log-append intent recorded and each append sent to a log, `d1` for each intent row
// written.
import { Effect, Layer, Logger } from "effect";
import type { ReplayEffect, ReplayWorkflow } from "../../../ops/src/verification/harness.ts";
import { utf8 } from "../../src/crypto.ts";
import {
  drainLogAppends,
  enqueueLogAppend,
  LogAppendStore,
  publicJwkOf,
  RepositoryVisibility,
  TransparencyLogs,
  type LogAppendIntent,
  type LogEntry,
} from "../../src/provenance/append.ts";
import { memoryLogAppendStore } from "../../src/provenance/append.test-support.ts";
import {
  countersignAccepted,
  CountersignOutcome,
  StatementBinding,
} from "../../src/provenance/countersign.ts";
import {
  DSSE_PAYLOAD_TYPE,
  dssePae,
  parseProvenanceKey,
  signPae,
  unsignedEnvelope,
  type DsseEnvelope,
} from "../../src/provenance/dsse.ts";

export const EXECUTION = "exec-replay-1";
export const REPOSITORY = "acme/widgets";

/** What a rerun finds in place: the countersigned envelope, the intent rows and the private log's entries. */
export interface Journal {
  readonly envelope: DsseEnvelope;
  readonly verifiers: readonly JsonWebKey[];
  readonly intents: Map<string, LogAppendIntent>;
  readonly entries: string[];
}

export interface LogAppendRun {
  readonly journal: Journal;
  readonly effects: readonly ReplayEffect[];
}

const keyPair = async (kid: string) => {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const priv = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  return parseProvenanceKey(JSON.stringify({ ...priv, kid }))!;
};

/** The first run's countersign step: a device statement, accepted and countersigned. */
const countersignStep = async () => {
  const device = await keyPair("device-1");
  const provenance = await keyPair("prov-1");
  const payload = utf8(JSON.stringify({ _type: "https://in-toto.io/Statement/v1", subject: [] }));
  const submitted: DsseEnvelope = {
    ...unsignedEnvelope(payload),
    signatures: [await signPae(device, dssePae(DSSE_PAYLOAD_TYPE, payload))],
  };
  const outcome = await Effect.runPromise(
    countersignAccepted(
      submitted,
      StatementBinding.ExecutionLease({ executionId: EXECUTION, epoch: 1 }),
      provenance,
    ),
  );
  if (!CountersignOutcome.$is("Countersigned")(outcome)) throw new Error("not countersigned");
  return { envelope: outcome.envelope, verifiers: [publicJwkOf(device), publicJwkOf(provenance)] };
};

/** Runs the workflow from no journal, or reruns its record and drain steps over `journal`. */
export const logAppendRun = async (journal: Journal | null): Promise<LogAppendRun> => {
  const effects: ReplayEffect[] = [];
  const counted = journal ?? (await countersignStep());
  const intents = journal?.intents ?? new Map<string, LogAppendIntent>();
  const entries = journal?.entries ?? [];
  const store = memoryLogAppendStore(intents);
  const append = (envelopeJson: string): Effect.Effect<LogEntry> =>
    Effect.sync(() => {
      const digest = [...intents.values()].find((i) => i.envelope === envelopeJson)?.envelopeDigest;
      effects.push({ kind: "intent", key: `append private ${digest}` });
      let index = entries.indexOf(envelopeJson);
      if (index === -1) index = entries.push(envelopeJson) - 1;
      return {
        log: "private",
        logIndex: index,
        entryId: `leaf-${index}`,
        integratedTime: 1_000 + index,
      };
    });
  const layer = Layer.mergeAll(
    Layer.succeed(LogAppendStore, store),
    Layer.succeed(RepositoryVisibility, { of: () => Effect.succeed("private") }),
    Layer.succeed(TransparencyLogs, {
      rekor: () => Effect.die("the replayed repository is private"),
      private: append,
    }),
    Logger.layer([]),
  );
  const recorded = await Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const intent = yield* enqueueLogAppend(
          {
            envelope: counted.envelope,
            executionId: EXECUTION,
            repository: REPOSITORY,
            verifiers: counted.verifiers,
          },
          1_000,
        );
        yield* drainLogAppends(1_000);
        return intent;
      }),
      layer,
    ),
  );
  if (recorded.inserted) effects.push({ kind: "intent", key: `log-append ${recorded.digest}` });
  effects.push(...store.writes.map((w) => ({ kind: "d1" as const, key: w.key })));
  return {
    journal: { envelope: counted.envelope, verifiers: counted.verifiers, intents, entries },
    effects,
  };
};

/** The workflow the `replay` job runs twice (FD-VER-025). */
export const workflows: readonly ReplayWorkflow<Journal>[] = [
  { name: "log-append", ids: ["FD-PROV-034"], run: logAppendRun },
];
