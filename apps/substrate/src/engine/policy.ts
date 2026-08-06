// Pure sandbox policy helpers — the decisions, with none of the runtime.
//
// This module exists because of what it does NOT import. `@cloudflare/sandbox`
// pulls `cloudflare:`-scheme specifiers transitively, which the plain Node
// runner cannot resolve, so anything importing it can only be tested behind a
// fake of a moving SDK surface. The rules below are pure decisions about
// numbers and strings; keeping them here means the assertions worth running on
// every commit run against the real code with nothing mocked at all.
// (Same split as the reference implementation's sandbox-policy.ts.)

/**
 * The longest id `sanitizeSandboxId` accepts before throwing
 * `INVALID_SANDBOX_ID_LENGTH` (a DNS label limit the SDK enforces on every
 * `getSandbox` call, whether or not preview URLs are used).
 */
export const MAX_SANDBOX_ID = 63;

/**
 * The Durable Object name for one consumer's sandbox key.
 *
 * The consumer prefix is the isolation property: two consumers' keys can never
 * reach the same container, whatever they name their executions (contract:
 * `SandboxKey` is unique per consumer, namespaced here). The length check is
 * not defensive padding — `sanitizeSandboxId` throws above 63 characters at
 * container start, where the failure would surface as an execution that broke
 * for no visible reason. The facade turns this throw into a typed
 * `recipe-rejected` refusal instead.
 */
export function sandboxDoName(consumer: string, key: string): string {
  const id = `${consumer}:${key}`;
  if (id.length > MAX_SANDBOX_ID)
    throw new Error(
      `sandbox id is ${id.length} chars, over the SDK's ${MAX_SANDBOX_ID} limit: ${id}`,
    );
  return id;
}

/**
 * Wrap a value so a shell treats it as one literal argument.
 *
 * Single quotes because they suppress every expansion a shell does; the
 * `'\''` dance is the only way to get a literal single quote inside them. This
 * guards the paths the sandbox builds around a workload's command — the
 * command itself is deliberately *not* quoted, since running it is the whole
 * point (the boundary is the egress policy, not the shell parser).
 */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Keep the last `maxBytes` of output, cut on a byte boundary rather than a
 * character one.
 *
 * Slicing a UTF-8 buffer at an arbitrary offset can land mid-codepoint, and the
 * decoder turns the orphaned lead bytes into U+FFFD — so the leading
 * replacement characters are dropped rather than shown to a consumer as
 * content. This clamp bounds what leaves the container; consumers may clamp
 * again for their own step-result budgets.
 */
export function clampTailBytes(
  text: string,
  maxBytes: number,
): { tail: string; truncated: boolean } {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= maxBytes) return { tail: text, truncated: false };
  const sliced = new TextDecoder().decode(bytes.slice(bytes.length - maxBytes));
  return { tail: sliced.replace(/^�+/, ""), truncated: true };
}

/**
 * Put a nonce in a log filename, keeping the caller's shape recognisable.
 *
 * The artifacts mount is writable from inside the container and a consumer's
 * `logPath` can derive its name from values the workload knows. A hostile
 * command could then overwrite an earlier step's log — it cannot reach another
 * execution (the mount is prefixed per container), but it can rewrite its own
 * history, which is exactly the record a human reads to find out what
 * happened. A nonce the workload never sees closes that.
 */
export function nonceLogPath(logPath: string, nonce: string): string {
  const dot = logPath.lastIndexOf(".");
  const short = nonce.replace(/-/g, "").slice(0, 12);
  return dot > logPath.lastIndexOf("/")
    ? `${logPath.slice(0, dot)}.${short}${logPath.slice(dot)}`
    : `${logPath}.${short}`;
}
