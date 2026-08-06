// The SDK-pin canary's probe: what runs inside the container, and how its
// output is read (specs/adr/0011-sdk-pin-as-security-surface.md).
//
// The deny-all posture is not a property of our code — it is a property of
// `@cloudflare/containers@0.3.7` internals that our class configuration
// engages. `allowedHosts = []` turns interception ON because
// `shouldInterceptAllOutbound()` tests `effectiveAllowedHosts !== undefined`,
// and `ContainerProxy.fetch` then answers **520 "Origin is disallowed"** for
// every hostname before any handler is consulted (`container.js:209-211`). A
// version bump that changes either half fails toward open egress, silently.
// Unit tests cannot see this: they exercise our policy engine, not the SDK's
// interception. Only a real container fetch can.
//
// So the canary asserts the one fact the unit suite structurally cannot: from
// inside a live container with no grant applied, a request to a host nobody
// admitted comes back **520**, not 200.
//
// The distinction between 520 and "the request failed" is the entire point and
// is why the probe reads the status code rather than the exit code. A container
// with no network at all also fails to reach the host — and would pass a test
// that only asked "did it fail?" while proving nothing about interception. 520
// is positive evidence that the proxy is in the path and denying; a transport
// error is merely an absence of evidence, and is reported as inconclusive.
//
// Pure: no Cloudflare imports, no I/O. Tested in probe.test.ts.

/**
 * IANA-reserved and deliberately boring. The probe host must be one that
 * *would* answer 200 if egress were open — a host that does not resolve fails
 * identically under a broken gate and a working one, which would make the
 * canary unable to detect the failure it exists for.
 */
export const CANARY_PROBE_HOST_DEFAULT = "example.com";

/** The status `ContainerProxy` answers for an unlisted host. */
export const DENIED_STATUS = 520;

/** Field separator for the probe's own output lines; stripped from captured text. */
const FIELD = "|";

/**
 * Hostnames only — the value reaches a shell script as an interpolated string,
 * so anything that is not a plain DNS label sequence is rejected rather than
 * escaped. A rejected override degrades to the default instead of failing the
 * canary: an operator typo must not read as a broken egress floor.
 */
export function resolveProbeHost(raw: string | undefined): string {
  const host = (raw ?? "").trim().toLowerCase();
  if (!host) return CANARY_PROBE_HOST_DEFAULT;
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host)
    ? host
    : CANARY_PROBE_HOST_DEFAULT;
}

/**
 * The script the container runs. Both schemes are probed because they fail
 * differently: plain HTTP is always proxied, while HTTPS additionally depends
 * on the image's TLS interception being wired — so an https-only probe could
 * report a TLS error on a container whose gate is working perfectly.
 *
 * Every step is failure-tolerant on purpose. A probe that aborts on the first
 * non-zero exit returns nothing, and "no output" is the one result that cannot
 * be interpreted.
 */
export function canaryProbeScript(host: string): string {
  return `set -u
probe() {
  url="$1"
  : > /tmp/canary-body
  : > /tmp/canary-err
  code=$(curl -sS -m 10 -o /tmp/canary-body -w '%{http_code}' "$url" 2>/tmp/canary-err) || code=""
  [ -n "$code" ] || code=000
  body=$(head -c 80 /tmp/canary-body | tr -d '\\r\\n${FIELD}')
  err=$(head -c 120 /tmp/canary-err | tr -d '\\r\\n${FIELD}')
  printf 'PROBE${FIELD}%s${FIELD}%s${FIELD}%s${FIELD}%s\\n' "$url" "$code" "$body" "$err"
}
probe "https://${host}/"
probe "http://${host}/"
printf 'PROBE-END\\n'
`;
}

export type ProbeLine = {
  url: string;
  /** HTTP status, or 0 when curl never got a response. */
  code: number;
  body: string;
  err: string;
};

export function parseProbeLines(output: string): ProbeLine[] {
  const lines: ProbeLine[] = [];
  for (const raw of output.split("\n")) {
    const parts = raw.trim().split(FIELD);
    if (parts.length !== 5 || parts[0] !== "PROBE") continue;
    const code = Number.parseInt(parts[2] ?? "", 10);
    lines.push({
      url: parts[1] ?? "",
      code: Number.isFinite(code) ? code : 0,
      body: parts[3] ?? "",
      err: parts[4] ?? "",
    });
  }
  return lines;
}

export type CanaryStatus = "passed" | "failed" | "inconclusive";

export type CanaryVerdict = {
  status: CanaryStatus;
  /** One line, safe to store and to show an operator. Never the raw log. */
  evidence: string;
};

/**
 * Read the probe's output into a verdict.
 *
 * `failed` is reserved for the direction ADR-0011 names as the worst one: a
 * request that got *through*. Anything that reached the host is a 2xx or a 3xx
 * — a redirect is a completed round trip to an unadmitted origin, so it counts
 * as reached, not as "not really data".
 *
 * `passed` requires a literal 520 from at least one scheme. The other scheme
 * failing at the transport is fine and expected on an image without TLS
 * interception; what matters is that one probe proves the proxy answered.
 *
 * Everything else is `inconclusive` — the canary could not observe the
 * invariant, which is neither a pass nor evidence of a breach. Callers treat it
 * as not-verified, so it fails closed at the gate without claiming a breach it
 * did not see.
 */
export function interpretCanary(input: { exitCode: number; output: string }): CanaryVerdict {
  const probes = parseProbeLines(input.output);
  if (probes.length === 0)
    return {
      status: "inconclusive",
      evidence: `probe produced no PROBE lines (command exit ${input.exitCode}) — the container ran but its output never arrived`,
    };

  const reached = probes.find((p) => p.code >= 200 && p.code < 400);
  if (reached)
    return {
      status: "failed",
      evidence: `${reached.url} answered HTTP ${reached.code} from inside a container with no grant — the deny-all gate is not engaged`,
    };

  const denied = probes.find((p) => p.code === DENIED_STATUS);
  if (denied)
    return {
      status: "passed",
      evidence: `${denied.url} → HTTP ${DENIED_STATUS}${denied.body ? ` "${denied.body}"` : ""} — interception engaged, unlisted host refused`,
    };

  const seen = probes.map((p) => `${p.url}→${p.code || "no-response"}`).join(", ");
  const firstErr = probes.find((p) => p.err)?.err;
  return {
    status: "inconclusive",
    evidence: `no probe returned ${DENIED_STATUS}; nothing reached the host either (${seen})${firstErr ? ` — ${firstErr}` : ""}`,
  };
}
