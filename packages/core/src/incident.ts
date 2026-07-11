// @fractalboxdev/flare-dispatch-core — the `incident/v1` contract.
//
// An *incident* is the bounded, model-ready bundle a self-heal run hands to a
// coding agent: the synthesis of caller-supplied `signals/v1` findings, the
// first-party CI failures flare-dispatch saw itself, the suspect code locus,
// and how to reproduce the failure. It is the FIX-side narrow waist — the
// audited boundary the agent sees and nothing else — the sibling of the
// ingestion-side `signals/v1` waist.
//
// Spec: specs/08-self-healing.md § 5 (Synthesis: the incident/v1 context pack).
//
// --- SECURITY: parts of this pack are ATTACKER-CONTROLLED ---------------------
//
// `signals` (title/detail), `ciFailures[].logTail`, and `demoChapters[].narrative`
// are telemetry — anyone who can emit a log line, fire an alert, or get content
// rendered on a demo'd page influences them. (A product-demo `narrative` is an
// LLM SUMMARY of a live, possibly attacker-influenced page — a carrier, not a
// sanitizer.) They flow into a coding agent that WRITES CODE, so they are a
// prompt-injection vector. The schema caps BYTES, not TRUST: the consumer of
// this pack MUST keep these fields fenced as data (never instructions), and the
// agent's output is still gated by sandbox-verify + the writeback allowlist. See
// specs/08-self-healing.md § 10.1.
//
// Versioning: additive changes (new OPTIONAL fields) stay `v1`. Renaming,
// removing, or tightening a field is `v2` — a new schema, not an edit. Mirrors
// the `signals/v1` policy (packages/core/src/signals.ts).

import { Schema } from "effect";
import { SignalArray } from "./signals";

/** The contract version. Bump only on breaking change (see header). */
export const INCIDENT_CONTRACT_VERSION = "v1";

// Caps — bound the pack well under the CF Workflows step-result / params ceiling
// (1 MiB). signals is already capped by `signals/v1` (50 × ~2 KB); these bound
// the first-party + synthesis additions.
export const MAX_INCIDENT_CI_FAILURES = 20;
export const MAX_INCIDENT_DEMO_CHAPTERS = 20;
export const MAX_INCIDENT_SUSPECT_FILES = 50;
export const MAX_INCIDENT_LOGTAIL_CHARS = 4_000;
export const MAX_INCIDENT_TEXT_CHARS = 2_000;
export const MAX_INCIDENT_SHORT_CHARS = 200;
export const MAX_INCIDENT_PATH_CHARS = 400;
export const MAX_INCIDENT_URL_CHARS = 1_000;

const bounded = (n: number) => Schema.String.pipe(Schema.maxLength(n));

/**
 * Which error class produced the incident — drives repro strength + scoping.
 *   - `ci`          — a first-party CI failure; strong command repro (re-run it).
 *   - `application` — a runtime failure surfaced by a caller signal; derived/weak
 *                     repro (V1-experimental).
 *   - `demo`        — a product-demo user-journey failure. First-party but the
 *                     verdict is LLM-driven and the demo runs against a deployed
 *                     URL, not the repo — so it is NEVER verified by re-running
 *                     the browser demo (no Browser Run in the agent sandbox; an
 *                     LLM re-judging an LLM is circular). Instead the agent writes
 *                     a deterministic regression test reproducing the failure and
 *                     verify runs the test COMMAND — so a demo incident carries a
 *                     `repro.kind: "command"` test command, like the CI class.
 */
export const IncidentClass = Schema.Literal("ci", "application", "demo");
export type IncidentClassT = typeof IncidentClass.Type;

/** The model's prior diagnosis — reuses the `ci-triage-pr` TriageReport item shape. */
export const Diagnosis = Schema.Struct({
  title: bounded(MAX_INCIDENT_TEXT_CHARS),
  area: bounded(MAX_INCIDENT_TEXT_CHARS),
  diagnosis: bounded(MAX_INCIDENT_TEXT_CHARS),
  suggestedFix: bounded(MAX_INCIDENT_TEXT_CHARS),
});

/** One first-party CI failure flare-dispatch observed (UNTRUSTED `logTail`). */
export const CiFailure = Schema.Struct({
  kind: Schema.Literal("actions", "pages", "run-step"),
  name: bounded(MAX_INCIDENT_TEXT_CHARS),
  conclusion: bounded(MAX_INCIDENT_SHORT_CHARS),
  /** The exact failing command — the repro for the CI class. */
  command: Schema.optional(bounded(MAX_INCIDENT_TEXT_CHARS)),
  /** Bounded stderr/stdout tail from R2 — attacker-influenceable. */
  logTail: Schema.optional(bounded(MAX_INCIDENT_LOGTAIL_CHARS)),
  url: Schema.optional(bounded(MAX_INCIDENT_URL_CHARS)),
});

