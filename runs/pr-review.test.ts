// Run-level unit tests for the `pr-review` run (v3 — Worker-side engine).
//
// Exercises the run Effect against the in-memory test runtime
// (`makeCFRuntimeTest`) — no CF, no Docker, no network, no model provider.
//
// The `review` step calls the model (the `coordinate` step is pure code), so
// the *model path* is covered exhaustively in the engine's own unit tests
// (packages/review-agent/src/engine.test.ts) with a stub `HttpClient`. These
// run-level tests cover the ORCHESTRATION that needs no model:
//
//   (a) diff via git    — `prepare-diff` shells out to `git diff --output=<file>`
//                          (not a `review-agent` CLI), reads the FULL diff back
//                          via `sandbox.readFile` (never the 16KB-tail
//                          `ExecResult.stdout`), and a non-zero git exit FAILS
//                          the step (honest red check).
//   (b) always-comment  — on ANY failure the run still posts a PR review
//                          comment (the operator must always get a comment),
//                          via the `github.pullReview` write capability.
//   (c) misconfig        — an unconfigured backend fails with a comment naming
//                          the missing config key.
//   (d) determinism      — no Date.now() / crypto.randomUUID() / Math.random()
//                          in the run source.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { describe, expect } from "vitest";
import { makeCFRuntimeTest } from "@fractalboxdev/flare-dispatch-core/testing";
import { ModelGatewayError } from "@fractalboxdev/flare-dispatch-core";
import { prReview } from "./pr-review";

const baseInput = {
  repo: "owner/name",
  sha: "abc123",
  baseSha: "base456",
  pr: 42,
  installationId: 7,
} as const;

/** Where the run writes + reads the diff inside the container. */
const DIFF_FILE = "/tmp/pr-review.diff";

/** Backend config so the run survives `resolve-backend` (now the first step). */
const backendConfig = {
  "pr-review.workers-ai.model": "@cf/test/model",
} as const;

/** A scripted `report` tool call answering every domain reviewer with no findings. */
const emptyReport = {
  toolCalls: [{ name: "report", arguments: { findings: [] } }],
  text: "",
} as const;

