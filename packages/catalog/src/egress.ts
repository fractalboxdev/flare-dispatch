// Egress-attached grants (specs/isolation-egress.md): a job reaches a credentialed service only through the egress
// proxy, which adds the credential to a request for a granted host after the request leaves the job (FD-GATE-014,
// FD-GATE-066). This module is the proxy's decision; the control plane's `ContainerProxy` export calls
// `attachGrants` on each intercepted request, and log upload calls `redactLog`.

/** One grant: the hosts it covers and the header the proxy sets on a request to them. */
export interface GrantRule {
  readonly hosts: readonly string[];
  readonly header: "authorization";
  /** The header's value for a resolved secret. */
  readonly value: (secret: string) => string;
}

/** The grants gate recipes name. `cf-api` is the Cloudflare API under the deploying operator's API token. */
export const GATE_GRANTS: Readonly<Record<string, GrantRule>> = {
  "cf-api": {
    hosts: ["api.cloudflare.com"],
    header: "authorization",
    value: (secret) => `Bearer ${secret}`,
  },
};

/**
 * The job's value for a granted credential's environment variable. Tools such as `wrangler` refuse to start without
 * one; the proxy replaces the header the placeholder produces, so the real credential never enters the job.
 */
export const CREDENTIAL_PLACEHOLDER = "fd-egress-attached";

/** Headers a job may author that carry a credential; the proxy drops them before it attaches its own. */
const JOB_AUTH_HEADERS = ["authorization", "proxy-authorization", "x-auth-key", "x-auth-email"];

export const normalizeHost = (host: string): string => {
  let h = host.trim().toLowerCase();
  const lastColon = h.lastIndexOf(":");
  if (lastColon > h.lastIndexOf("]")) h = h.slice(0, lastColon);
  return h.endsWith(".") ? h.slice(0, -1) : h;
};

/**
 * Host glob matching, anchored at both ends: a pattern with no `*` is exact, and `*` matches exactly one label, so
 * `evilcloudflare.com` cannot spoof `*.cloudflare.com`.
 */
export const hostMatches = (pattern: string, host: string): boolean => {
  const p = normalizeHost(pattern);
  const h = normalizeHost(host);
  if (p === "" || h === "") return false;
  if (!p.includes("*")) return p === h;
  const source = p
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^.]+");
  return new RegExp(`^${source}$`).test(h);
};

/**
 * The request as it leaves the proxy: job-authored credential headers removed, and the credential of the first grant
 * that covers the host attached. A grant attaches only over HTTPS. `resolve` answers a grant's secret, or `undefined`
 * where the deploy holds none, in which case the request leaves with no credential.
 */
export const attachGrants = (
  request: Request,
  grants: readonly string[],
  resolve: (grant: string) => string | undefined,
): Request => {
  const url = new URL(request.url);
  const headers = new Headers(request.headers);
  for (const name of JOB_AUTH_HEADERS) headers.delete(name);
  if (url.protocol === "https:") {
    for (const grant of grants) {
      const rule = GATE_GRANTS[grant];
      if (rule === undefined || !rule.hosts.some((h) => hostMatches(h, url.hostname))) continue;
      const secret = resolve(grant);
      if (secret !== undefined) headers.set(rule.header, rule.value(secret));
      break;
    }
  }
  return new Request(request, { headers });
};

/** Token shapes a log must not carry, whatever wrote them. */
const TOKEN_PATTERNS: readonly RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\b(Bearer|token)\s+[A-Za-z0-9._~+/-]{16,}=*/gi,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /(https?:\/\/)[^\s/@:]+:[^\s/@]+@/g,
];

/** A log with every known secret value and every token shape replaced by `[redacted]`. */
export const redactLog = (text: string, secrets: readonly string[] = []): string => {
  let out = text;
  for (const secret of secrets) if (secret.length >= 8) out = out.split(secret).join("[redacted]");
  for (const pattern of TOKEN_PATTERNS)
    out = out.replace(pattern, (match, prefix: unknown) =>
      typeof prefix === "string" && prefix.startsWith("http")
        ? `${prefix}[redacted]@`
        : "[redacted]",
    );
  return out;
};
