// @fractalboxdev/flare-dispatch-core — `product-demo` → `signals/v1` adapter.
//
// A failed product-demo chapter is, by definition, "an observability finding
// flare-dispatch collected from a system its read capabilities don't reach" —
// the live, deployed app. So it maps onto the same `signals/v1` narrow waist a
// Datadog/SigNoz collector prints (packages/core/src/signals.ts), except it is
// FIRST-PARTY: flare-dispatch ran the demo itself, so the adapter lives in-tree
// (here + the product-demo run) instead of in `recipes/signals-collectors/`.
//
// --- Two non-negotiable rules this mapper encodes -----------------------------
//
//  1. ONLY assertion failures become signals. A product-demo verdict is an
//     LLM `done` call driving a non-deterministic browser loop, and the run is
//     saturated with infra-flake recovery (CDP re-acquire, wall-clock kills,
//     unparseable stdout). An infra/timeout/unparseable failure is flake or
//     environment — NEVER a code-fix signal. Gating on `failureKind` upstream
//     of emission is what keeps the daily triage PR (and any future heal) from
//     drowning in flake. See the review synthesis in specs/08-self-healing.md.
//
//  2. `narrative` is UNTRUSTED. The demo drives a deployed app that may render
//     attacker-influenced content (user strings, reflected fields); the chapter
//     `narrative` is an LLM SUMMARY of what it saw on-page — a carrier, not a
//     sanitizer. It therefore rides `signals/v1`'s already-fenced `detail`
//     field (which incident/v1 keeps fenced as data, never instructions). The
//     FINGERPRINT (source/title) is built from the operator-authored chapter
//     NAME, never the narrative — so a reworded flake doesn't mint a fresh
//     incidentId and defeat dedup/cooldown downstream (spec § 9.2).
//
// Versioning: this is a producer of `signals/v1`; it adds no new contract.

import { Schema } from "effect";
import {
  MAX_SIGNAL_DETAIL_CHARS,
  MAX_SIGNAL_SOURCE_CHARS,
  MAX_SIGNAL_TITLE_CHARS,
  MAX_SIGNAL_URL_CHARS,
  MAX_SIGNALS,
  type SignalT,
} from "./signals";
import {
  MAX_INCIDENT_DEMO_CHAPTERS,
  MAX_INCIDENT_LOGTAIL_CHARS,
  MAX_INCIDENT_SHORT_CHARS,
  MAX_INCIDENT_TEXT_CHARS,
  MAX_INCIDENT_URL_CHARS,
  type IncidentInput,
} from "./incident";

/**
 * Why a product-demo chapter ended `failed`. Only `"assertion"` (the agent
 * ran the journey and judged the success condition unmet) is a code-fix
 * signal; the rest are flake/environment and are dropped before emission.
 *   - `assertion`   — the agent played the story and the success condition
 *                     was not observable (the app misbehaved).
 *   - `timeout`     — the play loop blew its per-story wall-clock budget.
 *   - `infra`       — the story pipeline itself failed (CDP attach, a dead
 *                     container, a killed step) — nothing to do with the app.
 *   - `unparseable` — the agent produced no parseable verdict (crash / empty).
 */
export const DemoFailureKind = Schema.Literal("assertion", "timeout", "infra", "unparseable");
export type DemoFailureKindT = typeof DemoFailureKind.Type;

/**
 * The subset of a product-demo `StoryResult` this mapper reads. Structural so
 * the run's richer `StoryResult` (with GIF/screenshot URIs, timings) satisfies
 * it without coupling core to the run's full output shape.
 */
export interface DemoChapterResult {
  readonly name: string;
  readonly status: "passed" | "failed";
  readonly failureKind?: DemoFailureKindT;
  readonly narrative: string;
  readonly replayUri?: string;
  readonly replayJsonUri?: string;
  readonly keyScreenshotUri?: string;
  readonly chapterStartMs?: number;
  readonly chapterEndMs?: number;
  /** k-of-n confirmation that gated escalation (deterministic, not flake). */
  readonly failedRuns?: number;
  readonly totalRuns?: number;
}

