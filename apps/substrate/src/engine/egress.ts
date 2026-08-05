// The substrate's outbound policy engine (specs/adr/0005-deny-all-egress-with-grant-profiles.md).
//
// Ported from fractalbot's reviewed reference implementation (its src/egress.ts,
// designated the substrate engine's reference by our ADR-0005). The container
// runs `enableInternet = false` with an empty allowlist, so nothing leaves it
// until a grant is issued. This module is what a grant is made of: the host
// set, the deny set, the per-host method/path rules, and the handler that
// enforces them on every request the container makes.
//
// Three properties are load-bearing and each one is a separate control here.
//
// 1. A handler is a policy engine, not a header-setter. Within a grant window
//    the workload chooses the request, so host scope proves nothing — the same
//    host serves `git-upload-pack` (read) and `git-receive-pack` (push) and the
//    LFS batch endpoint serves download and upload at one URL. Method, path and
//    for LFS the request body are asserted against the recipe's repository,
//    which no model authored (the recipe is frozen consumer-side from inputs a
//    human or reviewed code wrote — ADR-0005).
//
// 2. A handler's own `fetch()` is a Worker fetch. None of `enableInternet`,
//    `allowedHosts` or `deniedHosts` govern it, so following a redirect is a
//    bidirectional channel straight through the allowlist. Every request here
//    is `redirect: "manual"`, every `Location` is re-decided against the same
//    policy, and no Request is ever forwarded unmodified.
//
// 3. Admission is not inspection. Precedence ends in public egress, so an
//    allowlisted host with no matching handler gets a direct, unseen fetch.
//    `buildGrant` therefore emits concrete hostnames and refuses to return a
//    grant whose admitted set differs from its handled set.
//
// The threat model is hostile processes — a `postinstall`, a `build.rs`, a
// `conftest.py` — not a confused model, so nothing here depends on the model
// cooperating. This build serves the `public-repo-read` profile only: no
// credential is injected on any path (ADR-0006 lands injection later), and the
// write rules exist because the engine is what makes adding one safe.
//
// Every denial is reported through `ServeDeps.recordDenial` so it can be
// aggregated per execution and retrieved with the artifacts — and never
// surfaced into the container beyond a reason-only 403 (oracle resistance).
//
// Pure except for the handler's own fetch, which is injectable. Zero Cloudflare
// imports. Unit tested in egress.test.ts.
import { repoSlug, type DenialEvent, type SubstrateRepoRef } from "@fractalboxdev/flare-dispatch-substrate-contract";

/**
 * The shape `@cloudflare/containers` passes to an outbound handler, declared
 * structurally rather than imported — it is a transitive dependency, and two
 * fields are not worth a phantom import. Assignment into the Sandbox class's
 * `static outboundHandlers` type-checks structurally.
 */
export type OutboundContext<P> = {
  containerId: string;
  className: string;
  params?: P;
};

/** What a grant freezes into `setOutboundByHost` params. None of it is model-authored. */
export type GrantParams = {
  /** `owner/name` from the recipe's repo — an input no model wrote. */
  repo: string;
  /**
   * The container this grant was issued to. `setOutboundByHost` is already
   * per-instance, so this is defence in depth against a handler reached from
   * an instance the grant was never issued for.
   */
  containerId: string;
  /** Admits the LFS object host, whose paths cannot be repo-scoped. Off by default. */
  lfs?: boolean;
};

export type Decision =
  | { ok: true }
  | { ok: false; reason: string };

const MAX_REDIRECTS = 5;

/** git's pack negotiation body. Bounded, but genuinely workload-controlled — see `POST_SINK_NOTE`. */
const MAX_UPLOAD_PACK_BYTES = 1024 * 1024;
const MAX_LFS_BATCH_BYTES = 256 * 1024;

/**
 * `git-upload-pack` takes a workload-authored body on an allowed host, so it is
 * a bounded exfiltration sink and is not claimed otherwise (an accepted
 * residual in specs/platform.md). What the rules below buy is that it is the
 * *only* POST body that reaches github.com, capped, and to one path under one
 * repository.
 */
export const POST_SINK_NOTE =
  "git-upload-pack carries a workload-controlled body; bounded, not eliminated";

/**
 * Write sinks that must never be reachable, whatever a handler decides.
 * `deniedHosts` is the one rule a handler cannot override on the container
 * side — and `decide` applies it again on redirect targets, because the
 * platform's deny list does not govern a handler's own fetch.
 *
 * Wildcards here are deliberate: these hold even if the admitted set is later
 * widened to `*.github.com`.
 */
