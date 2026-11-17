// The paths of the dispatcher's hostname as Cloudflare Access must see them (FD-OPS-088). The Access applications on
// the hostname are managed outside FlareDispatch: they list the human-facing paths, and every other path stays
// uncovered, because an application on the bare hostname covers every path below it. `fd deploy` and `fd doctor` read
// the account's applications and check them against these lists; neither writes an Access application.

/** A path pattern of the dispatcher's hostname, the surface it serves and the identity check the dispatcher runs on it. */
export interface SurfacePath {
  readonly path: string;
  readonly surface: string;
  readonly identity: string;
}

/**
 * The machine paths: every path whose surface in specs/interfaces.md § Surfaces and their identity gates names an
 * identity other than the Access JWT alone. Each must be reachable without Access; the dispatcher runs the identity
 * check itself.
 */
export const MACHINE_PATHS: readonly SurfacePath[] = [
  { path: "/health", surface: "health", identity: "none" },
  { path: "/.well-known/*", surface: "well-known", identity: "none" },
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
  {
    path: "/v1/executions",
    surface: "executions list",
    identity: "control-plane read token, or Access JWT",
  },
  {
    path: "/v1/logs/*",
    surface: "log",
    identity: "link token, control-plane read token for the aggregate, or Access JWT",
  },
  { path: "/v1/artifacts/*", surface: "artifact", identity: "link token, or Access JWT" },
  { path: "/v1/compile-cache/*", surface: "compile-cache", identity: "compile-cache token" },
  { path: "/v1/deploy-claims/*", surface: "deploy-claim", identity: "deploy-claim token" },
  {
    path: "/v1/model/completions",
    surface: "model-gateway",
    identity: "per-lease token, or capacity-lease proof",
  },
  {
    path: "/v1/provenance/executions/*",
    surface: "provenance executions",
    identity: "none for public repositories, Access JWT otherwise",
  },
  {
    path: "/v1/provenance/subjects/*",
    surface: "provenance subjects",
    identity: "none for public repositories, Access JWT otherwise",
  },
];

/** The human-facing paths: each must be covered by an Access application whose AUD tag is the overlay's `access.aud`. */
export const HUMAN_PATHS: readonly SurfacePath[] = [
  { path: "/dashboard", surface: "dashboard", identity: "Access JWT" },
  { path: "/dashboard/*", surface: "dashboard", identity: "Access JWT" },
  {
    path: "/v1/executions/*",
    surface: "execution",
    identity: "Access JWT: one execution, its failure summary, cancel and its artifacts list",
  },
  { path: "/v1/executors/register", surface: "executor register", identity: "Access JWT" },
  { path: "/v1/ops/*", surface: "operator routes", identity: "Access JWT" },
  { path: "/v1/spend", surface: "spend", identity: "Access JWT" },
  { path: "/v1/github/install/*", surface: "GitHub App install", identity: "Access JWT" },
  { path: "/v1/provenance-policy", surface: "provenance policy", identity: "Access JWT" },
  { path: "/v1/provenance-policy/*", surface: "provenance policy", identity: "Access JWT" },
  { path: "/v1/provenance/log/*", surface: "provenance log", identity: "Access JWT" },
  { path: "/mcp", surface: "mcp", identity: "Access JWT" },
];

/**
 * Whether a path pattern of `MACHINE_PATHS` or `HUMAN_PATHS`, where `*` stands for one segment and anything below it,
 * matches a request path.
 */
export const pathMatches = (pattern: string, path: string): boolean =>
  new RegExp(
    `^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]+(?:/.*)?")}$`,
  ).test(path);

/** Whether a request path is a machine path, which Access must leave uncovered. */
export const isMachinePath = (path: string): boolean =>
  MACHINE_PATHS.some((m) => pathMatches(m.path, path));

/** One concrete request path under a pattern: each `*` stands for the segment `x`. */
export const samplePath = (pattern: string): string => pattern.replace(/\*/g, "x");

/**
 * Whether an Access application's path covers a request path, as Cloudflare Access matches it: an empty path, `/` or
 * `/*` covers the hostname and every path on it; any other path covers the request paths it matches and every path
 * below one of them. A trailing `/*` does not cover its parent path.
 */
export const accessCovers = (appPath: string, path: string): boolean => {
  if (appPath === "" || appPath === "/" || appPath === "/*") return true;
  const segments = path.split("/");
  for (let i = segments.length; i > 1; i--)
    if (pathMatches(appPath, segments.slice(0, i).join("/"))) return true;
  return false;
};

