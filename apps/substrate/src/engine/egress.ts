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
// cooperating. `public-repo-read` needs no credential on any path; the
// credentialed profiles (`cf-api`, `js-install`) attach one **here**, in the
// handler, to a request the container authored but never authenticated
// (ADR-0006, `credentials.ts`) — which is what the write rules above were built
// to make safe.
//
// Every denial is reported through `ServeDeps.recordDenial` so it can be
// aggregated per execution and retrieved with the artifacts — and never
// surfaced into the container beyond a reason-only 403 (oracle resistance).
//
// Pure except for the handler's own fetch, which is injectable. Zero Cloudflare
// imports. Unit tested in egress.test.ts.
import {
  repoSlug,
  type CredentialDescriptor,
  type DenialEvent,
  type EnforcementPosition,
  type GrantProfileName,
  type SubstrateRepoRef,
} from "@fractalboxdev/flare-dispatch-substrate-contract";
import {
  CONTAINER_AUTHORED_AUTH_HEADERS,
  resolveCredential,
  type SecretResolver,
} from "./credentials";
import {
  BODYLESS,
  grantPolicy,
  METHODS,
  selectionProblem,
  type EgressPolicy,
  type GrantParams,
  type PathRule,
} from "./profiles";

// The catalog is next door (profiles.ts) — the vocabulary is re-exported here
// so the fence, the DO and the tests keep one import site for "what a grant is
// made of", while the file that decides it stays reviewable on its own.
export {
  BODYLESS,
  GRANT_PROFILES,
  grantPolicy,
  isProfileName,
  METHODS,
  POST_SINK_NOTE,
  PROFILE_NAMES,
  profilesFor,
  publicRepoPolicy,
  selectionProblem,
  WRITE_SINKS,
  type EgressPolicy,
  type GrantParams,
  type GrantProfile,
  type HostPolicy,
  type HttpMethod,
  type PathRule,
} from "./profiles";

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

const MAX_REDIRECTS = 5;

export type Decision =
  | { ok: true }
  | { ok: false; reason: string };

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

/**
 * The two calls that admit a host and the two that map a handler, plus the
 * denies. Kept as data so the caller's `finally` can reverse exactly what it
 * applied, and so a grant is reviewable in a test rather than only in a log.
 */
export type Grant = {
  /** Which floor this grant carries. `enforce` is the only one that refuses anything. */
  position: EnforcementPosition;
  /**
   * Concrete hostnames, never globs — except the single `*` an open posture
   * admits, which is the whole point of that posture. Under `enforce` a glob
   * admits hosts no handler is mapped to, and precedence ends in public egress:
   * the admitted host would get a direct, uninspected fetch.
   */
  allow: string[];
  deny: string[];
  handlers: { host: string; method: keyof typeof egressHandlers; params: GrantParams }[];
  /**
   * The catch-all handler an open posture maps, so that a request to a host no
   * profile names still reaches the engine and can be recorded. Only `report`
   * sets one — `legacy` records nothing by definition, and `enforce` needs no
   * catch-all because an unadmitted host never gets that far.
   */
  catchAll?: { method: keyof typeof egressHandlers; params: GrantParams };
};

/** The host pattern an open (legacy / report) posture admits. Matches every hostname. */
export const OPEN_HOST = "*";