export const WRITE_SINKS = [
  "gist.github.com",
  "uploads.github.com",
  "api.github.com",
] as const;

/**
 * Lowercase, strip the root label's trailing dot, drop any port.
 *
 * `GitHub.com.` and `github.com:443` resolve to the same origin as
 * `github.com`, so a matcher that compares raw strings can be walked around.
 * Userinfo (`https://github.com@evil.com/`) never reaches here — callers pass
 * `URL.hostname`, which excludes it, and IDN is already punycoded by `URL`.
 */
export function normalizeHost(host: string): string {
  let h = host.trim().toLowerCase();
  const lastColon = h.lastIndexOf(":");
  // Only strip a port, never a colon inside a bracketed IPv6 literal.
  if (lastColon > h.lastIndexOf("]")) h = h.slice(0, lastColon);
  if (h.endsWith(".")) h = h.slice(0, -1);
  return h;
}

/**
 * Host glob matching, anchored at both ends.
 *
 * Anchoring cuts two ways and both matter: `evilgithub.com` cannot spoof
 * `*.github.com`, and a pattern with no `*` is exact — `github.com` alone does
 * not admit `codeload.github.com` or `objects.githubusercontent.com`, so a
 * clone that follows a redirect or fetches an LFS object fails until each host
 * is listed. A `*` matches exactly one label and never a dot, so
 * `*.github.com` does not admit `a.b.github.com` either. That is narrower than
 * the platform matcher may be, which is the safe direction for a re-check: it
 * can only deny more than the container-side gate already did.
 */
export function hostMatches(pattern: string, host: string): boolean {
  const p = normalizeHost(pattern);
  const h = normalizeHost(host);
  if (!p || !h) return false;
  if (!p.includes("*")) return p === h;

  const source = p
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^.]+");
  return new RegExp(`^${source}$`).test(h);
}

export type PathRule = {
  method: "GET" | "POST";
  match: (url: URL) => boolean;
  maxBodyBytes?: number;
  /** Returns a denial reason, or undefined when the body is acceptable. */
  assertBody?: (raw: string) => string | undefined;
};

type HostPolicy = {
  /** Concrete hostname. The effective policy holds no globs — see `buildGrant`. */
  host: string;
  rules: PathRule[];
};

export type EgressPolicy = {
  repo: string;
  hosts: HostPolicy[];
  deny: readonly string[];
};

/** git appends `.git` to the remote path about half the time; accept both spellings. */
function repoPrefixes(slug: string): string[] {
  return [`/${slug}`, `/${slug}.git`];
}

function underRepo(slug: string, url: URL, suffix: string): boolean {
  return repoPrefixes(slug).some((p) => url.pathname === `${p}${suffix}`);
}

/**
 * The `public-repo-read` profile (ADR-0005): cloning and reading one public
 * repository. No credential is injected anywhere in it, so every rule is about
 * what the container may *say*, not what it may say it with.
 *
 * Read over git's smart HTTP transport is not GET-only — discovery is
 * `GET /info/refs?service=git-upload-pack` and negotiation is
 * `POST /git-upload-pack`. The push counterparts share both URLs, distinguished
 * only by the `service` parameter and the path's last segment, which is exactly
 * why the assertion is on method and path rather than host.
 */
