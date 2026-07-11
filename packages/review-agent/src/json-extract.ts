// @fractalboxdev/flare-dispatch-review-agent — JSON extraction from model text.
//
// `mode: "json"` providers return free-form text that should contain one JSON
// object — but reasoning models (DeepSeek-R1 distills, GLM, Kimi, …) wrap it in
// `<think>…</think>` (or `<thinking>` / `◁think▷`) prose, quote code in ```` ```rust ````
// fences, and may emit JSON-ish fragments mid-reasoning. The answer is usually
// the LAST balanced JSON value, not the first.
//
// `extractJsonText` isolates the first balanced value (back-compat, single
// answer). `extractJsonCandidates` returns EVERY balanced value so a
// schema-aware caller can pick the one that actually decodes (the engine tries
// them last-first). Pure + dependency-free.

/** Reasoning-block tag names recognised in `<…>` form (case-insensitive). */
const THINK_TAGS = "think|thinking|reasoning";

/**
 * Strip reasoning blocks: `<think>…</think>` and its `<thinking>` / `<reasoning>`
 * variants (case-insensitive, across newlines), plus Kimi's `◁think▷…◁/think▷`.
 * Paired blocks are removed first (non-greedy); an unterminated opener (the model
 * truncated mid-thought) then drops everything from the tag on.
 */
export const stripThinkBlocks = (text: string): string =>
  text
    .replace(
      new RegExp(`<(?:${THINK_TAGS})>[\\s\\S]*?</(?:${THINK_TAGS})>`, "gi"),
      "",
    )
    .replace(/◁think▷[\s\S]*?◁\/think▷/gi, "")
    // Unterminated openers — drop the trailing reasoning.
    .replace(new RegExp(`<(?:${THINK_TAGS})>[\\s\\S]*$`, "i"), "")
    .replace(/◁think▷[\s\S]*$/i, "");

/**
 * Strip a leading/wrapping markdown code fence (``` or ```json) so the JSON body
 * is exposed. Returns the FIRST fenced block's content when a fence is present.
 */
export const stripCodeFences = (text: string): string => {
  const fenced = text.match(/```(?:json|jsonc)?\s*([\s\S]*?)```/i);
  if (fenced && fenced[1] !== undefined) return fenced[1];
  return text;
};

/**
 * Bracket-match a balanced JSON value (object `{…}` or array `[…]`) starting at
 * `start` (which must be `{` or `[`), ignoring brackets inside strings. Returns
 * the matched slice and the index just past it, or `undefined` if unbalanced.
 */
const matchBalanced = (
  text: string,
  start: number,
): { readonly slice: string; readonly end: number } | undefined => {
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return { slice: text.slice(start, i + 1), end: i + 1 };
    }
  }
  return undefined;
};

/**
 * Isolate the FIRST balanced top-level JSON value in `text` by bracket-matching.
 * Returns `undefined` when no balanced value is found.
 */
const isolateJsonValue = (text: string): string | undefined => {
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{" || ch === "[") {
      const m = matchBalanced(text, i);
      if (m !== undefined) return m.slice;
    }
  }
  return undefined;
};

/**
 * Every balanced top-level JSON value in `text`, in document order — so a model
 * that quotes code (```` ```rust {…} ````) or writes example JSON while reasoning
 * before the real answer still gets parsed: the engine tries these last-first
 * and keeps the one that decodes against the schema.
 */
const allBalancedJson = (text: string): readonly string[] => {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "{" || ch === "[") {
      const m = matchBalanced(text, i);
      if (m !== undefined) {
        out.push(m.slice);
        i = m.end;
        continue;
      }
    }
    i++;
  }
  return out;
};

/**
 * Best-effort isolation of the SINGLE JSON payload from a model's text response:
 * strip `<think>` blocks, strip code fences, then bracket-match the first
 * balanced value. Returns the candidate text, or `undefined`. Prefer
 * {@link extractJsonCandidates} when a schema is available.
 */
export const extractJsonText = (text: string): string | undefined => {
  const cleaned = stripCodeFences(stripThinkBlocks(text)).trim();
  if (cleaned === "") return undefined;
  return isolateJsonValue(cleaned);
};

/**
 * EVERY balanced JSON value in the response (reasoning stripped), in document
 * order. Reasoning models bury the answer last and may emit earlier JSON-ish
 * fragments (examples, quoted code), so a schema-aware caller should try these
 * last-first and keep the first that validates. Returns `[]` when none found.
 */
export const extractJsonCandidates = (text: string): readonly string[] =>
  typeof text === "string" ? allBalancedJson(stripThinkBlocks(text)) : [];
