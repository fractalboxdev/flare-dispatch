// Classifying the denials the egress handler never sees
// (specs/adr/0005-deny-all-egress-with-grant-profiles.md).
//
// Handler 403s are recorded by `serveGrantedRequest`, but they are only half the
// denial set. `@cloudflare/containers@0.3.7` evaluates outbound requests in a
// fixed order (`ContainerProxy.fetch`, container.js:196-263):
//
//   1. `deniedHosts` match       → 520 "Origin is disallowed"
//   2. `allowedHosts` non-match  → 520 "Origin is disallowed"
//   3. `outboundByHost` override → the substrate's `publicRepo` handler
//   4. `outboundByHost` static   → (the substrate maps none at class level)
//   5-8. catch-all / fallthrough → unreachable while `allowedHosts` is set
//
// Steps 1 and 2 answer before any handler is consulted, and a bodyless 520 is
// all that survives the request — which is what made unlisted hosts
// undiagnosable, and what stops `report` mode (legacy → report → enforce) from
// seeing the set of hosts a run would have needed. A catch-all `static outbound`
// handler does not reach them either: it sits at step 6, behind the gate that
// already answered.
//
// Pure, like the rest of `engine/` — the proxy that calls this
// (`../outbound-proxy.ts`) is where the Cloudflare imports live.
import type { DenialEvent } from "@fractalboxdev/flare-dispatch-substrate-contract";
import { hostMatches } from "./egress";

/**
 * The props `Container.applyOutboundInterception` freezes into the proxy fetcher
 * (container.js:1185-1194). Declared structurally — the SDK exports no type for
 * it, and a phantom import for five fields is worse than this.
 */
export type ProxyProps = {
  containerId?: string;
  className?: string;
  allowedHosts?: string[];
  deniedHosts?: string[];
  outboundByHostOverrides?: Record<string, { method: string; params?: unknown }>;
};

/** What the container runtime answers with when a gate refuses a host. */
export const PLATFORM_DENIAL_STATUS = 520;

export type PlatformDenial = Omit<DenialEvent, "count">;

/**
 * Classify one proxied response as a platform denial, or not.
 *
 * A 520 alone is not enough: `serveGrantedRequest` proxies upstream responses
 * verbatim, so a genuine 520 from github.com would otherwise be recorded as if
 * the platform had refused it. The discriminator is whether a handler was mapped
 * for the hostname — if one was, the response came through it (and a handler
 * denial is already recorded there as a 403); if none was, the request cannot
 * have reached step 3 or 4, so a 520 can only be the deny/allow gate.
 *
 * The reason re-derives *which* gate answered from the same two lists the proxy
 * was handed. That is description, not a second decision: nothing here can admit
 * or refuse anything.
 *
 * Residual: matching uses `hostMatches`, which is anchored and consumes one
 * label per `*`, while the SDK's glob is looser. Grants only ever admit concrete
 * hostnames (`buildGrant` refuses anything else) and the write-sink deny list
 * holds none, so the two agree on every set the substrate issues today; a future
 * glob could make this over-report an upstream 520 as a platform denial, which
 * costs an audit row and no enforcement.
 */
export function classifyPlatformDenial(
  props: ProxyProps,
  request: { method: string; url: string },
  status: number,
): PlatformDenial | undefined {
  if (status !== PLATFORM_DENIAL_STATUS) return undefined;

  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return undefined;
  }

  const host = url.hostname;
  const overrides = props.outboundByHostOverrides ?? {};
  if (Object.keys(overrides).some((pattern) => hostMatches(pattern, host))) return undefined;

  const denied = (props.deniedHosts ?? []).some((pattern) => hostMatches(pattern, host));
  return {
    host,
    method: request.method.toUpperCase(),
    path: url.pathname,
    reason: denied
      ? `host ${host} is a denied write sink (refused by the container gate)`
      : `host ${host} is not admitted (refused by the container gate)`,
  };
}