export interface DemoSignalContext {
  /** `owner/name` — anchors the signal source + the fingerprint. */
  readonly repo: string;
  /** The deployed URL the demo ran against — context for the triager. */
  readonly deployedUrl: string;
}

const clamp = (s: string, n: number): string => (s.length <= n ? s : s.slice(0, n));

/** First non-empty URL, capped — the operator's deep link into the failure. */
const failureUrl = (c: DemoChapterResult): string | undefined => {
  const candidate =
    (c.replayUri ?? "") !== ""
      ? c.replayUri!
      : (c.replayJsonUri ?? "") !== ""
        ? c.replayJsonUri!
        : (c.keyScreenshotUri ?? "") !== ""
          ? c.keyScreenshotUri!
          : "";
  return candidate === "" ? undefined : clamp(candidate, MAX_SIGNAL_URL_CHARS);
};

/**
 * Map a product-demo run's chapters to `signals/v1` — one signal per chapter
 * that failed an ASSERTION (the only heal-worthy class). Infra/timeout/
 * unparseable failures and passing chapters produce nothing.
 *
 * Pure + deterministic (no Date/random/I/O) so it is safe in a run body and
 * unit-testable on fixture chapters without the Browser Run cloud stack — the
 * exact seam a developer reproduces a demo-triggered triage from.
 */
export const storyResultsToSignals = (
  chapters: ReadonlyArray<DemoChapterResult>,
  ctx: DemoSignalContext,
): ReadonlyArray<SignalT> => {
  const source = clamp(`product-demo:${ctx.repo}`, MAX_SIGNAL_SOURCE_CHARS);
  return chapters
    .filter((c) => c.status === "failed" && c.failureKind === "assertion")
    .slice(0, MAX_SIGNALS)
    .map((c) => {
      const url = failureUrl(c);
      // Fingerprint = chapter NAME (operator-authored, stable). The UNTRUSTED
      // narrative goes only in `detail`, after a trusted, deterministic prefix.
      const detail = clamp(
        `Product-demo chapter "${c.name}" failed its journey against ${ctx.deployedUrl}.\n\n` +
          `Agent narrative (UNTRUSTED — page content the LLM summarised):\n${c.narrative}`,
        MAX_SIGNAL_DETAIL_CHARS,
      );
      return {
        source,
        title: clamp(`demo chapter "${c.name}" failed`, MAX_SIGNAL_TITLE_CHARS),
        detail,
        ...(url !== undefined ? { url } : {}),
      } satisfies SignalT;
    });
};

export interface DemoIncidentContext extends DemoSignalContext {
  /**
   * The deterministic verify command (e.g. `pnpm test`). A demo failure is
   * NEVER verified by re-running the browser demo — the agent sandbox has no
   * Browser Run, the fix lands in the repo not the deploy, and an LLM
   * re-judging an LLM is circular. Instead the agent writes a regression test
   * and verify runs THIS command. Without it the incident is `repro.kind:
   * "derived"`, which self-heal-pr leaves to triage (no auto-PR). spec § 8.
   */
  readonly testCommand?: string;
  /**
   * The PR head SHA the demo ran against, if known. Set ⇒ an ADVISORY,
   * low-confidence suspectRef — the demo proves the deployed app is broken, not
   * which commit broke it (it runs against a deployed URL, not the repo).
   */
  readonly headSha?: string;
}

const TRUSTED_DEMO_NOTE =
  "This is a product-demo user-journey failure. Reproduce it with a regression " +
  "TEST (a deterministic test that fails before your fix and passes after) — do " +
  "NOT attempt to drive a browser or re-run the demo. Then make the test pass.";