export function publicRepoPolicy(params: GrantParams): EgressPolicy {
  const slug = params.repo;
  const hosts: HostPolicy[] = [
    {
      host: "github.com",
      rules: [
        {
          // Ref discovery. `service=git-receive-pack` is push discovery and is
          // refused here rather than left to fail at GitHub.
          method: "GET",
          match: (url) =>
            underRepo(slug, url, "/info/refs") &&
            url.searchParams.get("service") === "git-upload-pack",
        },
        {
          method: "POST",
          match: (url) => underRepo(slug, url, "/git-upload-pack"),
          maxBodyBytes: MAX_UPLOAD_PACK_BYTES,
        },
        {
          // LFS batch. Download and upload are the same URL and the same
          // method; only the body separates them, so the body is asserted.
          method: "POST",
          match: (url) =>
            params.lfs === true &&
            underRepo(slug, url, "/info/lfs/objects/batch"),
          maxBodyBytes: MAX_LFS_BATCH_BYTES,
          assertBody: (raw) => {
            let parsed: unknown;
            try {
              parsed = JSON.parse(raw);
            } catch {
              return "lfs batch body is not JSON";
            }
            const op = (parsed as { operation?: unknown } | null)?.operation;
            return op === "download"
              ? undefined
              : `lfs batch operation ${JSON.stringify(op)} is not download`;
          },
        },
        {
          // Archive download, which 302s to codeload.
          method: "GET",
          match: (url) =>
            repoPrefixes(slug).some((p) =>
              url.pathname.startsWith(`${p}/archive/`)
            ),
        },
      ],
    },
    {
      host: "codeload.github.com",
      rules: [
        {
          method: "GET",
          match: (url) =>
            repoPrefixes(slug).some((p) =>
              url.pathname.startsWith(`${p}/`)
            ),
        },
      ],
    },
  ];

  if (params.lfs === true) {
    hosts.push({
      host: "objects.githubusercontent.com",
      // LFS object URLs are opaque signed paths with no repository segment, so
      // this host cannot carry a repo-scoped path assertion — the only controls
      // left are GET-only and no body. That weakness is why LFS is opt-in
      // rather than part of the default clone grant.
      rules: [{ method: "GET", match: () => true }],
    });
  }

  return { repo: slug, hosts, deny: WRITE_SINKS };
}

/**
 * The two calls that admit a host and the two that map a handler, plus the
 * denies. Kept as data so the caller's `finally` can reverse exactly what it
 * applied, and so a grant is reviewable in a test rather than only in a log.
 */
export type Grant = {
  /**
   * Concrete hostnames, never globs. A glob admits hosts no handler is mapped
   * to, and precedence ends in public egress — the admitted host would get a
   * direct, uninspected fetch.
   */
  allow: string[];
  deny: string[];
  handlers: { host: string; method: keyof typeof egressHandlers; params: GrantParams }[];
};

/**
 * Build the grant for a public-read recipe, refusing any grant that would
 * admit a host it does not also inspect.
 *
 * @throws if the admitted set and the handled set differ, or the repo slug is
 * not `owner/name` — a malformed slug would otherwise widen every path rule.
 */
export function buildGrant(params: GrantParams): Grant {
  if (!/^[\w.-]+\/[\w.-]+$/.test(params.repo))
    throw new Error(`egress: refusing a grant for malformed repo ${JSON.stringify(params.repo)}`);
  if (!params.containerId)
    throw new Error("egress: refusing a grant with no containerId to bind to");

  const policy = publicRepoPolicy(params);
  const allow = policy.hosts.map((h) => h.host);
  const handlers = allow.map((host) => ({
    host,
    method: "publicRepo" as const,
    params,
  }));

  const admitted = new Set(allow);
  const handled = new Set(handlers.map((h) => h.host));
  if (
    admitted.size !== handled.size ||
    [...admitted].some((h) => !handled.has(h))
  )
    throw new Error("egress: grant would admit a host with no handler");

  return { allow, deny: [...policy.deny], handlers };
}

/**
 * The subset of the Container runtime API a grant needs. Structural so this
 * module stays testable without a container.
 */
export type GrantTarget = {
  allowHost(hostname: string): Promise<void>;
  removeAllowedHost(hostname: string): Promise<void>;
  denyHost(hostname: string): Promise<void>;
  removeDeniedHost(hostname: string): Promise<void>;
  setOutboundByHost(hostname: string, methodName: string, params?: GrantParams): Promise<void>;
  removeOutboundByHost(hostname: string): Promise<void>;
};

/**
 * Apply a grant: deny first, then map handlers, then admit.
 *
 * The order matters in the direction of failure. `allowedHosts` is evaluated
 * strictly before any handler, so admitting a host before its handler is mapped
 * opens a window in which requests fall through precedence to public egress.
 * Admission is therefore last.
 */
export async function applyGrant(target: GrantTarget, grant: Grant): Promise<void> {
  for (const host of grant.deny) await target.denyHost(host);
  for (const h of grant.handlers)
    await target.setOutboundByHost(h.host, h.method, h.params);
  for (const host of grant.allow) await target.allowHost(host);
}

