// The committed Cloudflare Access configuration of the dispatcher's hostname (FD-OPS-088): one self-hosted application
// on the hostname, and a bypass application on every path whose surface specs/interfaces.md gives an identity other
// than the Access JWT alone. The dispatcher runs each bypassed surface's identity check itself.

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

const matches = (pattern: string, path: string): boolean =>
  new RegExp(
    `^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]+(?:/.*)?")}$`,
  ).test(path);

/** Whether Access bypasses a request path. */
export const bypassed = (path: string): boolean => ACCESS_BYPASS.some((b) => matches(b.path, path));