describe("pr-review", () => {
  it.effect(
    "prepare-diff shells out to `git diff --output=<file>`, not a review-agent CLI",
    () => {
      const { layer, handles } = makeCFRuntimeTest({
        config: backendConfig,
        sandboxProgram: {
          "git diff": { exitCode: 0, stdout: "" },
        },
        sandboxFiles: { [DIFF_FILE]: "diff --git a/x.ts b/x.ts\n+++ b/x.ts\n+x\n" },
        modelGateway: { responses: [emptyReport] },
      });

      return Effect.gen(function* () {
        yield* Effect.exit(prReview.run(baseInput));

        const diffExec = handles.sandbox.execs.find((e) =>
          e.command.startsWith("git diff"),
        );
        expect(diffExec).toBeDefined();
        // THREE-dot range (merge-base → head), never two-dot endpoints:
        // `baseSha` is the base branch tip at event time, so a two-dot diff
        // on a PR behind its base reviews the base's own newer commits as
        // phantom deletions.
        expect(diffExec?.command).toContain(
          `${baseInput.baseSha}...${baseInput.sha}`,
        );
        expect(diffExec?.command).toContain(`--output=${DIFF_FILE}`);
        // The diff is read back in full from the file.
        expect(handles.sandbox.reads).toContainEqual({ path: DIFF_FILE });
        // The old `review-agent` CLI is gone entirely.
        const reviewAgent = handles.sandbox.execs.find((e) =>
          e.command.includes("review-agent"),
        );
        expect(reviewAgent).toBeUndefined();
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "the reviewers see the FULL file diff, not the 16KB ExecResult.stdout tail",
    () => {
      // A diff large enough that an stdout-tail read would (a) under-count the
      // risk tier and (b) hide the leading sections from the model. The exec's
      // stdout is a decoy tail — only the file carries the real diff.
      const marker = "+const LEADING_SECTION_ONLY_IN_THE_FILE = true;";
      const bigDiff = [
        "diff --git a/lead.ts b/lead.ts",
        "+++ b/lead.ts",
        marker,
        ...Array.from({ length: 300 }, (_, i) => `+const pad${i} = ${i};`),
      ].join("\n");

      const { layer, handles } = makeCFRuntimeTest({
        config: backendConfig,
        sandboxProgram: {
          "git diff": { exitCode: 0, stdout: "(decoy tail — must not be used)" },
        },
        sandboxFiles: { [DIFF_FILE]: bigDiff },
        modelGateway: { responses: [emptyReport] },
      });

      return Effect.gen(function* () {
        yield* Effect.exit(prReview.run(baseInput));

        // Every domain reviewer's user message embeds the file's diff,
        // including its LEADING section — proof the read wasn't a tail.
        expect(handles.modelGateway.requests.length).toBeGreaterThan(0);
        for (const req of handles.modelGateway.requests) {
          expect(req.user).toContain(marker);
          expect(req.user).not.toContain("decoy tail");
        }
        // >200 changed lines → the size heuristic escalated past "trivial"/"lite".
        const fullAgents = ["release-management", "compliance", "agents-md"];
        const comment = handles.github.pullReviewCalls[0]!.body;
        for (const agent of fullAgents) expect(comment).toContain(agent);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "oxc grounding — prepends oxlint findings to the reviewers' diff",
    () => {
      // The diff touches a lintable file, so the run scans it with oxlint. The
      // sandbox fake doesn't execute the `> file` redirect, so OXLINT_FILE is
      // seeded directly with a findings report — `oxlint-scan` reads it back
      // and prepends a labelled grounding block to every reviewer's message.
      const oxlintReport =
        "src/x.ts:1:7: error eslint(no-unused-vars): 'foo' is declared but never used.";
      const { layer, handles } = makeCFRuntimeTest({
        config: backendConfig,
        sandboxProgram: { "git diff": { exitCode: 0, stdout: "" } },
        sandboxFiles: {
          [DIFF_FILE]:
            "diff --git a/src/x.ts b/src/x.ts\n+++ b/src/x.ts\n+const foo = 1;\n",
          "/tmp/pr-review.oxlint.txt": oxlintReport,
        },
        modelGateway: { responses: Array(7).fill(emptyReport) },
      });

      return Effect.gen(function* () {
        yield* Effect.exit(prReview.run(baseInput));

        // oxlint was invoked on the changed lintable file.
        const oxlintExec = handles.sandbox.execs.find((e) =>
          e.command.includes("oxlint"),
        );
        expect(oxlintExec).toBeDefined();
        expect(oxlintExec?.command).toContain("src/x.ts");

        // Its findings are grounded into every reviewer's user message, ahead
        // of the diff itself (the diff still follows the block).
        expect(handles.modelGateway.requests.length).toBeGreaterThan(0);
        for (const req of handles.modelGateway.requests) {
          expect(req.user).toContain("Static analysis — oxlint findings");
          expect(req.user).toContain("no-unused-vars");
          expect(req.user).toContain("+const foo = 1;");
        }
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("a non-zero git diff exit FAILS the run (honest red check)", () => {
    const { layer, handles } = makeCFRuntimeTest({
      // Backend configured so the run reaches `prepare-diff` (resolve-backend
      // now runs first, fail-fast before paying for a container).
      config: backendConfig,
      sandboxProgram: {
        // git diff exits non-zero — a real failure, not swallowed.
        "git diff": { exitCode: 128, stdout: "", stderr: "fatal: bad object" },
      },
    });

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(prReview.run(baseInput));
      expect(Exit.isFailure(exit)).toBe(true);

      // The run still posted a PR comment explaining the failure.
      expect(handles.github.pullReviewCalls).toHaveLength(1);
      const comment = handles.github.pullReviewCalls[0]!;
      expect(comment.repo).toBe(baseInput.repo);
      expect(comment.pr).toBe(baseInput.pr);
      expect(comment.body).toContain("could not complete");
      expect(comment.body).toContain("<!-- flare-dispatch: pr-review -->");
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "an unconfigured backend fails with a comment naming the missing key",
    () => {
      const { layer, handles } = makeCFRuntimeTest({
        sandboxProgram: { "git diff": { exitCode: 0, stdout: "" } },
        // No `pr-review.*` config keys seeded → resolveBackend fails.
      });

      return Effect.gen(function* () {
        const exit = yield* Effect.exit(prReview.run(baseInput));
        expect(Exit.isFailure(exit)).toBe(true);

        expect(handles.github.pullReviewCalls).toHaveLength(1);
        const body = handles.github.pullReviewCalls[0]!.body;
        expect(body).toContain("misconfigured");
        expect(body).toContain("pr-review.workers-ai.model");
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "the PR comment is anchored to the head sha and carries the installation id",
    () => {
      const { layer, handles } = makeCFRuntimeTest({
        sandboxProgram: { "git diff": { exitCode: 0, stdout: "" } },
      });

      return Effect.gen(function* () {
        yield* Effect.exit(prReview.run(baseInput));
        const comment = handles.github.pullReviewCalls[0]!;
        expect(comment.sha).toBe(baseInput.sha);
        expect(comment.installationId).toBe(baseInput.installationId);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "determinism guard — no Date.now / randomUUID / Math.random in run source",
    () => {
      const src = readFileSync(
        fileURLToPath(new URL("./pr-review.ts", import.meta.url)),
        "utf8",
      );
      expect(src).not.toMatch(/\bDate\.now\(\)/);
      expect(src).not.toMatch(/\bcrypto\.randomUUID\(\)/);
      expect(src).not.toMatch(/\bMath\.random\(\)/);
      return Effect.void;
    },
  );

  // ---- pr-review.style: comment layout preset --------------------------------
  // The default verdict-table is great for transparency but doesn't match
  // teams who already get a "leaderboard-bot" `## ✅ LGTM` + 3-col emoji table
  // from in-house reviewers. `compact` is the parity layout — same content,
  // different rendering — selected via CONFIG_KV without a redeploy.

  it.effect(
    "default style → verdict-table header (`### AI code review — ✅ Approve`)",
    () => {
      const { layer, handles } = makeCFRuntimeTest({
        config: backendConfig,
        sandboxProgram: { "git diff": { exitCode: 0, stdout: "" } },
        sandboxFiles: { [DIFF_FILE]: "diff --git a/x.ts b/x.ts\n+++ b/x.ts\n+x\n" },
        modelGateway: { responses: [emptyReport] },
      });

      return Effect.gen(function* () {
        yield* Effect.exit(prReview.run(baseInput));
        const body = handles.github.pullReviewCalls[0]!.body;
        expect(body).toContain("### AI code review — ✅ Approve");
        expect(body).not.toContain("## ✅ LGTM");
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "compact style + zero findings → `## ✅ LGTM` header (parity with leaderboard bots)",
    () => {
      const { layer, handles } = makeCFRuntimeTest({
        config: { ...backendConfig, "pr-review.style": "compact" },
        sandboxProgram: { "git diff": { exitCode: 0, stdout: "" } },
        sandboxFiles: { [DIFF_FILE]: "diff --git a/x.ts b/x.ts\n+++ b/x.ts\n+x\n" },
        modelGateway: { responses: [emptyReport] },
      });

      return Effect.gen(function* () {
        yield* Effect.exit(prReview.run(baseInput));
        const body = handles.github.pullReviewCalls[0]!.body;
        expect(body).toContain("## ✅ LGTM");
        expect(body).toContain("No issues found.");
        // The compact layout is the leaderboard-bot output: skip the verbose
        // verdict-table header + per-domain reviewer engagement line.
        expect(body).not.toContain("### AI code review");
        expect(body).not.toContain("Reviewers:");
        expect(body).not.toContain("| # |");
        expect(body).toContain("<!-- flare-dispatch: pr-review -->");
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "compact style + findings → 3-col emoji table (`Severity | Location | Issue`)",
    () => {
      const reportWithFindings = {
        toolCalls: [
          {
            name: "report",
            arguments: {
              findings: [
                {
                  path: "src/foo.ts",
                  startLine: 10,
                  endLine: 12,
                  level: "warning",
                  title: "Missing null check",
                  message: "`foo.bar` may be undefined",
                },
              ],
            },
          },
        ],
        text: "",
      } as const;

      const { layer, handles } = makeCFRuntimeTest({
        config: { ...backendConfig, "pr-review.style": "compact" },
        sandboxProgram: { "git diff": { exitCode: 0, stdout: "" } },
        sandboxFiles: { [DIFF_FILE]: "diff --git a/src/foo.ts b/src/foo.ts\n+++ b/src/foo.ts\n+x\n" },
        // One response per domain reviewer the lite tier runs (4 agents).
        modelGateway: { responses: Array(4).fill(reportWithFindings) },
      });

      return Effect.gen(function* () {
        yield* Effect.exit(prReview.run(baseInput));
        const body = handles.github.pullReviewCalls[0]!.body;
        // Verdict header chosen by deduped-findings count > 0 → not approve.
        expect(body).toMatch(/## (⚠️ Minor Issues|🚫 Changes Requested)/);
        expect(body).toContain("| Severity | Location | Issue |");
        // Severity emoji from the compact preset.
        expect(body).toMatch(/\| 🟡 \|/);
        // Location renders as a markdown link to a github blob URL with line.
        expect(body).toContain("src/foo.ts:10-12");
        expect(body).toContain(
          `https://github.com/${baseInput.repo}/blob/${baseInput.sha}/src/foo.ts#L10-L12`,
        );
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "neutralises markdown link/image injection in model-authored finding text",
    () => {
      // A hostile fork PR can steer the model into emitting markdown that, once
      // posted under the App's identity, becomes a disguised phishing link or a
      // zero-click tracking-pixel image. The finding SHAPE is schema-validated,
      // but the free TEXT is not — so `sanitizeModelText` must defuse it.
      const injected = {
        toolCalls: [
          {
            name: "report",
            arguments: {
              findings: [
                {
                  path: "src/foo.ts",
                  startLine: 3,
                  endLine: 3,
                  level: "warning",
                  // Image beacon in the title, disguised link in the message.
                  title: "![](https://evil.tld/pixel.png) heads up",
                  message: "click [here](https://evil.tld) to continue",
                },
              ],
            },
          },
        ],
        text: "",
      } as const;

      const { layer, handles } = makeCFRuntimeTest({
        config: backendConfig,
        sandboxProgram: { "git diff": { exitCode: 0, stdout: "" } },
        sandboxFiles: {
          [DIFF_FILE]:
            "diff --git a/src/foo.ts b/src/foo.ts\n+++ b/src/foo.ts\n+x\n",
        },
        modelGateway: { responses: Array(4).fill(injected) },
      });

      return Effect.gen(function* () {
        yield* Effect.exit(prReview.run(baseInput));
        const body = handles.github.pullReviewCalls[0]!.body;
        // The visible words survive — we defang syntax, not content.
        expect(body).toContain("heads up");
        expect(body).toContain("continue");
        // No image syntax, and no disguised link to the model-supplied host —
        // the run's own trusted links (📍 location, 📋 logs) still use `](`, so
        // we assert against the injected destination specifically.
        expect(body).not.toContain("![");
        expect(body).not.toContain("](https://evil.tld)");
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "compact style + pr-review.compact-max → lists exactly N inline, rest overflow",
    () => {
      // Six distinct findings; cap the compact list at 2 → 2 rows + "…and 4 more".
      const mkFinding = (i: number) => ({
        path: `src/f${i}.ts`,
        startLine: i,
        endLine: i + 1,
        level: "warning" as const,
        title: `Issue ${i}`,
        message: `problem ${i}`,
      });
      const reportSixFindings = {
        toolCalls: [
          {
            name: "report",
            arguments: { findings: [1, 2, 3, 4, 5, 6].map(mkFinding) },
          },
        ],
        text: "",
      } as const;

      const { layer, handles } = makeCFRuntimeTest({
        config: {
          ...backendConfig,
          "pr-review.style": "compact",
          "pr-review.compact-max": "2",
        },
        sandboxProgram: { "git diff": { exitCode: 0, stdout: "" } },
        sandboxFiles: { [DIFF_FILE]: "diff --git a/src/f1.ts b/src/f1.ts\n+++ b/src/f1.ts\n+x\n" },
        modelGateway: { responses: Array(4).fill(reportSixFindings) },
      });

      return Effect.gen(function* () {
        yield* Effect.exit(prReview.run(baseInput));
        const body = handles.github.pullReviewCalls[0]!.body;
        // Exactly the first 2 findings render inline; #3 does not.
        expect(body).toContain("src/f1.ts:1-2");
        expect(body).toContain("src/f2.ts:2-3");
        expect(body).not.toContain("src/f3.ts");
        // Overflow line reflects the configured cap (6 − 2 = 4 more).
        expect(body).toContain("_…and 4 more (see check annotations)._");
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "compact style + non-numeric pr-review.compact-max → falls back to default 7",
    () => {
      const mkFinding = (i: number) => ({
        path: `src/g${i}.ts`,
        startLine: i,
        endLine: i + 1,
        level: "warning" as const,
        title: `Issue ${i}`,
        message: `problem ${i}`,
      });
      // Eight findings, garbage cap → default 7 inline, 1 overflow.
      const reportEight = {
        toolCalls: [
          {
            name: "report",
            arguments: { findings: [1, 2, 3, 4, 5, 6, 7, 8].map(mkFinding) },
          },
        ],
        text: "",
      } as const;

      const { layer, handles } = makeCFRuntimeTest({
        config: {
          ...backendConfig,
          "pr-review.style": "compact",
          "pr-review.compact-max": "not-a-number",
        },
        sandboxProgram: { "git diff": { exitCode: 0, stdout: "" } },
        sandboxFiles: { [DIFF_FILE]: "diff --git a/src/g1.ts b/src/g1.ts\n+++ b/src/g1.ts\n+x\n" },
        modelGateway: { responses: Array(4).fill(reportEight) },
      });

      return Effect.gen(function* () {
        yield* Effect.exit(prReview.run(baseInput));
        const body = handles.github.pullReviewCalls[0]!.body;
        // Default cap of 7 → the 8th finding overflows.
        expect(body).toContain("src/g7.ts:7-8");
        expect(body).not.toContain("src/g8.ts");
        expect(body).toContain("_…and 1 more (see check annotations)._");
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "unknown style value → falls back to default (forward-compat)",
    () => {
      const { layer, handles } = makeCFRuntimeTest({
        config: { ...backendConfig, "pr-review.style": "future-format" },
        sandboxProgram: { "git diff": { exitCode: 0, stdout: "" } },
        sandboxFiles: { [DIFF_FILE]: "diff --git a/x.ts b/x.ts\n+++ b/x.ts\n+x\n" },
        modelGateway: { responses: [emptyReport] },
      });

      return Effect.gen(function* () {
        yield* Effect.exit(prReview.run(baseInput));
        const body = handles.github.pullReviewCalls[0]!.body;
        // Unknown style → silently parse as default; never fails the review.
        expect(body).toContain("### AI code review");
      }).pipe(Effect.provide(layer));
    },
  );

  // ---- log-viewer link: PR comment deep-links to full logs + reviewed diff ---
  // #137 surfaced a run's produced artifacts (incl. `pr-review.diff`) in the log
  // viewer; this links the PR comment back to it. The URL comes from
  // `io.viewerUrl` (dispatcher-minted, tokened) — `none` on a deploy with no
  // public origin / log-link key, in which case the comment renders link-less.

  const VIEWER_URL = "https://fd.example/logs/exec-1?t=tok";

  it.effect(
    "viewerUrl present → comment footers a `View full logs & reviewed diff` link",
    () => {
      const { layer, handles } = makeCFRuntimeTest({
        config: backendConfig,
        io: { viewerUrl: VIEWER_URL },
        sandboxProgram: { "git diff": { exitCode: 0, stdout: "" } },
        sandboxFiles: { [DIFF_FILE]: "diff --git a/x.ts b/x.ts\n+++ b/x.ts\n+x\n" },
        modelGateway: { responses: [emptyReport] },
      });

      return Effect.gen(function* () {
        yield* Effect.exit(prReview.run(baseInput));
        const body = handles.github.pullReviewCalls[0]!.body;
        expect(body).toContain(
          `📋 [View full logs & reviewed diff ↗](${VIEWER_URL})`,
        );
        // Footer sits above the idempotency marker, not after it.
        expect(body.indexOf(VIEWER_URL)).toBeLessThan(
          body.indexOf("<!-- flare-dispatch: pr-review -->"),
        );
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "viewerUrl absent → comment renders link-less (historical form)",
    () => {
      const { layer, handles } = makeCFRuntimeTest({
        config: backendConfig,
        sandboxProgram: { "git diff": { exitCode: 0, stdout: "" } },
        sandboxFiles: { [DIFF_FILE]: "diff --git a/x.ts b/x.ts\n+++ b/x.ts\n+x\n" },
        modelGateway: { responses: [emptyReport] },
      });

      return Effect.gen(function* () {
        yield* Effect.exit(prReview.run(baseInput));
        const body = handles.github.pullReviewCalls[0]!.body;
        expect(body).not.toContain("View full logs");
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "viewerUrl present → failure comment also links back to the logs",
    () => {
      // No backend config → `resolve-backend` fails fast, exercising the error
      // boundary's failure-comment path.
      const { layer, handles } = makeCFRuntimeTest({
        io: { viewerUrl: VIEWER_URL },
        sandboxProgram: { "git diff": { exitCode: 0, stdout: "" } },
        sandboxFiles: { [DIFF_FILE]: "diff --git a/x.ts b/x.ts\n+++ b/x.ts\n+x\n" },
        modelGateway: { responses: [emptyReport] },
      });

      return Effect.gen(function* () {
        yield* Effect.exit(prReview.run(baseInput));
        const comment = handles.github.pullReviewCalls[0]!;
        expect(comment.body).toContain("could not complete");
        expect(comment.body).toContain(
          `📋 [View full logs & reviewed diff ↗](${VIEWER_URL})`,
        );
      }).pipe(Effect.provide(layer));
    },
  );

  // ---- fault-isolated fan-out: one bad reviewer must not sink the review -----
  // The whole point of the multi-agent fan-out is resilience. A single domain
  // whose model call returns unparseable output (the live `StructuredOutputInvalid:
  // empty` failure) or a transient gateway error is dropped to zero findings and
  // flagged in the engagement line — the review still ships with the domains that
  // succeeded. Only when EVERY reviewer fails does the run go red.

  // A diff big enough to classify `lite` (4 domain reviewers) on a NON-lintable
  // path, so `oxlint-scan` short-circuits (no exec/read) and the model fan-out
  // is the only model path under test.
  const liteDiff = [
    "diff --git a/notes/feature.txt b/notes/feature.txt",
    "+++ b/notes/feature.txt",
    ...Array.from({ length: 60 }, (_, i) => `+line ${i}`),
  ].join("\n");

  it.effect(
    "one reviewer's unparseable output is tolerated — the review still completes",
    () => {
      // json mode so each domain makes exactly one model call. The first response
      // is a schema-mismatch (valid JSON, bad `level`) → that ONE domain fails;
      // the other three return an empty findings object and succeed. Whichever
      // domain grabs the bad response, exactly one errors and the review ships.
      const schemaMismatch = {
        toolCalls: [],
        text: '{"findings":[{"path":"a","startLine":1,"endLine":1,"level":"oops","title":"t","message":"m"}]}',
      } as const;
      const emptyJsonReport = { toolCalls: [], text: '{"findings":[]}' } as const;

      const { layer, handles } = makeCFRuntimeTest({
        config: { ...backendConfig, "pr-review.workers-ai.mode": "json" },
        sandboxProgram: { "git diff": { exitCode: 0, stdout: "" } },
        sandboxFiles: { [DIFF_FILE]: liteDiff },
        modelGateway: {
          responses: [
            schemaMismatch,
            emptyJsonReport,
            emptyJsonReport,
            emptyJsonReport,
          ],
        },
      });

      return Effect.gen(function* () {
        yield* Effect.exit(prReview.run(baseInput));

        // The review COMPLETED — a normal comment, not a "could not complete".
        const body = handles.github.pullReviewCalls[0]!.body;
        expect(body).toContain("### AI code review");
        expect(body).not.toContain("could not complete");
        // Exactly one domain errored — its engagement entry shows `⚠️`.
        expect(body).toMatch(/Reviewers:.*⚠️/);
        // Four domains, one model call each (no schema-mismatch repair retry).
        expect(handles.modelGateway.requests).toHaveLength(4);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "EVERY reviewer failing → the run goes red with an honest 'could not complete'",
    () => {
      // A gateway auth failure on every call → every domain reviewer fails the
      // same way. With nothing to salvage, the run re-raises the cause so the
      // boundary posts a precise failure comment (not a misleading empty review).
      const { layer, handles } = makeCFRuntimeTest({
        config: backendConfig,
        sandboxProgram: { "git diff": { exitCode: 0, stdout: "" } },
        sandboxFiles: { [DIFF_FILE]: liteDiff },
        modelGateway: {
          responses: [
            new ModelGatewayError({
              model: "@cf/test/model",
              reason: "auth-failed",
              message: "Workers AI run failed: 401 unauthorized",
            }),
          ],
        },
      });

      return Effect.gen(function* () {
        const exit = yield* Effect.exit(prReview.run(baseInput));
        expect(Exit.isFailure(exit)).toBe(true);

        const comment = handles.github.pullReviewCalls[0]!;
        expect(comment.body).toContain("could not complete");
        // The re-raised typed cause is named precisely in the comment.
        expect(comment.body).toContain("model call failed (auth-failed)");
      }).pipe(Effect.provide(layer));
    },
  );

  // ---- pr-review.agents: single vs multi-agent fan-out -----------------------
  // The collapsed `multi-agent-review` run lives on as `agents: "single"` — one
  // generalist reviewer through the same structured engine. `multi` (default)
  // is the tier-scaled per-domain persona fan-out.

  // A diff big enough to classify `full` (7 personas under multi) — proves the
  // single-mode collapse is the agent COUNT, not a side effect of a small diff.
  const bigFullDiff = [
    "diff --git a/big.ts b/big.ts",
    "+++ b/big.ts",
    ...Array.from({ length: 300 }, (_, i) => `+const pad${i} = ${i};`),
  ].join("\n");

  it.effect(
    "agents:\"single\" input → ONE generalist reviewer (overrides CONFIG_KV multi + full tier)",
    () => {
      const { layer, handles } = makeCFRuntimeTest({
        // CONFIG_KV says multi; the per-dispatch input must still win.
        config: { ...backendConfig, "pr-review.agents": "multi" },
        sandboxProgram: { "git diff": { exitCode: 0, stdout: "" } },
        sandboxFiles: { [DIFF_FILE]: bigFullDiff },
        modelGateway: { responses: Array(7).fill(emptyReport) },
      });

      return Effect.gen(function* () {
        yield* Effect.exit(prReview.run({ ...baseInput, agents: "single" }));
        // Exactly one model call despite the full-tier diff + CONFIG_KV multi.
        expect(handles.modelGateway.requests).toHaveLength(1);
        expect(handles.modelGateway.requests[0]!.user).toContain(
          "Review domain: general",
        );
        // The engagement line names the lone generalist reviewer.
        expect(handles.github.pullReviewCalls[0]!.body).toContain("general");
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("pr-review.agents=single (CONFIG_KV) → one generalist reviewer", () => {
    const { layer, handles } = makeCFRuntimeTest({
      config: { ...backendConfig, "pr-review.agents": "single" },
      sandboxProgram: { "git diff": { exitCode: 0, stdout: "" } },
      sandboxFiles: { [DIFF_FILE]: bigFullDiff },
      modelGateway: { responses: Array(7).fill(emptyReport) },
    });

    return Effect.gen(function* () {
      yield* Effect.exit(prReview.run(baseInput));
      expect(handles.modelGateway.requests).toHaveLength(1);
      expect(handles.modelGateway.requests[0]!.user).toContain(
        "Review domain: general",
      );
    }).pipe(Effect.provide(layer));
  });

  // ---- per-dispatch overrides (the former multi-agent-review use cases) ------

  it.effect("modelId input overrides the resolved backend's model", () => {
    const { layer, handles } = makeCFRuntimeTest({
      config: backendConfig, // workers-ai.model = "@cf/test/model"
      sandboxProgram: { "git diff": { exitCode: 0, stdout: "" } },
      sandboxFiles: { [DIFF_FILE]: "diff --git a/x.ts b/x.ts\n+++ b/x.ts\n+x\n" },
      modelGateway: { responses: Array(7).fill(emptyReport) },
    });

    return Effect.gen(function* () {
      yield* Effect.exit(
        prReview.run({ ...baseInput, agents: "single", modelId: "@cf/bake-off/candidate" }),
      );
      // The bake-off model id rode the dispatch input, not CONFIG_KV.
      expect(handles.modelGateway.requests[0]!.model).toBe("@cf/bake-off/candidate");
    }).pipe(Effect.provide(layer));
  });

  it.effect("backend input overrides the CONFIG_KV backend selection", () => {
    const { layer, handles } = makeCFRuntimeTest({
      // Default backend is workers-ai; seed an anthropic model too so the
      // override resolves. The input must select anthropic.
      config: {
        ...backendConfig,
        "pr-review.anthropic.model": "anthropic/claude-sonnet-4-6",
      },
      sandboxProgram: { "git diff": { exitCode: 0, stdout: "" } },
      sandboxFiles: { [DIFF_FILE]: "diff --git a/x.ts b/x.ts\n+++ b/x.ts\n+x\n" },
      modelGateway: { responses: Array(7).fill(emptyReport) },
    });

    return Effect.gen(function* () {
      yield* Effect.exit(
        prReview.run({ ...baseInput, agents: "single", backend: "anthropic" }),
      );
      expect(handles.modelGateway.requests[0]!.model).toBe(
        "anthropic/claude-sonnet-4-6",
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("focusArea input is appended to the reviewer system prompt", () => {
    const { layer, handles } = makeCFRuntimeTest({
      config: backendConfig,
      sandboxProgram: { "git diff": { exitCode: 0, stdout: "" } },
      sandboxFiles: { [DIFF_FILE]: "diff --git a/x.ts b/x.ts\n+++ b/x.ts\n+x\n" },
      modelGateway: { responses: Array(7).fill(emptyReport) },
    });

    return Effect.gen(function* () {
      yield* Effect.exit(
        prReview.run({
          ...baseInput,
          agents: "single",
          focusArea: "concurrency safety",
        }),
      );
      expect(handles.modelGateway.requests[0]!.system).toContain(
        "Extra focus for this review: concurrency safety",
      );
    }).pipe(Effect.provide(layer));
  });
});
