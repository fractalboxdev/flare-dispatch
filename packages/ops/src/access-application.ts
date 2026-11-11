// The committed Cloudflare Access configuration of the dispatcher's hostname (FD-OPS-088): one self-hosted application
// on the hostname, and a bypass application on every path whose surface specs/interfaces.md gives an identity other
// than the Access JWT alone. The dispatcher runs each bypassed surface's identity check itself. `fd deploy` applies
// these applications after the Worker deploys and before the probes; `fd doctor` reports each difference.

/** A bypassed path, the surface it serves and the identity check the dispatcher runs on it. */
export interface BypassPath {
  readonly path: string;
  readonly surface: string;
  readonly identity: string;
}

/** Every path Access bypasses, from specs/interfaces.md § Surfaces and their identity gates. */
export const ACCESS_BYPASS: readonly BypassPath[] = [
  { path: "/v1/webhooks/github", surface: "webhook", identity: "HMAC-SHA256 over the raw body" },
  {
    path: "/v1/dispatch/*",
    surface: "dispatch",
    identity: "Actions OIDC token, or an Access JWT of a listed dispatcher",
  },
  {
    path: "/v1/executors/connect",
    surface: "executor connect",
    identity: "connect signature by the device key",
  },
  { path: "/health", surface: "health", identity: "none" },
  { path: "/.well-known/*", surface: "well-known", identity: "none" },
  {
    path: "/v1/executions/*/logs",
    surface: "log aggregate",
    identity: "link token, or Access JWT",
  },
  { path: "/v1/executions/*/logs/*", surface: "log", identity: "link token, or Access JWT" },
  { path: "/v1/artifacts/*", surface: "artifact", identity: "link token, or Access JWT" },
  { path: "/v1/compile-cache/*", surface: "compile-cache", identity: "compile-cache token" },
  {
    path: "/v1/model/completions",
    surface: "model-gateway",
    identity: "per-lease token, or capacity-lease proof",
  },
  {
    path: "/v1/provenance/*",
    surface: "provenance",
    identity: "none for public repositories, Access JWT otherwise",
  },
];

/** One Access application as the Cloudflare API's `POST /accounts/{account}/access/apps` takes it. */
export interface AccessApplication {
  readonly name: string;
  readonly type: "self_hosted";
  readonly domain: string;
  readonly session_duration: string;
  readonly policies: readonly {
    readonly name: string;
    readonly decision: "allow" | "bypass";
    readonly include: readonly unknown[];
  }[];
}

/**
 * The applications for the dispatcher's hostname: the hostname behind Access for the overlay's operators and
 * dispatchers, and each bypass path with a bypass policy for everyone, which Access matches before the hostname.
 */
export const accessApplications = (
  hostname: string,
  identities: readonly string[],
): readonly AccessApplication[] => [
  {
    name: "flare-dispatch",
    type: "self_hosted",
    domain: hostname,
    session_duration: "24h",
    policies: [
      {
        name: "identities",
        decision: "allow",
        include: identities.map((email) => ({ email: { email } })),
      },
    ],
  },
  ...ACCESS_BYPASS.map((b): AccessApplication => ({
    name: `flare-dispatch ${b.surface}`,
    type: "self_hosted",
    domain: `${hostname}${b.path}`,
    session_duration: "24h",
    policies: [{ name: "bypass", decision: "bypass", include: [{ everyone: {} }] }],
  })),
];

/** Whether an Access path pattern, where `*` stands for one segment and anything below it, covers a request path. */
export const pathMatches = (pattern: string, path: string): boolean =>
  new RegExp(
    `^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]+(?:/.*)?")}$`,
  ).test(path);

/** Whether Access bypasses a request path. */
export const bypassed = (path: string): boolean =>
  ACCESS_BYPASS.some((b) => pathMatches(b.path, path));

/** The committed applications for an overlay: none when it names no dispatcher hostname. */
export interface CommittedAccess {
  readonly hostname: string;
  readonly applications: readonly AccessApplication[];
}

/**
 * The Access configuration `fd deploy` applies and `fd doctor` checks: the dispatcher's hostname behind Access for the
 * overlay's `operators` and `dispatchers`, and each path of `ACCESS_BYPASS` with a bypass policy.
 */
export const committedAccess = (overlay: {
  readonly hostnames: Readonly<Record<string, string>>;
  readonly operators: readonly string[];
  readonly dispatchers?: readonly string[] | undefined;
}): CommittedAccess | null => {
  const hostname = overlay.hostnames["dispatcher"];
  if (hostname === undefined) return null;
  const identities = [...new Set([...overlay.operators, ...(overlay.dispatchers ?? [])])];
  return { hostname, applications: accessApplications(hostname, identities) };
};

/** An Access application as the Cloudflare API lists it: the committed fields, its id and whatever else it holds. */
export interface DeployedAccessApplication {
  readonly id: string;
  readonly name?: string;
  readonly type?: string;
  readonly domain?: string;
  readonly session_duration?: string;
  readonly policies?: readonly {
    readonly name?: string;
    readonly decision?: string;
    readonly include?: readonly unknown[];
  }[];
}

/** Whether an application's domain is the dispatcher's hostname or a path on it. */
export const onHostname = (hostname: string, domain: string | undefined): boolean =>
  domain === hostname || domain?.startsWith(`${hostname}/`) === true;

/** The fields `fd` owns of an application, as one comparable value: the API's ids, precedence and dates dropped. */
export const accessShape = (app: AccessApplication | DeployedAccessApplication) => ({
  name: app.name ?? null,
  type: app.type ?? null,
  domain: app.domain ?? null,
  session_duration: app.session_duration ?? null,
  policies: (app.policies ?? []).map((p) => ({
    name: p.name ?? null,
    decision: p.decision ?? null,
    include: p.include ?? [],
  })),
});

/** What makes the account's applications on the hostname the committed ones. */
export interface AccessChanges {
  readonly create: readonly AccessApplication[];
  readonly update: readonly { readonly id: string; readonly application: AccessApplication }[];
  /** Applications on the hostname the committed configuration does not hold. */
  readonly remove: readonly { readonly id: string; readonly domain: string }[];
}

/**
 * The changes from the deployed applications to the committed ones, matched by domain: a committed application absent
 * from the account is created, one that differs is replaced, and one on the hostname that is not committed is removed.
 * Applications on any other hostname are not the dispatcher's and are left alone.
 */
export const accessChanges = (
  committed: CommittedAccess,
  deployed: readonly DeployedAccessApplication[],
): AccessChanges => {
  const ours = deployed.filter((d) => onHostname(committed.hostname, d.domain));
  const byDomain = new Map(ours.map((d) => [d.domain!, d]));
  const wanted = new Set(committed.applications.map((a) => a.domain));
  const create: AccessApplication[] = [];
  const update: { id: string; application: AccessApplication }[] = [];
  for (const application of committed.applications) {
    const live = byDomain.get(application.domain);
    if (live === undefined) create.push(application);
    else if (JSON.stringify(accessShape(live)) !== JSON.stringify(accessShape(application)))
      update.push({ id: live.id, application });
  }
  return {
    create,
    update,
    remove: ours
      .filter((d) => !wanted.has(d.domain!))
      .map((d) => ({ id: d.id, domain: d.domain! })),
  };
};