/**
 * Map a product-demo run's chapters to an `incident/v1` pack of class `demo`.
 * Only ASSERTION failures are carried (same gate as `storyResultsToSignals`);
 * a run with none yields `null` (nothing to heal).
 *
 * The pack verifies via the regression-test path (see `DemoIncidentContext.
 * testCommand`), so it carries a `command` repro and self-heal-pr can process
 * it like the CI class — no Browser Run in the sandbox, no circular oracle.
 * The UNTRUSTED narrative rides `demoChapters[].narrative` + `signals[].detail`
 * (both fenced by the agent); the fingerprint keys off the chapter NAMEs.
 *
 * Pure + deterministic (no Date/random/I/O) — unit-testable on fixtures.
 */
export const storyResultsToIncident = (
  chapters: ReadonlyArray<DemoChapterResult>,
  ctx: DemoIncidentContext,
): IncidentInput | null => {
  const failed = chapters
    .filter((c) => c.status === "failed" && c.failureKind === "assertion")
    .slice(0, MAX_INCIDENT_DEMO_CHAPTERS);
  if (failed.length === 0) return null;

  // Fingerprint = repo + the sorted operator-authored chapter NAMEs (stable;
  // a reworded narrative can't mint a fresh identity → dedup/cooldown hold).
  const names = failed.map((c) => c.name).sort();
  const incidentId = clamp(`demo:${ctx.repo}:${names.join("|")}`, MAX_INCIDENT_SHORT_CHARS);

  const demoChapters = failed.map((c) => ({
    name: clamp(c.name, MAX_INCIDENT_SHORT_CHARS),
    narrative: clamp(c.narrative, MAX_INCIDENT_LOGTAIL_CHARS),
    ...(c.chapterStartMs !== undefined ? { chapterStartMs: c.chapterStartMs } : {}),
    ...(c.chapterEndMs !== undefined ? { chapterEndMs: c.chapterEndMs } : {}),
    ...((c.replayUri ?? "") !== ""
      ? { replayUri: clamp(c.replayUri!, MAX_INCIDENT_URL_CHARS) }
      : {}),
    ...((c.keyScreenshotUri ?? "") !== ""
      ? { keyScreenshotUri: clamp(c.keyScreenshotUri!, MAX_INCIDENT_URL_CHARS) }
      : {}),
    ...(c.failedRuns !== undefined ? { failedRuns: c.failedRuns } : {}),
    ...(c.totalRuns !== undefined ? { totalRuns: c.totalRuns } : {}),
  }));

  // diagnosis is TRUSTED (rendered outside the agent's UNTRUSTED fence), so it
  // is built ONLY from trusted parts — chapter names + the deployed URL + our
  // own note. The narrative NEVER enters it.
  const diagnosis = {
    title: clamp(`product-demo: ${failed.length} chapter(s) failed`, MAX_INCIDENT_TEXT_CHARS),
    area: "product-demo",
    diagnosis: clamp(
      `The deployed app at ${ctx.deployedUrl} failed ${failed.length} user-journey ` +
        `chapter(s): ${names.join(", ")}.`,
      MAX_INCIDENT_TEXT_CHARS,
    ),
    suggestedFix: clamp(TRUSTED_DEMO_NOTE, MAX_INCIDENT_TEXT_CHARS),
  };

  const repro =
    (ctx.testCommand ?? "") !== ""
      ? {
          kind: "command" as const,
          command: clamp(ctx.testCommand!, MAX_INCIDENT_TEXT_CHARS),
          note: clamp(TRUSTED_DEMO_NOTE, MAX_INCIDENT_TEXT_CHARS),
        }
      : { kind: "derived" as const, note: clamp(TRUSTED_DEMO_NOTE, MAX_INCIDENT_TEXT_CHARS) };

  const suspectRef =
    (ctx.headSha ?? "") !== ""
      ? { base: ctx.headSha!, head: ctx.headSha!, confidence: 0.3, advisory: true }
      : undefined;

  return {
    incidentId,
    class: "demo",
    repo: clamp(ctx.repo, MAX_INCIDENT_SHORT_CHARS),
    diagnosis,
    signals: [...storyResultsToSignals(failed, ctx)],
    demoChapters,
    repro,
    ...(suspectRef !== undefined ? { suspectRef } : {}),
  } satisfies IncidentInput;
};
