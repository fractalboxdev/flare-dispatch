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
 * Collision-breaking digest appended when the flattened id does not fit — 32
 * bits as 8 lowercase hex chars.
 *
 * Truncation used to keep the TAIL alone, on the reasoning that the 12-char sha
 * suffix is what makes an execution unique. It is not: every run in the fan-out
 * shares one commit. `<run>_<owner>_<repo>_<sha12>` differs between runs ONLY in
 * the `<run>` prefix, so tail-truncation deleted the one discriminating part and
 * mapped the whole fan-out onto a single container. Anything longer than
 * `<owner>-<repo>-<sha12>` collided outright: `fractalboxdev-flare-dispatch-` +
 * sha12 is 41 chars, one over budget, so `offload-test`, `oxlint`, `check` and
 * `pr-review` all routed to `ractalboxdev-flare-dispatch-<sha12>`. Sharing a
 * container means sharing a filesystem, and `workspace()` opens with
 * `rm -rf <dir>` — one run's checkout deleted another's tree mid-exec, which
 * surfaces as `Failed to change directory to '<cwd>'` (see `isWorkingDirFailure`
 * in sandbox-cf.ts) and, for a `failOnNonZeroExit` run, a red check on a commit
 * that was never tested.
 *
 * The digest covers the WHOLE flattened id, so it discriminates exactly what
 * head+tail drops.
 */
const DIGEST_LEN = 8;
/** Readable head kept ahead of the digest — enough to name the run + owner. */
const HEAD_LEN = 18;
/** Readable tail kept ahead of the digest — exactly the 12-char sha. */
const TAIL_LEN = 12;

/**
 * FNV-1a (32-bit), hex. Not a hash for security — it breaks ties between ids
 * that share a head and a tail, and it has to be SYNCHRONOUS (`crypto.subtle`
 * is async and this is called on every `getSandbox` path) and identical across
 * Worker invocations, since each durable step re-derives the id from the same
 * execution id and must land on the same Durable Object.
 */
const digest = (value: string): string => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    // `Math.imul`, not `*`: the 32-bit FNV prime overflows the float64 mantissa
    // and silently drops the low bits that make the digest discriminate.
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(DIGEST_LEN, "0");
};

/**
 * Normalise an execution id into a sandbox id safe for `@cloudflare/sandbox`
 * preview URLs: lowercase, `[a-z0-9-]` only, no leading/trailing `-`, and
 * ≤ {@link MAX_SANDBOX_ID_LEN} chars. Distinct execution ids always yield
 * distinct sandbox ids — see {@link DIGEST_LEN} for why that is the whole point.
 */
export const previewSafeSandboxId = (executionId: string): string => {
  const flattened = executionId
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-");

  // `HEAD_LEN + TAIL_LEN + DIGEST_LEN + 2` separators is exactly
  // MAX_SANDBOX_ID_LEN, and the collapse below can only shorten it. Head and
  // tail cannot overlap: this branch only runs above 40 chars.
  const capped =
    flattened.length > MAX_SANDBOX_ID_LEN
      ? `${flattened.slice(0, HEAD_LEN)}-${flattened.slice(-TAIL_LEN)}-${digest(flattened)}`.replace(
          /-+/g,
          "-",
        )
      : flattened;

  // Trim leading/trailing hyphens (a DNS-label requirement the SDK enforces),
  // which truncation or separator collapsing can introduce at the edges.
  const trimmed = capped.replace(/^-+/, "").replace(/-+$/, "");

  // An id that sanitises to empty (all-separator input) still needs a stable,
  // valid handle; the caller's execution id is unique enough that this is only
  // a theoretical guard.
  return trimmed === "" ? "sandbox" : trimmed;
};