/**
 * One failed product-demo chapter — the evidence behind a `demo`-class
 * incident. `narrative` is UNTRUSTED (an LLM summary of a live, possibly
 * attacker-influenced page); the URIs are human deep-links (the agent does NOT
 * fetch them — the agent sandbox is egress-restricted). `failedRuns/totalRuns`
 * record the k-of-n confirmation that gated escalation (one chapter that failed
 * deterministically, not flake).
 */
export const DemoChapter = Schema.Struct({
  name: bounded(MAX_INCIDENT_SHORT_CHARS),
  /** UNTRUSTED — the LLM's summary of what it saw on-page. */
  narrative: Schema.optional(bounded(MAX_INCIDENT_LOGTAIL_CHARS)),
  /** rrweb chapter offsets — the failure window a human scrubs to. */
  chapterStartMs: Schema.optional(Schema.Number),
  chapterEndMs: Schema.optional(Schema.Number),
  /** Human deep-links — NOT fetched by the agent. */
  replayUri: Schema.optional(bounded(MAX_INCIDENT_URL_CHARS)),
  keyScreenshotUri: Schema.optional(bounded(MAX_INCIDENT_URL_CHARS)),
  /** k-of-n confirmation that gated escalation (deterministic, not flake). */
  failedRuns: Schema.optional(Schema.Number),
  totalRuns: Schema.optional(Schema.Number),
});

/**
 * The suspect code range to inspect. Only populated when the deploy is
 * correlatable (flare-dispatch-dispatched); `advisory` flags a low-confidence
 * heuristic correlation the agent must not over-trust (spec § 5 / § 13 Q3).
 */
export const SuspectRef = Schema.Struct({
  base: bounded(MAX_INCIDENT_PATH_CHARS),
  head: bounded(MAX_INCIDENT_PATH_CHARS),
  /** 0–1 correlation confidence; below threshold → advisory. */
  confidence: Schema.optional(Schema.Number),
  advisory: Schema.optional(Schema.Boolean),
});

/** How the agent/verifier reproduces the failure. */
export const Repro = Schema.Struct({
  kind: Schema.Literal("command", "derived", "none"),
  /** The exact command to re-run (CI class, `kind="command"`). */
  command: Schema.optional(bounded(MAX_INCIDENT_TEXT_CHARS)),
  /** Guidance when derived (app class) — e.g. "stack frame …; write a failing test first". */
  note: Schema.optional(bounded(MAX_INCIDENT_TEXT_CHARS)),
});

/**
 * `incident/v1` — the bounded context a self-heal coding agent receives.
 */
export const Incident = Schema.Struct({
  contractVersion: Schema.optionalWith(Schema.Literal(INCIDENT_CONTRACT_VERSION), {
    default: () => INCIDENT_CONTRACT_VERSION,
  }),
  /** Dedup identity of the FAILURE (not the alert delivery). spec § 9.2. */
  incidentId: bounded(MAX_INCIDENT_SHORT_CHARS),
  class: IncidentClass,
  /** `owner/name`. */
  repo: bounded(MAX_INCIDENT_SHORT_CHARS),
  suspectRef: Schema.optional(SuspectRef),
  diagnosis: Schema.optional(Diagnosis),
  /** Caller-supplied observability findings — UNTRUSTED. */
  signals: Schema.optionalWith(SignalArray, { default: () => [] }),
  /** First-party CI failures flare-dispatch saw — `logTail` UNTRUSTED. */
  ciFailures: Schema.optionalWith(
    Schema.Array(CiFailure).pipe(Schema.maxItems(MAX_INCIDENT_CI_FAILURES)),
    { default: () => [] },
  ),
  /** Failed product-demo chapters (`demo` class) — `narrative` UNTRUSTED. */
  demoChapters: Schema.optionalWith(
    Schema.Array(DemoChapter).pipe(Schema.maxItems(MAX_INCIDENT_DEMO_CHAPTERS)),
    { default: () => [] },
  ),
  /** Files to inspect — from changed-files (CI) or a stack frame (app). */
  suspectFiles: Schema.optionalWith(
    Schema.Array(bounded(MAX_INCIDENT_PATH_CHARS)).pipe(
      Schema.maxItems(MAX_INCIDENT_SUSPECT_FILES),
    ),
    { default: () => [] },
  ),
  repro: Schema.optional(Repro),
});
export type IncidentT = typeof Incident.Type;
/** The ENCODED (input) shape — optionals-with-defaults are optional here. This
 * is what a synthesizer constructs + dispatches; the receiving run decodes it
 * back to `IncidentT` (applying the defaults). */
export type IncidentInput = typeof Incident.Encoded;
