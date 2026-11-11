// The drift-profile subject of the `diff` job (specs/verification.md § V-DIFF): each event is one drift check, the
// configuration checks' findings and the profile document the deploy carries, answered by `driftCheckFindings` with
// `failed` (packages/ops/src/drift.ts) and by `oracle drift`, compiled from `formal/FdFormal/Drift.lean`. The Lean model
// takes mameko's profile loader's answer as its input, so the oracle side delivers the event's document to a fresh
// loader under FlareDispatch's validation context and sends the oracle that answer. The generator draws the document
// from FlareDispatch's production document at every phase, with sections exchanged between phases, sections that do
// not decode and a mismatched policy version, so accepted documents, validation rejections with paths and decode
// rejections with an empty path are all reached.
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  loadProfile,
  profileDocumentFor,
  profileLoader,
  validationContext,
  type Phase,
} from "@fractalboxdev/flare-dispatch-profile";
import type { ProfileDocument } from "@fractalboxdev/mameko-ports";
import { Effect } from "effect";
import fc from "fast-check";
import { driftCheckFindings, failed, type Finding } from "../../src/drift.ts";
import type { DiffSubject } from "../../src/verification/diff.ts";
import { pipeOracle, type PipeOracle } from "../../src/verification/pipe-oracle.ts";

/** One drift check: what the configuration checks found and the profile document the deploy carries. */
export interface DriftEvent {
  readonly configFindings: readonly Finding[];
  readonly document: ProfileDocument;
}

/** One finding as the Lean model states it: a warning is a finding that is not a failure. */
export interface ModelFinding {
  readonly check: string;
  readonly path: string;
  readonly detail: string;
  readonly failure: boolean;
}

export interface DriftAnswer {
  readonly findings: readonly ModelFinding[];
  readonly fails: boolean;
}

/** mameko's profile loader's answer to a document, the Lean model's `LoadAnswer`. */
export type LoadAnswer =
  | { readonly _tag: "accepted" }
  | {
      readonly _tag: "rejected";
      readonly rejections: readonly {
        readonly item: string;
        readonly path: string;
        readonly reason: string;
      }[];
    };

const modelFinding = (f: Finding): ModelFinding => ({
  check: f.check,
  path: f.path,
  detail: f.detail,
  failure: f.severity === "failure",
});

/** The drift check over the event: `driftCheckFindings` under FlareDispatch's validation context, and `failed`. */
export const runDrift = (e: DriftEvent): DriftAnswer => {
  const findings = Effect.runSync(
    driftCheckFindings(e.configFindings, e.document, validationContext),
  );
  return { findings: findings.map(modelFinding), fails: failed(findings) };
};

/** A fresh loader's answer to the event's document under FlareDispatch's validation context. */
export const loadAnswer = (document: ProfileDocument): LoadAnswer =>
  Effect.runSync(
    loadProfile(profileLoader(validationContext), document).pipe(
      Effect.match({
        onSuccess: (): LoadAnswer => ({ _tag: "accepted" }),
        onFailure: (rejected): LoadAnswer => ({
          _tag: "rejected",
          rejections: rejected.rejections.map((r) => ({
            item: r.item,
            path: r.path,
            reason: r.reason,
          })),
        }),
      }),
    ),
  );

const PHASES: readonly Phase[] = [0, 1, 2, 3, 4];
const BASE = profileDocumentFor("production", 0);
const SECTIONS = Object.keys(BASE.document as object).filter((k) => k !== "policy_version");

const finding: fc.Arbitrary<Finding> = fc.record({
  check: fc.constantFrom("placeholder", "keep_vars", "cron", "binding", "admission-cap", "render"),
  path: fc.oneof(
    fc.constantFrom("control-plane.DB", "control-plane.containers.LeanPool.max_instances", ""),
    fc.string({ maxLength: 12 }),
  ),
  detail: fc.string({ maxLength: 24 }),
  severity: fc.constantFrom("failure", "warning"),
});

/**
 * A profile document: the phase-0 production document with sections taken from another phase's document, sections that
 * do not decode, and, now and then, an envelope whose policy version is not the document's.
 */
export const profileDocument: fc.Arbitrary<ProfileDocument> = fc
  .record({
    phase: fc.constantFrom(...PHASES),
    exchanged: fc.subarray(SECTIONS, { maxLength: 4 }),
    from: fc.constantFrom(...PHASES),
    undecodable: fc.oneof(
      { weight: 3, arbitrary: fc.constant<string[]>([]) },
      { weight: 1, arbitrary: fc.subarray(SECTIONS, { minLength: 1, maxLength: 2 }) },
    ),
    policyVersion: fc.constantFrom(null, null, null, null, null, null, null, "other"),
  })
  .map(({ phase, exchanged, from, undecodable, policyVersion }) => {
    const base = profileDocumentFor("production", phase);
    const other = profileDocumentFor("production", from).document as Record<string, unknown>;
    const document: Record<string, unknown> = { ...(base.document as Record<string, unknown>) };
    for (const k of exchanged) document[k] = other[k];
    for (const k of undecodable) document[k] = null;
    return { document, policyVersion: policyVersion ?? base.policyVersion };
  });

export const driftEvent: fc.Arbitrary<DriftEvent> = fc.record({
  configFindings: fc.array(finding, { maxLength: 4 }),
  document: profileDocument,
});

/** The oracle executable `lake build oracle` writes in `formal/`. */
export const ORACLE_PATH = join(import.meta.dirname, "../../../../formal/.lake/build/bin/oracle");

let oracle: PipeOracle<unknown, DriftAnswer> | undefined;

const startOracle = (): PipeOracle<unknown, DriftAnswer> => {
  if (!existsSync(ORACLE_PATH))
    throw new Error(`no oracle at ${ORACLE_PATH}: run \`lake build oracle\` in formal/`);
  return pipeOracle<unknown, DriftAnswer>(ORACLE_PATH, ["drift"]);
};

export const subject: DiffSubject<DriftEvent, DriftAnswer> = {
  kernel: "driftProfile",
  run: runDrift,
  oracle: (e) =>
    (oracle ??= startOracle()).ask({
      configFindings: e.configFindings.map(modelFinding),
      answer: loadAnswer(e.document),
    }),
  arbitrary: driftEvent,
  close: () => {
    oracle?.close();
    oracle = undefined;
  },
};