/**
 * Revoke a grant, unconditionally and completely.
 *
 * Callers wrap `applyGrant` in `try/finally` and call this from the `finally`,
 * and `ensure()` calls it again as a backstop. **The process group must be
 * killed before this runs** — a backgrounded `postinstall` outlives the
 * command that spawned it and would otherwise keep egressing inside a window
 * the caller believes it closed.
 *
 * Admission is dropped first, and one failing call never strands the rest: an
 * error mid-revoke would otherwise leave a host admitted with its handler
 * already gone, which is the fall-through-to-public-egress case. Errors are
 * collected and thrown together after everything has been attempted.
 *
 * **Denies are deliberately not revoked.** They are a floor rather than part of
 * the grant's authority — nothing about finishing an execution should make a
 * write sink reachable again. `removeDeniedHost` also filters
 * `effectiveDeniedHosts` (`@cloudflare/containers@0.3.7`, `container.js:543`),
 * which folds any class-level `deniedHosts` into a runtime override with that
 * host missing, so a symmetrical revoke would silently weaken a static deny
 * list the moment one is added to the Sandbox class.
 */
export async function revokeGrant(target: GrantTarget, grant: Grant): Promise<void> {
  const errors: unknown[] = [];
  const attempt = async (fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      errors.push(e);
    }
  };

  for (const host of grant.allow) await attempt(() => target.removeAllowedHost(host));
  for (const h of grant.handlers) await attempt(() => target.removeOutboundByHost(h.host));

  if (errors.length)
    throw new AggregateError(errors, `egress: ${errors.length} revoke call(s) failed`);
}

/**
 * Decide one request against the policy: protocol, deny list, host, then
 * method and path. Used for the container's request and re-used unchanged for
 * every redirect target.
 */
export function decide(
  policy: EgressPolicy,
  method: string,
  url: URL
): Decision & { rule?: PathRule } {
  // A redirect to `http:` would strip TLS on the outbound leg, which the
  // container's own gate never sees.
  if (url.protocol !== "https:")
    return { ok: false, reason: `protocol ${url.protocol} is not https` };

  const host = normalizeHost(url.hostname);

  // Deny first, and by pattern — this is the rule a handler cannot override,
  // so it is re-applied here where the platform's list does not reach.
  for (const pattern of policy.deny)
    if (hostMatches(pattern, host))
      return { ok: false, reason: `host ${host} is a denied write sink` };

  const hostPolicy = policy.hosts.find((h) => normalizeHost(h.host) === host);
  if (!hostPolicy) return { ok: false, reason: `host ${host} is not admitted` };

  // HEAD is read-only and rides the GET rules; nothing else does.
  const m = method.toUpperCase();
  const effective = m === "HEAD" ? "GET" : m;
  if (effective !== "GET" && effective !== "POST")
    return { ok: false, reason: `method ${m} is not permitted` };

  const rule = hostPolicy.rules.find((r) => r.method === effective && r.match(url));
  if (!rule)
    return {
      ok: false,
      reason: `${m} ${url.pathname} is outside the grant for ${policy.repo}`,
    };

  return { ok: true, rule };
}

/**
 * Request headers forwarded upstream. An allowlist rather than a blocklist:
 * the container is hostile, so anything it invents — `Authorization`,
 * `Cookie`, `X-Forwarded-*` — is dropped rather than enumerated. `git-protocol`
 * is required for protocol v2, and dropping it silently halves clone
 * performance rather than failing loudly.
 */
const FORWARDED_HEADERS = [
  "accept",
  "accept-encoding",
  "content-type",
  "git-protocol",
  "if-modified-since",
  "if-none-match",
  "range",
  "user-agent",
];

function forwardedHeaders(source: Headers): Headers {
  const out = new Headers();
  for (const name of FORWARDED_HEADERS) {
    const value = source.get(name);
    if (value !== null) out.set(name, value);
  }
  return out;
}

export type ServeDeps = {
  fetch: typeof fetch;
  /**
   * Denial recorder (ADR-0005): every handler 403 is reported here so the
   * substrate can aggregate `{host, method, path, reason, count}` per
   * execution. Fire-and-forget — recording must never delay or fail a denial.
   */
  recordDenial?: (event: Omit<DenialEvent, "count">) => void;
};

/**
 * The engine. Exported for tests; `egressHandlers.publicRepo` is the thin
 * production wrapper that supplies the real `fetch` (the DO layer adds the
 * denial recorder).
 *
 * Every outbound request is constructed here from scratch. Passing the
 * container's Request through — even with headers edited — would carry its
 * redirect mode, its credentials mode and its body along with it, and
 * `redirect: "follow"` on a Worker fetch is the bidirectional channel this
 * whole module exists to close.
 */
