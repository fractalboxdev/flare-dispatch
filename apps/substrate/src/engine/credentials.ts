// Handler-injected credentials — the second sanctioned write shape
// (specs/adr/0006-credential-boundary.md).
//
// ADR-0006's rule is that no long-lived credential is reachable from inside a
// container: not in env, not in argv, not on the filesystem. Writes leave by
// worker-side writeback (preferred — the container produces an artifact and the
// Worker performs the authenticated write) or, for the writes that genuinely
// cannot, by attaching the credential *outside* the container: the egress
// handler resolves the secret from the substrate Worker's own environment and
// sets the header on a request the container never sees the credential for.
// `wrangler deploy` → `api.cloudflare.com` is the acceptance case — the tool
// authenticates its own HTTPS calls, so there is no artifact to hand back.
//
// Four controls make that safe, and each is a separate function here.
//
// 1. **The container never names the secret.** Descriptors are frozen in
//    `CREDENTIAL_CATALOG`, keyed by the reviewed grant-profile names a recipe
//    may *select* (ADR-0005). Nothing on the facade carries a secret name.
// 2. **The descriptor cannot reach an arbitrary binding.** `INJECTABLE_SECRETS`
//    is the allowlist a resolver consults, so a mis-authored catalog entry
//    naming `TICKET_SECRET` resolves to nothing rather than to the key that
//    signs admission tickets.
// 3. **The template cannot forge a second header.** `parseHeaderTemplate`
//    rejects CR/LF, a malformed header name, and anything other than exactly
//    one `{{secret}}`; `renderCredential` rejects a secret value carrying a
//    control character. Header injection through a credential value is the one
//    way this module could become the hole it exists to close.
// 4. **The container's own auth headers never survive.** The egress engine
//    forwards an allowlist of request headers, and every header a credential
//    could travel in is off it (`CONTAINER_AUTHORED_AUTH_HEADERS` names them so
//    the property is asserted rather than implied). A container that sends its
//    own `Authorization` to `api.cloudflare.com` gets the substrate's, or none.
//
// Pure. Zero Cloudflare imports; the secret resolver is injected. Unit tested
// in credentials.test.ts.
import type {
  CredentialDescriptor,
  GrantProfileName,
} from "@fractalboxdev/flare-dispatch-substrate-contract";

/**
 * The only secret binding names the egress handler may resolve.
 *
 * Defence in depth against a catalog bug rather than against a consumer:
 * descriptors are already reviewed code. What this stops is a reviewed-but-wrong
 * descriptor turning the egress handler into a read primitive for the worker's
 * whole environment — `TICKET_SECRET` signs admission tickets, and a ticket
 * forged from it boots a container admission never admitted (ADR-0004).
 */
export const INJECTABLE_SECRETS = [
  "CLOUDFLARE_API_TOKEN",
  "NPM_TOKEN",
] as const;

export type InjectableSecretName = (typeof INJECTABLE_SECRETS)[number];

export function isInjectableSecret(name: string): name is InjectableSecretName {
  return (INJECTABLE_SECRETS as readonly string[]).includes(name);
}

/**
 * Request headers a container could carry its own credential in. The engine's
 * forwarded-header allowlist already omits every one of them — this list exists
 * so that property is a test rather than a reading of the allowlist, and so a
 * later addition to the allowlist fails loudly instead of quietly re-opening
 * the path.
 */
export const CONTAINER_AUTHORED_AUTH_HEADERS = [
  "authorization",
  "proxy-authorization",
  "cookie",
  "x-auth-email",
  "x-auth-key",
  "x-auth-user-service-key",
  "x-api-key",
  "x-amz-security-token",
] as const;

/** A parsed template: the header to set, and the value with the hole in it. */
export type HeaderTemplate = {
  /** Lowercased header name. */
  name: string;
  /** The value, still containing exactly one `{{secret}}`. */
  valueTemplate: string;
};

export type TemplateParse =
  | { ok: true; template: HeaderTemplate }
  | { ok: false; reason: string };

const PLACEHOLDER = "{{secret}}";

/** RFC 7230 token characters — what a header field-name may contain. */
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9a-z]+$/i;

const TAB = 0x09;
const SPACE = 0x20;
const DEL = 0x7f;

/**
 * Reject anything a header value must not carry: CR, LF, NUL and the rest of
 * the C0 range (horizontal tab excepted — it is legal in a field value), plus
 * DEL. A CR or LF is response splitting's request-side twin: it would end the
 * header and start another one the substrate never authored.
 *
 * A character scan rather than a regex: a character class over the control
 * range is exactly what `no-control-regex` exists to catch, and the loop says
 * what it means without a suppression comment arguing with the linter.
 */
function hasControlChar(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === TAB) continue;
    if (code < SPACE || code === DEL) return true;
  }
  return false;
}

/**
 * Parse and validate a descriptor's `headerTemplate` (`Name: value` with one
 * `{{secret}}`). Every failure is a refusal with a reason — a template that
 * does not parse must never fall back to "send it unmodified".
 */
