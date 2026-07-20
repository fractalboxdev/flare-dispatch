// Engine unit tests.
//
//   * `reviewDomain` calls the model — the `modelGateway` capability is replaced
//     by the core `ModelGatewayFake`, scripted with canned `{ toolCalls, text }`
//     results (and `ModelGatewayError` for the failure path), so these run with
//     no provider configured.
//   * `coordinate` / `riskTier` are PURE — tested directly, no fake.

import { describe, expect, it } from "vitest";
import { Cause, Effect, Exit, Layer, Option, Schema } from "effect";
import {
  ModelGateway,
  ModelGatewayError,
  type ModelCompletionResult,
} from "@fractalboxdev/flare-dispatch-core";
import { makeModelGatewayFake } from "@fractalboxdev/flare-dispatch-core/testing";
import {
  classifyRisk,
  completeStructured,
  composeSystemPrompt,
  coordinate,
  coordinateReview,
  REVIEW_SYSTEM_PROMPT_DEFAULT,
  reviewDomain,
  riskTier,
} from "./engine.js";
import type { Finding } from "./schemas.js";

// --- ModelGateway result fixtures -------------------------------------------

/** A tools-mode result: one tool call whose `arguments` is a parsed OBJECT
 *  (the Workers AI shape). */
const toolsResult = (name: string, args: unknown): ModelCompletionResult => ({
  toolCalls: [{ name, arguments: args }],
  text: "",
});

/** A tools-mode result whose `arguments` is a JSON STRING (the OpenAI shape). */
const toolsResultString = (
  name: string,
  args: unknown,
): ModelCompletionResult => ({
  toolCalls: [{ name, arguments: JSON.stringify(args) }],
  text: "",
});

/** An empty-tool-calls result (the DeepSeek-via-AI-Gateway pathology). */
const emptyToolsResult = (text = ""): ModelCompletionResult => ({
  toolCalls: [],
  text,
});

/** A json-mode result: free-form `text` (may contain <think>). */
const textResult = (text: string): ModelCompletionResult => ({
  toolCalls: [],
  text,
});

/** Provide a ModelGateway fake scripted with the given responses. */
const withGateway = (
  responses: ReadonlyArray<ModelCompletionResult | ModelGatewayError>,
): { layer: Layer.Layer<ModelGateway>; calls: () => number } => {
  const fake = makeModelGatewayFake({ responses });
  return { layer: fake.layer, calls: () => fake.state.requests.length };
};

