// The substrate's outbound proxy — where platform denials become records
// (specs/adr/0005-deny-all-egress-with-grant-profiles.md).
//
// `Container.applyOutboundInterception` resolves the interceptor as
// `ctx.exports.ContainerProxy` — the *worker's own export*, not a
// package-internal reference — so a subclass exported under that name runs in
// front of every intercepted request, including the ones the container's
// allow/deny gates answer with a bodyless 520 before any `outboundByHost`
// handler is consulted. That is the whole reason platform denials are
// observable at all; `engine/platform-denial.ts` carries the precedence the
// classification depends on.
//
// `@cloudflare/sandbox`'s subclass is the base rather than
// `@cloudflare/containers`', because the SDK routes its internal mount hosts
// (`r2.internal`, `s3-credential-proxy.internal`) through its own override and
// skipping it breaks `mountBucket`.
//
// Exporting this class is not optional decoration: without a `ContainerProxy`
// export the SDK throws "ctx.exports.ContainerProxy is undefined" on the first
// `allowHost`, so neither the egress grant nor the artifacts mount works at all.
import { ContainerProxy } from "@cloudflare/sandbox";
import { recordDenialD1 } from "./admission/denials-d1";
import { classifyPlatformDenial, type ProxyProps } from "./engine/platform-denial";
import type { Env } from "./env";

/**
 * The interceptor every substrate container's outbound traffic passes through.
 *
 * The response is never altered — a denial stays byte-for-byte what the
 * container would have seen (`Origin is disallowed`, no detail), so recording it
 * adds no oracle a hostile process can read. The write itself is fire-and-forget
 * on `waitUntil`: an audit row must never delay a denial, and must never be able
 * to fail one.
 */
export class SubstrateContainerProxy extends ContainerProxy {
  override async fetch(request: Request): Promise<Response> {
    const response = await super.fetch(request);

    // The SDK declares this entrypoint over `Cloudflare.Env` and its own props
    // shape; neither is the substrate's, and neither is generic. The two casts
    // are the whole cost of that, and both are read-only.
    const props = (this.ctx.props ?? {}) as ProxyProps;
    const env = this.env as unknown as Env;

    const denial = classifyPlatformDenial(
      props,
      { method: request.method, url: request.url },
      response.status,
    );
    if (denial && props.containerId) {
      const containerId = props.containerId;
      this.ctx.waitUntil(
        recordDenialD1(env.ADMISSION_DB, containerId, denial).catch((err) =>
          console.error("platform denial record failed", err),
        ),
      );
    }
    return response;
  }
}