/**
 * Build the grant for a recipe's selected profiles, refusing any grant that
 * would admit a host it does not also inspect.
 *
 * Three shapes, one per rollout position (ADR-0005):
 *
 * - `enforce` — the composed profile hosts, each with its handler, plus the
 *   deny floor. Anything else dies at the container's allowlist.
 * - `report` — every host admitted and a catch-all handler mapped, so the
 *   engine sees each request, records what it *would* have refused, and
 *   forwards it anyway. Same reachability as `legacy`, plus the audit trail
 *   that makes authoring a profile possible.
 *
 *   The wildcard is not a convenience, it is the whole mechanism. `ContainerProxy`
 *   gates on `allowedHosts` **strictly before** it consults any handler
 *   (`@cloudflare/containers@0.3.7`, `container.js:209`) and answers a bodyless
 *   520 for a host that misses — so a report grant that kept the enforce host
 *   set would be blind to exactly the finding it exists to produce: the host no
 *   profile names. `OPEN_HOST` admits everything so that every request reaches
 *   the engine and gets decided.
 *
 *   Note the matcher asymmetry this depends on. The platform's `simpleGlobMatch`
 *   treats `*` as any substring, so `"*"` matches `registry.npmjs.org`; this
 *   module's own `hostMatches` treats `*` as exactly one label and would NOT.
 *   That divergence is deliberate — ours only ever re-checks the deny list,
 *   where narrower is the safe direction — but it means `OPEN_HOST` is a claim
 *   about the platform matcher, not about this file's. Neither should be
 *   "fixed" to agree with the other.
 * - `legacy` — every host admitted, nothing mapped, nothing recorded. The
 *   pre-adoption posture, kept only so a run can move onto the substrate
 *   without its egress changing on the same day.
 *
 * The deny list is empty in both open postures on purpose: a deny there is a
 * bodyless 520 the engine never sees, which is exactly the undiagnosable
 * failure the report position exists to replace. Neither posture is weaker than
 * what the run had before it moved.
 *
 * What a report window still cannot see: traffic the container runtime does not
 * route through the proxy at all. `interceptHttps` is `false` by default in
 * `@cloudflare/containers` and the substrate's DO does not set it, so HTTPS
 * interception is an open question about platform behaviour rather than a
 * setting this module controls — and it cuts both ways, because unrouted
 * traffic is equally invisible to `enforce`. A clean report window is evidence
 * about the traffic the engine observed, never a proof about all of it.
 *
 * @throws if the admitted set and the handled set differ under `enforce`, if a
 * selection cannot be served, or if the repo slug is not `owner/name`.
 */