export function parseHeaderTemplate(template: string): TemplateParse {
  if (hasControlChar(template))
    return { ok: false, reason: "header template carries a control character" };

  const colon = template.indexOf(":");
  if (colon <= 0) return { ok: false, reason: "header template is not `Name: value`" };

  const name = template.slice(0, colon).trim().toLowerCase();
  const valueTemplate = template.slice(colon + 1).trim();
  if (!HEADER_NAME.test(name))
    return { ok: false, reason: `header name ${JSON.stringify(name)} is not a token` };
  if (valueTemplate.length === 0)
    return { ok: false, reason: "header template has an empty value" };

  const first = valueTemplate.indexOf(PLACEHOLDER);
  if (first === -1) return { ok: false, reason: "header template has no {{secret}}" };
  if (valueTemplate.indexOf(PLACEHOLDER, first + 1) !== -1)
    return { ok: false, reason: "header template has more than one {{secret}}" };

  return { ok: true, template: { name, valueTemplate } };
}

export type RenderedCredential = { name: string; value: string };

export type CredentialRender =
  | { ok: true; header: RenderedCredential }
  | { ok: false; reason: string };

/**
 * Render one descriptor against a resolved secret value.
 *
 * The value is validated as hard as the template: a secret carrying a newline
 * (a trailing one from `wrangler secret put` reading a file is the realistic
 * case) would inject a second header, so it is refused rather than trimmed —
 * silently repairing a credential is how a subtly wrong one ships. No reason
 * string ever contains the value.
 */
export function renderCredential(
  descriptor: CredentialDescriptor,
  secretValue: string,
): CredentialRender {
  const parsed = parseHeaderTemplate(descriptor.headerTemplate);
  if (!parsed.ok) return parsed;
  if (secretValue.length === 0)
    return { ok: false, reason: `secret ${descriptor.secretName} is empty` };
  if (hasControlChar(secretValue))
    return { ok: false, reason: `secret ${descriptor.secretName} carries a control character` };

  return {
    ok: true,
    header: {
      name: parsed.template.name,
      value: parsed.template.valueTemplate.replace(PLACEHOLDER, secretValue),
    },
  };
}

/**
 * The reviewed catalog: which credential attaches to which host, under which
 * named profile. Authored here and nowhere else.
 *
 * Hosts are concrete, never globs, for the same reason `buildGrant` emits
 * concrete hostnames: a glob would attach a write-scoped token to a host the
 * policy never inspected. `cf-api` is ADR-0006's acceptance case —
 * `wrangler deploy` reaching `api.cloudflare.com` with a token that exists only
 * in the substrate Worker's environment. `js-install` covers the npm registry's
 * private-package case; the `NPM_TOKEN` descriptor is inert until an operator
 * sets the binding, and a public install never triggers it because the registry
 * answers unauthenticated reads.
 *
 * The remaining profiles reach hosts that take no credential at all
 * (`public-repo-read`, `rust-install`, `browser-fetch`) or whose credential is
 * a GitHub installation token the substrate holds Worker-side rather than
 * attaching per request (`github-api-read`) — an empty entry is a decision,
 * not an omission.
 */
export const CREDENTIAL_CATALOG: Readonly<
  Record<GrantProfileName, readonly CredentialDescriptor[]>
> = Object.freeze({
  "public-repo-read": [],
  "js-install": [
    {
      secretName: "NPM_TOKEN",
      host: "registry.npmjs.org",
      headerTemplate: "authorization: Bearer {{secret}}",
    },
  ],
  "rust-install": [],
  "browser-fetch": [],
  "cf-api": [
    {
      secretName: "CLOUDFLARE_API_TOKEN",
      host: "api.cloudflare.com",
      headerTemplate: "authorization: Bearer {{secret}}",
    },
  ],
  "github-api-read": [],
});

/**
 * Every descriptor the selected profiles attach, keyed by normalized host.
 *
 * Two profiles claiming the same host is a catalog bug that must not resolve
 * silently to whichever came first — the caller gets the conflict as a thrown
 * error at grant-build time, where a test and a deploy both see it, rather than
 * as a surprising header at request time.
 */
export function credentialsByHost(
  profiles: readonly GrantProfileName[] | undefined,
): Map<string, CredentialDescriptor> {
  const byHost = new Map<string, CredentialDescriptor>();
  for (const profile of profiles ?? []) {
    for (const descriptor of CREDENTIAL_CATALOG[profile] ?? []) {
      const host = descriptor.host.trim().toLowerCase();
      const existing = byHost.get(host);
      if (existing && existing.secretName !== descriptor.secretName)
        throw new Error(
          `credentials: two profiles attach different secrets to ${host}`,
        );
      byHost.set(host, descriptor);
    }
  }
  return byHost;
}

/** Resolve a descriptor's value, refusing any name outside the allowlist. */
export type SecretResolver = (name: string) => string | undefined;

export type CredentialResolution =
  | { ok: true; header: RenderedCredential }
  | { ok: false; reason: string };

/**
 * Resolve and render one descriptor, or say why not.
 *
 * A descriptor whose secret is unset fails **closed**: the request is refused
 * rather than sent unauthenticated. An unauthenticated `wrangler deploy` gets a
 * 401 from Cloudflare and a confusing failure deep in a build log; a refusal
 * names the missing binding to the operator through the denial record.
 */
export function resolveCredential(
  descriptor: CredentialDescriptor,
  resolve: SecretResolver,
): CredentialResolution {
  if (!isInjectableSecret(descriptor.secretName))
    return {
      ok: false,
      reason: `secret ${descriptor.secretName} is not injectable`,
    };
  const value = resolve(descriptor.secretName);
  if (value === undefined)
    return { ok: false, reason: `secret ${descriptor.secretName} is not configured` };
  return renderCredential(descriptor, value);
}