export async function serveGrantedRequest(
  req: Request,
  ctx: OutboundContext<GrantParams>,
  deps: ServeDeps
): Promise<Response> {
  const denied = (reason: string, at?: URL): Response => {
    // The record carries the request; the body names only the rule, so a
    // hostile process cannot use 403 text as an oracle for what else it could
    // have reached.
    try {
      const target = at ?? new URL(req.url);
      deps.recordDenial?.({
        host: target.hostname,
        method: req.method.toUpperCase(),
        path: target.pathname,
        reason,
      });
    } catch {
      // An unparseable URL still gets its denial response below.
    }
    return new Response(`egress denied: ${reason}\n`, {
      status: 403,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  };

  // No params means no grant was issued for this host — the handler was
  // reached through a class-level mapping or a stale override. Fail closed.
  const params = ctx.params;
  if (!params?.repo || !params.containerId)
    return denied("no grant is bound to this request");

  if (ctx.containerId !== params.containerId)
    return denied("grant was issued to a different container");

  let policy: EgressPolicy;
  try {
    policy = publicRepoPolicy(params);
  } catch {
    return denied("grant params are malformed");
  }

  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    return denied("unparseable request url");
  }

  const first = decide(policy, req.method, url);
  if (!first.ok) return denied(first.reason, url);

  // Buffer once: the body is needed for the cap, for the LFS assertion, and
  // again if a 307/308 preserves the method across hosts.
  let body: ArrayBuffer | undefined;
  if (req.method.toUpperCase() === "POST") {
    const declared = Number(req.headers.get("content-length") ?? "");
    const cap = first.rule?.maxBodyBytes ?? 0;
    if (Number.isFinite(declared) && declared > cap)
      return denied(`request body declares ${declared} bytes, over the ${cap} cap`, url);

    body = await req.arrayBuffer();
    if (body.byteLength > cap)
      return denied(`request body is ${body.byteLength} bytes, over the ${cap} cap`, url);

    const assert = first.rule?.assertBody;
    if (assert) {
      const reason = assert(new TextDecoder().decode(body));
      if (reason) return denied(reason, url);
    }
  }

  let method = req.method.toUpperCase();
  let target = url;
  let payload = body;

  for (let hop = 0; ; hop++) {
    if (hop > MAX_REDIRECTS) return denied("too many redirects", target);

    const upstream = await deps.fetch(target.toString(), {
      method,
      headers: forwardedHeaders(req.headers),
      body: method === "POST" ? payload : undefined,
      redirect: "manual",
    });

    const location = upstream.headers.get("location");
    if (upstream.status < 300 || upstream.status >= 400 || location === null) {
      const headers = new Headers(upstream.headers);
      headers.delete("set-cookie");
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers,
      });
    }

    let next: URL;
    try {
      next = new URL(location, target);
    } catch {
      return denied("redirect Location is unparseable", target);
    }

    // 301/302/303 downgrade to GET and drop the body; 307/308 preserve both.
    if (upstream.status !== 307 && upstream.status !== 308) {
      method = "GET";
      payload = undefined;
    }

    // The whole policy again, not just the host: a redirect that lands on an
    // admitted host at a path outside the grant is the same escape.
    const onward = decide(policy, method, next);
    if (!onward.ok)
      return denied(`redirect to ${next.host}${next.pathname} refused: ${onward.reason}`, next);

    if (method === "POST" && payload && payload.byteLength > (onward.rule?.maxBodyBytes ?? 0))
      return denied("redirect would replay a body over the target's cap", next);

    target = next;
  }
}

/**
 * The named handlers a Sandbox class exposes as `static outboundHandlers`.
 * `setOutboundByHost(host, "publicRepo", params)` is what binds one to a grant;
 * nothing is mapped at class level, so an unbound call has no params and is
 * refused above. The DO layer (sandbox-do.ts) re-wraps these with the denial
 * recorder wired to storage.
 */
export const egressHandlers = {
  publicRepo: (
    req: Request,
    _env: unknown,
    ctx: OutboundContext<GrantParams>
  ): Promise<Response> => serveGrantedRequest(req, ctx, { fetch }),
};

/** Convenience for callers holding a repo ref rather than a slug. */
export function grantParamsFor(
  repo: SubstrateRepoRef,
  containerId: string,
  opts: { lfs?: boolean } = {}
): GrantParams {
  return { repo: repoSlug(repo), containerId, lfs: opts.lfs };
}