export function buildGrant(params: GrantParams): Grant {
  if (!params.containerId)
    throw new Error("egress: refusing a grant with no containerId to bind to");

  const position = params.position ?? "enforce";

  // Validate the selection in every position — a run must not discover its
  // profile set is unservable on the day it graduates to `enforce`.
  const problem = selectionProblem(params);
  if (problem) throw new Error(`egress: ${problem}`);

  if (position !== "enforce") {
    return {
      position,
      allow: [OPEN_HOST],
      deny: [],
      handlers: [],
      ...(position === "report" ? { catchAll: { method: "reportOnly" as const, params } } : {}),
    };
  }

  if (!/^[\w.-]+\/[\w.-]+$/.test(params.repo))
    throw new Error(`egress: refusing a grant for malformed repo ${JSON.stringify(params.repo)}`);

  const policy = grantPolicy(params);
  const allow = policy.hosts.map((h) => h.host);
  const handlers = allow.map((host) => ({
    host,
    method: "granted" as const,
    params,
  }));

  const admitted = new Set(allow);
  const handled = new Set(handlers.map((h) => h.host));
  if (admitted.size !== handled.size || [...admitted].some((h) => !handled.has(h)))
    throw new Error("egress: grant would admit a host with no handler");

  return { position, allow, deny: [...policy.deny], handlers };
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
  /**
   * The catch-all handler. The SDK offers no removal call for it, which is why
   * `revokeGrant` re-points it at `denyAll` rather than clearing it — see there.
   */
  setOutboundHandler(methodName: string, params?: GrantParams): Promise<void>;
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
  for (const h of grant.handlers) await target.setOutboundByHost(h.host, h.method, h.params);
  if (grant.catchAll) await target.setOutboundHandler(grant.catchAll.method, grant.catchAll.params);
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
  if (grant.catchAll) await attempt(() => target.setOutboundHandler("denyAll"));

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
): Decision & { rule?: PathRule; credential?: CredentialDescriptor } {
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
  if (!(METHODS as readonly string[]).includes(effective))
    return { ok: false, reason: `method ${m} is not permitted` };

  // Deny-by-default: the method union is wide, the rules are not. A host whose
  // policy names only GET rules refuses a PUT here with no rule to match.
  const rule = hostPolicy.rules.find((r) => r.method === effective && r.match(url));
  if (!rule)
    return {
      ok: false,
      reason: `${m} ${url.pathname} is outside the grant for ${policy.repo}`,
    };

  // The credential belongs to the host that matched, not to the policy: a
  // redirect onto a different admitted host re-enters `decide` and gets that
  // host's descriptor, or none at all.
  return { ok: true, rule, credential: hostPolicy.credential };
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

/**
 * The forwarded-header allowlist may never contain a header a container could
 * carry a credential in (ADR-0006). Asserted at module load rather than only in
 * a test: adding `authorization` to the list above would otherwise let a
 * container authenticate its own request on a credentialed host — and on a host
 * where the substrate injects nothing, forward whatever it invented.
 */
for (const banned of CONTAINER_AUTHORED_AUTH_HEADERS)
  if (FORWARDED_HEADERS.includes(banned))
    throw new Error(`egress: ${banned} must never be forwarded from a container`);

/** The prefix that separates an audit record from a refusal that actually happened. */
export const WOULD_DENY_PREFIX = "would-deny: ";

export type ServeDeps = {
  fetch: typeof fetch;
  /**
   * Denial recorder (ADR-0005): every handler 403 is reported here so the
   * substrate can aggregate `{host, method, path, reason, count}` per
   * execution. Fire-and-forget — recording must never delay or fail a denial.
   */
  recordDenial?: (event: Omit<DenialEvent, "count">) => void;
  /**
   * Reads one of the substrate Worker's own secret bindings (ADR-0006). Present
   * only where a credentialed profile can be granted; absent, a request that
   * needs a credential is refused rather than sent bare. The value never
   * crosses back into the container — it is written straight onto the outbound
   * request's headers.
   */
  resolveSecret?: SecretResolver;
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
  const record = (reason: string, at?: URL): void => {
    try {
      const target = at ?? new URL(req.url);
      deps.recordDenial?.({
        host: target.hostname,
        method: req.method.toUpperCase(),
        path: target.pathname,
        reason,
      });
    } catch {
      // An unparseable URL still gets its response below.
    }
  };

  const denied = (reason: string, at?: URL): Response => {
    // The record carries the request; the body names only the rule, so a
    // hostile process cannot use 403 text as an oracle for what else it could
    // have reached.
    record(reason, at);
    return new Response(`egress denied: ${reason}\n`, {
      status: 403,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  };

  // No params means no grant was issued for this host — the handler was
  // reached through a class-level mapping or a stale override. Fail closed.
  const params = ctx.params;
  // An open posture carries no repo (it asserts no path rules), so the presence
  // of a grant is `containerId` — the field every grant has and no stale
  // class-level mapping does.
  if (!params || !params.containerId) return denied("no grant is bound to this request");
  if (!params.repo && (params.position ?? "enforce") === "enforce")
    return denied("no grant is bound to this request");

  if (ctx.containerId !== params.containerId)
    return denied("grant was issued to a different container");

  const position = params.position ?? "enforce";

  let policy: EgressPolicy;
  try {
    policy = grantPolicy(params);
  } catch {
    // A catalog conflict (two profiles, one host, different secrets) lands
    // here as well as a malformed slug. Both are refusals, not fallbacks.
    return denied("grant params are malformed");
  }

  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    return denied("unparseable request url");
  }

  const first = decide(policy, req.method, url);

  // The report position: decide, record what enforcement WOULD have refused,
  // then hand the request on untouched. Untouched is the point — a report run
  // must behave exactly as it did before it moved, or the window it is being
  // watched through is not the behaviour being graduated. Nothing here injects
  // a credential either: an unenforced grant must never be the path on which a
  // secret first reaches a host (ADR-0006).
  if (position === "report") {
    if (!first.ok) record(`${WOULD_DENY_PREFIX}${first.reason}`, url);
    return deps.fetch(req);
  }

  if (!first.ok) return denied(first.reason, url);

  // Buffer once: the body is needed for the cap, for the LFS assertion, and
  // again if a 307/308 preserves the method across hosts.
  let body: ArrayBuffer | undefined;
  if (!(BODYLESS as readonly string[]).includes(req.method.toUpperCase())) {
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
  let credential = first.credential;

  for (let hop = 0; ; hop++) {
    if (hop > MAX_REDIRECTS) return denied("too many redirects", target);

    // Attach the credential for THIS hop's host, after the container's own
    // headers have been filtered out (ADR-0006). Nothing accumulates across
    // hops: `credential` is re-read from each hop's decision, so a redirect off
    // a credentialed host leaves the header behind.
    const outbound = forwardedHeaders(req.headers);
    if (credential) {
      const resolved = deps.resolveSecret
        ? resolveCredential(credential, deps.resolveSecret)
        : ({ ok: false, reason: "no secret resolver is wired" } as const);
      // Fail closed. Sending the request bare would authenticate as nobody and
      // surface as a 401 deep in a build log; the refusal names the missing
      // binding to the operator through the denial record instead.
      if (!resolved.ok) return denied(`credential unavailable: ${resolved.reason}`, target);
      outbound.set(resolved.header.name, resolved.header.value);
    }

    const upstream = await deps.fetch(target.toString(), {
      method,
      headers: outbound,
      body: (BODYLESS as readonly string[]).includes(method) ? undefined : payload,
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

    if (
      payload &&
      !(BODYLESS as readonly string[]).includes(method) &&
      payload.byteLength > (onward.rule?.maxBodyBytes ?? 0)
    )
      return denied("redirect would replay a body over the target's cap", next);

    target = next;
    // Re-read rather than carry: a 307 from a credentialed host to an admitted
    // uncredentialed one must not replay the injected header at the new host.
    credential = onward.credential;
  }
}

/**
 * The named handlers a Sandbox class exposes as `static outboundHandlers`.
 * `setOutboundByHost(host, "publicRepo", params)` is what binds one to a grant;
 * nothing is mapped at class level, so an unbound call has no params and is
 * refused above. The DO layer (sandbox-do.ts) re-wraps these with the denial
 * recorder and the secret resolver wired to the Worker's environment.
 *
 * The name `publicRepo` is historical — one handler serves every profile, and
 * which hosts and credentials a call may reach is decided by the grant params
 * it was bound with, not by which handler name it resolved through. This bare
 * export has no secret resolver, so a credentialed host refuses here: only the
 * DO layer's wrapper can inject.
 */
export const egressHandlers = {
  granted: (req: Request, _env: unknown, ctx: OutboundContext<GrantParams>): Promise<Response> =>
    serveGrantedRequest(req, ctx, { fetch }),
  reportOnly: (req: Request, _env: unknown, ctx: OutboundContext<GrantParams>): Promise<Response> =>
    serveGrantedRequest(req, ctx, { fetch }),
  denyAll: (): Response =>
    new Response("egress denied: no grant is open\n", {
      status: 403,
      headers: { "content-type": "text/plain; charset=utf-8" },
    }),
};

/** Convenience for callers holding a repo ref rather than a slug. */
export function grantParamsFor(
  repo: SubstrateRepoRef | undefined,
  containerId: string,
  opts: {
    lfs?: boolean;
    profiles?: readonly GrantProfileName[];
    targets?: readonly string[];
    position?: EnforcementPosition;
  } = {},
): GrantParams {
  return {
    repo: repo ? repoSlug(repo) : "",
    containerId,
    lfs: opts.lfs,
    profiles: opts.profiles,
    targets: opts.targets,
    position: opts.position,
  };
}