/** Common backend coordinates every call needs. */
const conn = { model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" } as const;

describe("composeSystemPrompt (pure — prompt layering)", () => {
  it("returns the trimmed base alone when no guidelines/focus", () => {
    expect(composeSystemPrompt({ base: "  base instruction  " })).toBe(
      "base instruction",
    );
  });

  it("appends guidelines as an authoritative block, layered on the base", () => {
    const out = composeSystemPrompt({
      base: REVIEW_SYSTEM_PROMPT_DEFAULT,
      guidelines: "Do not flag style nits already enforced by the linter.",
    });
    // The base is preserved (additive, not a replacement)...
    expect(out.startsWith(REVIEW_SYSTEM_PROMPT_DEFAULT)).toBe(true);
    // ...and the guidelines are appended under an authoritative label.
    expect(out).toContain("authoritative house rules");
    expect(out).toContain(
      "Do not flag style nits already enforced by the linter.",
    );
  });

  it("orders base → guidelines → focus", () => {
    const out = composeSystemPrompt({
      base: "BASE",
      guidelines: "GUIDE",
      focus: "FOCUS",
    });
    expect(out.indexOf("BASE")).toBeLessThan(out.indexOf("GUIDE"));
    expect(out.indexOf("GUIDE")).toBeLessThan(out.indexOf("FOCUS"));
    expect(out).toContain("Extra focus for this review: FOCUS");
  });

  it("drops whitespace-only layers", () => {
    expect(
      composeSystemPrompt({ base: "BASE", guidelines: "   ", focus: "" }),
    ).toBe("BASE");
  });
});

describe("riskTier / classifyRisk", () => {
  it("an empty diff is trivial", () => {
    expect(classifyRisk("")).toBe("trivial");
  });

  it("a tiny diff is trivial", () => {
    const diff = [
      "diff --git a/src/util.ts b/src/util.ts",
      "--- a/src/util.ts",
      "+++ b/src/util.ts",
      "@@ -1,1 +1,1 @@",
      "-const a = 1;",
      "+const a = 2;",
    ].join("\n");
    expect(classifyRisk(diff)).toBe("trivial");
  });

  it("a medium diff is lite", () => {
    const body = Array.from({ length: 60 }, (_, i) => `+line ${i}`).join("\n");
    const diff = [
      "diff --git a/src/big.ts b/src/big.ts",
      "--- a/src/big.ts",
      "+++ b/src/big.ts",
      "@@ -1,1 +1,60 @@",
      body,
    ].join("\n");
    expect(classifyRisk(diff)).toBe("lite");
  });

  it("a large diff is full", () => {
    const body = Array.from({ length: 250 }, (_, i) => `+line ${i}`).join("\n");
    const diff = [
      "diff --git a/src/huge.ts b/src/huge.ts",
      "--- a/src/huge.ts",
      "+++ b/src/huge.ts",
      "@@ @@",
      body,
    ].join("\n");
    expect(classifyRisk(diff)).toBe("full");
  });

  it("a sensitive path escalates a one-line change to full", () => {
    const diff = [
      "diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml",
      "--- a/.github/workflows/ci.yml",
      "+++ b/.github/workflows/ci.yml",
      "@@ -1,1 +1,1 @@",
      "-runs-on: ubuntu-22.04",
      "+runs-on: ubuntu-24.04",
    ].join("\n");
    expect(classifyRisk(diff)).toBe("full");
  });

  it("riskTier is the Effect wrapper of classifyRisk", async () => {
    const tier = await Effect.runPromise(riskTier({ diff: "" }));
    expect(tier).toBe("trivial");
  });
});

describe("reviewDomain", () => {
  const finding: Finding = {
    path: "src/a.ts",
    startLine: 3,
    endLine: 5,
    level: "warning",
    title: "unchecked input",
    message: "validate before use",
  };

  it("tools mode — returns findings from the `report` tool call (object args)", async () => {
    const { layer } = withGateway([
      toolsResult("report", { findings: [finding] }),
    ]);
    const result = await Effect.runPromise(
      reviewDomain({
        ...conn,
        agent: "security",
        diff: "diff --git a/src/a.ts b/src/a.ts",
        tier: "full",
        backend: "workers-ai",
        mode: "tools",
      }).pipe(Effect.provide(layer)),
    );
    expect(result).toEqual([finding]);
  });

  it("tools mode — also accepts a JSON-STRING `arguments` (OpenAI shape)", async () => {
    const { layer } = withGateway([
      toolsResultString("report", { findings: [finding] }),
    ]);
    const result = await Effect.runPromise(
      reviewDomain({
        ...conn,
        agent: "security",
        diff: "x",
        tier: "full",
        backend: "workers-ai",
        mode: "tools",
      }).pipe(Effect.provide(layer)),
    );
    expect(result).toEqual([finding]);
  });

  it("tools mode — coerces a double-encoded `findings` (JSON STRING) back to an array", async () => {
    // Workers AI tool-calling sometimes double-encodes the nested array: the
    // tool `arguments` object carries `findings` as a JSON string ("[{…}]")
    // rather than an array. The engine parses it before Schema-decode.
    const { layer } = withGateway([
      toolsResult("report", { findings: JSON.stringify([finding]) }),
    ]);
    const result = await Effect.runPromise(
      reviewDomain({
        ...conn,
        agent: "security",
        diff: "x",
        tier: "full",
        backend: "workers-ai",
        mode: "tools",
      }).pipe(Effect.provide(layer)),
    );
    expect(result).toEqual([finding]);
  });

  it("json mode — coerces a double-encoded `findings` (JSON STRING) back to an array", async () => {
    // Same pathology over the json-text path: a valid outer object whose
    // `findings` value is itself a JSON string.
    const { layer } = withGateway([
      textResult(JSON.stringify({ findings: JSON.stringify([finding]) })),
    ]);
    const result = await Effect.runPromise(
      reviewDomain({
        ...conn,
        agent: "security",
        diff: "x",
        tier: "lite",
        model: "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
        backend: "workers-ai",
        mode: "json",
      }).pipe(Effect.provide(layer)),
    );
    expect(result).toEqual([finding]);
  });

  it("json mode — parses a <think>-wrapped, code-fenced JSON response", async () => {
    const text = [
      "<think>",
      "The diff adds an unchecked input, I should flag it as a warning.",
      "</think>",
      "```json",
      JSON.stringify({ findings: [finding] }),
      "```",
    ].join("\n");

    const { layer } = withGateway([textResult(text)]);
    const result = await Effect.runPromise(
      reviewDomain({
        ...conn,
        agent: "security",
        diff: "x",
        tier: "lite",
        model: "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
        backend: "workers-ai",
        mode: "json",
      }).pipe(Effect.provide(layer)),
    );
    expect(result).toEqual([finding]);
  });

  it("json mode — accepts a bare JSON object with no fences", async () => {
    const { layer } = withGateway([textResult('{"findings":[]}')]);
    const result = await Effect.runPromise(
      reviewDomain({
        ...conn,
        agent: "security",
        diff: "x",
        tier: "trivial",
        model: "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
        backend: "workers-ai",
        mode: "json",
      }).pipe(Effect.provide(layer)),
    );
    expect(result).toEqual([]);
  });

  it("json mode — skips earlier reasoning fragments and decodes the real answer last", async () => {
    // A reasoning model writes an unrelated example object + quotes code while
    // thinking, THEN emits the real findings object last. The engine must skip
    // the schema-mismatching / non-JSON candidates and decode the last valid one
    // (the GLM-5.2 / Kimi-k2.7 failure mode that the old first-brace extractor hit).
    const text = [
      'I might shape it as { "severity": "high" }.',
      "```rust",
      "let cfg = Config { retries: 3 };",
      "```",
      JSON.stringify({ findings: [finding] }),
    ].join("\n");
    const { layer } = withGateway([textResult(text)]);
    const result = await Effect.runPromise(
      reviewDomain({
        ...conn,
        agent: "security",
        diff: "x",
        tier: "lite",
        model: "@cf/zai-org/glm-5.2",
        backend: "workers-ai",
        mode: "json",
      }).pipe(Effect.provide(layer)),
    );
    expect(result).toEqual([finding]);
  });

  it("json mode — fails StructuredOutputInvalid on schema mismatch", async () => {
    const { layer } = withGateway([
      // `level` is not in the allowed set → schema mismatch after parse.
      textResult(
        '{"findings":[{"path":"a","startLine":1,"endLine":1,"level":"oops","title":"t","message":"m"}]}',
      ),
    ]);
    const exit = await Effect.runPromiseExit(
      reviewDomain({
        ...conn,
        agent: "security",
        diff: "x",
        tier: "lite",
        model: "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
        backend: "workers-ai",
        mode: "json",
      }).pipe(Effect.provide(layer)),
    );
    expect(exit._tag).toBe("Failure");
  });

  it("json mode — fails StructuredOutputInvalid (not throw) on a non-string `text`", async () => {
    // Some ModelGateway adapters deliver `text === undefined` (or an array of
    // content blocks) when the provider produced tool calls without a free-form
    // text body. Without an entry guard, `extractJsonText(undefined)` throws
    // `TypeError: text.replace is not a function` — bypasses the run's error
    // boundary and surfaces as a raw stack trace in the failure-comment.
    const { layer } = withGateway([
      // `text: undefined` simulates the adapter dropping the field; the engine
      // must coerce this into a structured failure instead of throwing.
      { toolCalls: [], text: undefined as unknown as string },
    ]);
    const exit = await Effect.runPromiseExit(
      reviewDomain({
        ...conn,
        agent: "security",
        diff: "x",
        tier: "lite",
        model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
        backend: "workers-ai",
        mode: "json",
      }).pipe(Effect.provide(layer)),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      const cause = exit.cause.toString();
      // The cause names the structured-output failure family — proves we hit
      // the engine's error path, not a generic TypeError.
      expect(cause).toContain("StructuredOutputInvalid");
      expect(cause).not.toMatch(/TypeError/);
    }
  });

  it("tools mode — auto-falls-back to json when tool_calls come back empty", async () => {
    // First call (tools) → empty tool_calls (DeepSeek pathology); the engine
    // retries once in json mode, which returns parseable <think>-wrapped text.
    const { layer, calls } = withGateway([
      emptyToolsResult("<think>I won't use tools</think>"),
      textResult(JSON.stringify({ findings: [finding] })),
    ]);
    const result = await Effect.runPromise(
      reviewDomain({
        ...conn,
        agent: "security",
        diff: "x",
        tier: "lite",
        model: "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
        backend: "workers-ai",
        mode: "tools",
      }).pipe(Effect.provide(layer)),
    );
    expect(result).toEqual([finding]);
    expect(calls()).toBe(2); // tools attempt + json fallback
  });

  it("json mode — repairs once with a blunt correction when the first response has no JSON", async () => {
    // A model in json mode answers in prose (no JSON) on the first call. The
    // engine re-asks ONCE with a repair instruction; the retry returns valid
    // JSON, so the reviewer still produces findings instead of failing the whole
    // review with `StructuredOutputInvalid: empty`.
    const fake = makeModelGatewayFake({
      responses: [
        textResult("I reviewed the diff and everything looks fine to me."),
        textResult(JSON.stringify({ findings: [finding] })),
      ],
    });
    const result = await Effect.runPromise(
      reviewDomain({
        ...conn,
        agent: "security",
        diff: "x",
        tier: "lite",
        model: "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
        backend: "workers-ai",
        mode: "json",
      }).pipe(Effect.provide(fake.layer)),
    );
    expect(result).toEqual([finding]);
    // Exactly two calls: the first (no JSON) + one repair retry.
    expect(fake.state.requests).toHaveLength(2);
    // The repair call carries the blunt "ONLY the JSON object" correction.
    expect(fake.state.requests[1]!.user).toContain(
      "did not contain a valid JSON object",
    );
  });

  it("json mode — gives up after a SINGLE repair retry (no loop)", async () => {
    // Both the first call and its repair return prose (the fake repeats its last
    // response) → the engine fails after exactly two calls, never looping.
    const fake = makeModelGatewayFake({
      responses: [textResult("still just prose, no json here")],
    });
    const exit = await Effect.runPromiseExit(
      reviewDomain({
        ...conn,
        agent: "security",
        diff: "x",
        tier: "lite",
        model: "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
        backend: "workers-ai",
        mode: "json",
      }).pipe(Effect.provide(fake.layer)),
    );
    expect(exit._tag).toBe("Failure");
    expect(fake.state.requests).toHaveLength(2);
  });

  it("json mode — does NOT repair a schema-mismatch (the model emitted JSON, just the wrong shape)", async () => {
    // A valid JSON object with a bad `level` → schema-mismatch. A blind repair
    // retry won't fix structure, so the engine fails on the first call (no retry).
    const fake = makeModelGatewayFake({
      responses: [
        textResult(
          '{"findings":[{"path":"a","startLine":1,"endLine":1,"level":"oops","title":"t","message":"m"}]}',
        ),
      ],
    });
    const exit = await Effect.runPromiseExit(
      reviewDomain({
        ...conn,
        agent: "security",
        diff: "x",
        tier: "lite",
        model: "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
        backend: "workers-ai",
        mode: "json",
      }).pipe(Effect.provide(fake.layer)),
    );
    expect(exit._tag).toBe("Failure");
    expect(fake.state.requests).toHaveLength(1);
  });

  it("tools mode — empty tool calls, then a no-JSON fallback, gets one repair", async () => {
    // The full chain: tools attempt returns no tool call → json fallback returns
    // prose → ONE repair retry returns valid JSON. Proves the repair composes
    // with the tools→json auto-fallback, bounded to three calls total.
    const fake = makeModelGatewayFake({
      responses: [
        emptyToolsResult("<think>I won't use tools</think>"),
        textResult("here is my prose review, no json"),
        textResult(JSON.stringify({ findings: [finding] })),
      ],
    });
    const result = await Effect.runPromise(
      reviewDomain({
        ...conn,
        agent: "security",
        diff: "x",
        tier: "lite",
        model: "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
        backend: "workers-ai",
        mode: "tools",
      }).pipe(Effect.provide(fake.layer)),
    );
    expect(result).toEqual([finding]);
    expect(fake.state.requests).toHaveLength(3);
  });

  it("fails ModelCallFailed on a gateway error", async () => {
    const { layer } = withGateway([
      new ModelGatewayError({
        model: conn.model,
        reason: "bad-response",
        message: "Workers AI run failed: boom",
      }),
    ]);
    const exit = await Effect.runPromiseExit(
      reviewDomain({
        ...conn,
        agent: "security",
        diff: "x",
        tier: "lite",
        model: "m",
        backend: "workers-ai",
        mode: "json",
      }).pipe(Effect.provide(layer)),
    );
    expect(exit._tag).toBe("Failure");
  });

  // --- context-overflow shrink-retries (issue #21) ---------------------------
  //
  // The char-based diff caps are hand-tuned approximations of token windows, so
  // a first call can overflow the model's context (Workers AI error 5021). The
  // reviewer halves the diff (visibly, via `capDiff`) and retries — up to two
  // shrinks — before the failure propagates to the run's skip-soft boundary.

  const overflowError = new ModelGatewayError({
    model: conn.model,
    reason: "context-overflow",
    message:
      "Workers AI run failed: 5021: The estimated number of input and maximum output tokens (24549) exceeded this model context window limit (24000)",
  });

  /** A diff large enough that two halvings stay above the shrink floor. */
  const bigDiff = `diff --git a/src/a.ts b/src/a.ts\n${"+const x = 1;\n".repeat(800)}`;

  it("context-overflow — retries with a halved, visibly-truncated diff and succeeds", async () => {
    const fake = makeModelGatewayFake({
      responses: [overflowError, toolsResult("report", { findings: [finding] })],
    });
    const result = await Effect.runPromise(
      reviewDomain({
        ...conn,
        agent: "security",
        diff: bigDiff,
        tier: "full",
        backend: "workers-ai",
        mode: "tools",
      }).pipe(Effect.provide(fake.layer)),
    );
    expect(result).toEqual([finding]);
    expect(fake.state.requests).toHaveLength(2);
    // The retry carries roughly half the diff, cut with the visible marker so
    // the review says it covered a prefix — never an invisible clip.
    const first = fake.state.requests[0]!.user;
    const second = fake.state.requests[1]!.user;
    expect(second.length).toBeLessThan(first.length);
    expect(second).toContain("diff truncated at");
  });

  it("context-overflow — gives up after two shrinks (three calls), keeping the typed reason", async () => {
    // The fake repeats its last response, so every attempt overflows.
    const fake = makeModelGatewayFake({ responses: [overflowError] });
    const exit = await Effect.runPromiseExit(
      reviewDomain({
        ...conn,
        agent: "security",
        diff: bigDiff,
        tier: "full",
        backend: "workers-ai",
        mode: "tools",
      }).pipe(Effect.provide(fake.layer)),
    );
    expect(fake.state.requests).toHaveLength(3);
    const failure = Exit.match(exit, {
      onSuccess: () => undefined,
      onFailure: (cause) => Option.getOrUndefined(Cause.failureOption(cause)),
    });
    expect(failure?.reason).toBe("context-overflow");
  });

  it("context-overflow on an already-tiny diff fails without a shrink loop", async () => {
    // Below the shrink floor there is nothing meaningful left to halve — the
    // overflow is systemic (tiny-context model / oversized prompt), so exactly
    // one call is made and the failure propagates.
    const fake = makeModelGatewayFake({ responses: [overflowError] });
    const exit = await Effect.runPromiseExit(
      reviewDomain({
        ...conn,
        agent: "security",
        diff: "x",
        tier: "lite",
        backend: "workers-ai",
        mode: "tools",
      }).pipe(Effect.provide(fake.layer)),
    );
    expect(fake.state.requests).toHaveLength(1);
    const failure = Exit.match(exit, {
      onSuccess: () => undefined,
      onFailure: (cause) => Option.getOrUndefined(Cause.failureOption(cause)),
    });
    expect(failure?.reason).toBe("context-overflow");
  });
});

describe("completeStructured (the reusable structured-output engine)", () => {
  // A recipe-shaped schema unrelated to review findings — proves the engine is
  // generic, not hard-wired to `{ findings }`.
  const Triage = Schema.Struct({
    summary: Schema.String,
    severity: Schema.Literal("low", "high"),
  });

  const input = {
    backend: "workers-ai",
    model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    system: "triage",
    renderUser: (mode: "tools" | "json") => `mode=${mode}`,
    schema: Triage,
    toolName: "triage",
    surface: "ci-triage",
  } as const;

  it("tools mode — decodes the tool call against a caller schema", async () => {
    const value = { summary: "flaky test", severity: "high" as const };
    const { layer } = withGateway([toolsResult("triage", value)]);
    const out = await Effect.runPromise(
      completeStructured({ ...input, mode: "tools" }).pipe(Effect.provide(layer)),
    );
    expect(out).toEqual(value);
  });

  it("json mode — parses a strict JSON object from the model text", async () => {
    const value = { summary: "deploy failed", severity: "low" as const };
    const { layer } = withGateway([textResult(JSON.stringify(value))]);
    const out = await Effect.runPromise(
      completeStructured({ ...input, mode: "json" }).pipe(Effect.provide(layer)),
    );
    expect(out).toEqual(value);
  });

  it("json mode — the repair retry gets budget headroom so the answer can't truncate", async () => {
    // A tight operator budget (512) that forced prose / truncation on the first
    // call. The repair tells the model to skip the <think> block AND floors the
    // budget at the default ceiling, so the full JSON answer fits on the retry.
    const value = { summary: "ok", severity: "low" as const };
    const fake = makeModelGatewayFake({
      responses: [
        textResult("I think it's fine but let me explain at length in prose…"),
        textResult(JSON.stringify(value)),
      ],
    });
    const out = await Effect.runPromise(
      completeStructured({ ...input, mode: "json", maxTokens: 512 }).pipe(
        Effect.provide(fake.layer),
      ),
    );
    expect(out).toEqual(value);
    expect(fake.state.requests).toHaveLength(2);
    // First attempt honoured the tight operator budget…
    expect(fake.state.requests[0]!.maxTokens).toBe(512);
    // …the repair was floored to the default ceiling (REVIEW_MAX_TOKENS) so the
    // structured answer has room to fit.
    expect(fake.state.requests[1]!.maxTokens).toBe(8192);
  });

  it("tools mode — renders a DIFFERENT user message on the json auto-fallback", async () => {
    const value = { summary: "x", severity: "low" as const };
    const fake = makeModelGatewayFake({
      responses: [emptyToolsResult(), textResult(JSON.stringify(value))],
    });
    const out = await Effect.runPromise(
      completeStructured({ ...input, mode: "tools" }).pipe(
        Effect.provide(fake.layer),
      ),
    );
    expect(out).toEqual(value);
    expect(fake.state.requests).toHaveLength(2);
    // The tools attempt and the json fallback used the per-mode renderer.
    expect(fake.state.requests[0]!.user).toBe("mode=tools");
    expect(fake.state.requests[1]!.user).toBe("mode=json");
  });
});

describe("coordinate / coordinateReview (pure — no model call)", () => {
  const mk = (
    over: Partial<Finding> & Pick<Finding, "path" | "startLine" | "title" | "level">,
  ): Finding => ({
    endLine: over.startLine,
    message: "m",
    ...over,
  });

  it("counts by level and approves a clean (notice-only) review", () => {
    const r = coordinateReview({
      findings: [
        mk({ path: "a.ts", startLine: 1, title: "style", level: "notice" }),
        mk({ path: "a.ts", startLine: 2, title: "naming", level: "notice" }),
      ],
    });
    expect(r.critical).toBe(0);
    expect(r.warnings).toBe(0);
    expect(r.suggestions).toBe(2);
    expect(r.verdict).toBe("approve");
    expect(r.findings).toHaveLength(2);
  });

  it("a warning (no failures) → comment", () => {
    const r = coordinateReview({
      findings: [
        mk({ path: "a.ts", startLine: 1, title: "perf", level: "warning" }),
        mk({ path: "a.ts", startLine: 9, title: "doc", level: "notice" }),
      ],
    });
    expect(r.warnings).toBe(1);
    expect(r.suggestions).toBe(1);
    expect(r.verdict).toBe("comment");
  });

  it("any failure → request-changes (bias preserved: only critical blocks)", () => {
    const r = coordinateReview({
      findings: [
        mk({ path: "a.ts", startLine: 1, title: "sqli", level: "failure" }),
        mk({ path: "a.ts", startLine: 2, title: "perf", level: "warning" }),
        mk({ path: "a.ts", startLine: 3, title: "style", level: "notice" }),
      ],
    });
    expect(r.critical).toBe(1);
    expect(r.warnings).toBe(1);
    expect(r.suggestions).toBe(1);
    expect(r.verdict).toBe("request-changes");
  });

  it("an empty review approves with zero counts", () => {
    const r = coordinateReview({ findings: [] });
    expect(r).toEqual({
      verdict: "approve",
      critical: 0,
      warnings: 0,
      suggestions: 0,
      findings: [],
    });
  });

  it("dedups by (path, startLine, title), keeping the first occurrence", () => {
    const first = mk({ path: "a.ts", startLine: 5, title: "dup", level: "warning", message: "keep me" });
    const same = mk({ path: "a.ts", startLine: 5, title: "dup", level: "failure", message: "drop me" });
    const r = coordinateReview({ findings: [first, same] });
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]!.message).toBe("keep me");
    // The dropped duplicate's level does not inflate the counts.
    expect(r.warnings).toBe(1);
    expect(r.critical).toBe(0);
  });

  it("does NOT dedup findings that differ in path / line / title", () => {
    const r = coordinateReview({
      findings: [
        mk({ path: "a.ts", startLine: 5, title: "x", level: "notice" }),
        mk({ path: "b.ts", startLine: 5, title: "x", level: "notice" }), // diff path
        mk({ path: "a.ts", startLine: 6, title: "x", level: "notice" }), // diff line
        mk({ path: "a.ts", startLine: 5, title: "y", level: "notice" }), // diff title
      ],
    });
    expect(r.findings).toHaveLength(4);
  });

  it("is authoritative on the current run — a fixed finding clears (no carry-over)", () => {
    // Push 1: a failure finding → request-changes.
    const push1 = coordinateReview({
      findings: [mk({ path: "a.ts", startLine: 1, title: "sqli", level: "failure" })],
    });
    expect(push1.verdict).toBe("request-changes");
    expect(push1.critical).toBe(1);

    // Push 2: the author fixed it, so the reviewers no longer raise it. `coordinate`
    // is stateless — nothing is carried over from push 1 — so the verdict clears.
    const push2 = coordinateReview({ findings: [] });
    expect(push2.verdict).toBe("approve");
    expect(push2.critical).toBe(0);
    expect(push2.findings).toHaveLength(0);
  });

  it("coordinate is the Effect wrapper of coordinateReview and never fails", async () => {
    const findings = [
      mk({ path: "a.ts", startLine: 1, title: "boom", level: "failure" }),
    ];
    const r = await Effect.runPromise(coordinate({ findings }));
    expect(r).toEqual(coordinateReview({ findings }));
    expect(r.verdict).toBe("request-changes");
  });
});
