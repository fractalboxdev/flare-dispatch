// The substrate's one read path onto its own secret bindings
// (specs/adr/0006-credential-boundary.md).
//
// The egress handler needs to turn a descriptor's `secretName` into a value.
// The obvious implementation — index `env` by the name — makes the handler a
// read primitive for the entire Worker environment, and the environment holds
// `TICKET_SECRET`, the key that signs admission tickets: a descriptor naming it
// would hand a container a header from which it could mint a ticket for a
// container admission never admitted (ADR-0004).
//
// So the lookup goes through the injectable allowlist, and the mapping from
// name to binding is written out rather than computed. An operator adding a
// credential adds a line here and a field on `Env`, and the review that catches
// a mistake is a diff on this file.
//
// A value never leaves this module except onto an outbound request's headers,
// and never appears in a log line or a refusal reason.
import { isInjectableSecret } from "./engine/credentials";
import type { Env } from "./env";

/**
 * Resolve one injectable secret, or `undefined` for a name outside the
 * allowlist, an unset binding, or an empty one.
 *
 * Empty counts as unset: an empty credential is a misconfiguration every time,
 * and passing one through produces a 401 at the provider instead of a refusal
 * that names the binding.
 */
export function resolveSubstrateSecret(env: Env, name: string): string | undefined {
  if (!isInjectableSecret(name)) return undefined;
  const value =
    name === "CLOUDFLARE_API_TOKEN"
      ? env.CLOUDFLARE_API_TOKEN
      : name === "NPM_TOKEN"
        ? env.NPM_TOKEN
        : undefined;
  return value !== undefined && value.length > 0 ? value : undefined;
}
