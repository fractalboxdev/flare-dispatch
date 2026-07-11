// Derive a preview-URL-safe sandbox id from an arbitrary execution id.
//
// The `@cloudflare/sandbox` SDK turns the sandbox id into the first DNS label
// of the container preview URL: `<port>-<sandboxId>-<token>.<hostname>`. That
// label must satisfy DNS rules, and the SDK enforces a subset eagerly:
//
//   * `constructPreviewUrl` THROWS `SandboxSecurityError` if the id contains
//     uppercase letters (hostnames are case-insensitive) unless the sandbox was
//     created with `{ normalizeId: true }`.
//   * `sanitizeSandboxId` rejects ids > 63 chars or with leading/trailing `-`.
//   * the whole label (`<port>-<id>-<token>`) must be ≤ 63 chars — the SDK's
//     port token is 16 chars and a port is ≤ 5 digits, so the id budget is
//     63 − 5 − 16 − 2(hyphens) = 40.
//
// Our execution ids are `<run>:<owner>_<repo>:<sha12>` (e.g.
// `cdp-acceptance:Numu-AI_numu-monorepo:6758041bc1ee`) — uppercase from the
// org name, `:`/`_` separators, and ~49 chars once flattened. Passed straight
// to `getSandbox`, `expose-app` throws `ExposePortFailed` on every run for any
// repo whose owner/name isn't already lowercase DNS-clean. This normalises the
// id so the same value is safe for `getSandbox` (DO routing), `exposePort`
// (preview URL construction), and `proxyToSandbox` (preview URL parsing).
//
// `getSandbox` routes the Durable Object by the id it is handed, so this MUST
// be applied at every `getSandbox` call site for one run (sandbox + cache +
// artifact) — otherwise checkout/boot and expose resolve to different
// containers. We do that by deriving it once and threading it through the
// `Container` handle (`acquire`'s `{ id }`), which the cache/artifact layers
// re-use.

/** Max sandbox-id length that keeps the preview-URL DNS label ≤ 63 chars. */
const MAX_SANDBOX_ID_LEN = 40;

/**
 * Normalise an execution id into a sandbox id safe for `@cloudflare/sandbox`
 * preview URLs: lowercase, `[a-z0-9-]` only, no leading/trailing `-`, and
 * ≤ {@link MAX_SANDBOX_ID_LEN} chars. When truncation is needed the TAIL is
 * kept, preserving the unique 12-char sha suffix so distinct executions stay
 * distinct.
 */
export const previewSafeSandboxId = (executionId: string): string => {
  const flattened = executionId
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-");

  const capped =
    flattened.length > MAX_SANDBOX_ID_LEN
      ? flattened.slice(flattened.length - MAX_SANDBOX_ID_LEN)
      : flattened;

  // Trim leading/trailing hyphens (a DNS-label requirement the SDK enforces),
  // which truncation or separator collapsing can introduce at the edges.
  const trimmed = capped.replace(/^-+/, "").replace(/-+$/, "");

  // An id that sanitises to empty (all-separator input) still needs a stable,
  // valid handle; the caller's execution id is unique enough that this is only
  // a theoretical guard.
  return trimmed === "" ? "sandbox" : trimmed;
};