/** The Access expectations for an overlay: none when it names no dispatcher hostname. */
export interface DispatcherAccess {
  readonly hostname: string;
  /** The overlay's `access.aud`: the AUD tag the dispatcher checks Access JWTs against (FD-OPS-064). */
  readonly aud: string;
}

/** The hostname and AUD tag `fd deploy` and `fd doctor` check the account's Access applications against. */
export const dispatcherAccess = (overlay: {
  readonly hostnames: Readonly<Record<string, string>>;
  readonly access: { readonly aud: string };
}): DispatcherAccess | null => {
  const hostname = overlay.hostnames["dispatcher"];
  return hostname === undefined ? null : { hostname, aud: overlay.access.aud };
};

/** An Access application as the Cloudflare API lists it: the fields the check reads. */
export interface DeployedAccessApplication {
  readonly id: string;
  /** The AUD tag Cloudflare gives the application when it creates it. */
  readonly aud?: string;
  readonly name?: string;
  readonly type?: string;
  /** The primary destination: a hostname, and optionally a path on it. */
  readonly domain?: string;
  readonly self_hosted_domains?: readonly string[];
  readonly destinations?: readonly { readonly type?: string; readonly uri?: string }[];
  readonly policies?: readonly {
    readonly name?: string;
    readonly decision?: string;
    readonly include?: readonly unknown[];
  }[];
}

/**
 * Whether an application's hostname covers the dispatcher's: equal, ignoring case, or a `*.` wildcard that stands for
 * exactly the first label.
 */
const hostCovers = (appHost: string, hostname: string): boolean => {
  const a = appHost.toLowerCase();
  const h = hostname.toLowerCase();
  if (a === h) return true;
  if (!a.startsWith("*.")) return false;
  const dot = h.indexOf(".");
  return dot > 0 && h.slice(dot + 1) === a.slice(2);
};

/**
 * The paths an application covers on the dispatcher's hostname, one per destination there: its `domain`, its
 * `self_hosted_domains` and its public `destinations`. An empty path is the bare hostname.
 */
export const accessPathsOn = (
  hostname: string,
  app: DeployedAccessApplication,
): readonly string[] => {
  const uris = new Set([
    ...(app.domain === undefined ? [] : [app.domain]),
    ...(app.self_hosted_domains ?? []),
    ...(app.destinations ?? [])
      .filter((d) => d.type === undefined || d.type === "public")
      .flatMap((d) => (d.uri === undefined ? [] : [d.uri])),
  ]);
  return [...uris].flatMap((uri) => {
    const bare = uri.replace(/^https?:\/\//, "");
    const slash = bare.indexOf("/");
    const host = slash < 0 ? bare : bare.slice(0, slash);
    return hostCovers(host, hostname) ? [slash < 0 ? "" : bare.slice(slash)] : [];
  });
};

/** Whether an application lets a request through without an Access login: it holds a bypass policy. */
export const bypasses = (app: DeployedAccessApplication): boolean =>
  (app.policies ?? []).some((p) => p.decision === "bypass");

/** An application path's specificity: its segments, then its literal characters; the bare hostname is the least. */
const specificity = (appPath: string): readonly [number, number] => {
  const trimmed = appPath === "/*" || appPath === "/" ? "" : appPath;
  return [trimmed.split("/").length - 1, trimmed.replace(/\*/g, "").length];
};

/**
 * The applications that decide a request path on the hostname: of the applications whose paths cover it, those with
 * the most specific covering path, which Cloudflare Access applies over any less specific one. Empty where none covers it.
 */
export const decidingApplications = (
  hostname: string,
  apps: readonly DeployedAccessApplication[],
  path: string,
): readonly DeployedAccessApplication[] => {
  let best: readonly [number, number] | null = null;
  let deciding: DeployedAccessApplication[] = [];
  for (const app of apps) {
    const covering = accessPathsOn(hostname, app).filter((p) => accessCovers(p, path));
    if (covering.length === 0) continue;
    const s = covering
      .map(specificity)
      .reduce((a, b) => (b[0] > a[0] || (b[0] === a[0] && b[1] > a[1]) ? b : a));
    const order = best === null ? 1 : s[0] - best[0] || s[1] - best[1];
    if (order > 0) {
      best = s;
      deciding = [app];
    } else if (order === 0) deciding.push(app);
  }
  return deciding;
};
