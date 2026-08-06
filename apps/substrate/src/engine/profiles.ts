// The grant-profile catalog (specs/adr/0005-deny-all-egress-with-grant-profiles.md).
//
// A grant is composed here and nowhere else. Consumers *select* among the names
// below; they can never define one, widen one, or reach the rules a name maps
// to — the whole vocabulary is this file, versioned with the substrate and
// reviewed as security code.
//
// Why a catalog rather than per-run allowlists: fractalbot's reviewed engine
// speaks one profile (`public-repo-read`), and flare-dispatch's ~20 runs need
// egress it cannot express — registries, browser downloads, `api.cloudflare.com`,
// e2e targets that are a dispatch input. Authoring those per run puts the
// allowlist within reach of a payload, which is the one thing deny-all exists to
// prevent. Naming them here keeps the derivation in reviewed code and leaves the
// consumer with a selection, not an authoring surface.
//
// Four rules govern every entry:
//
// 1. **Concrete hosts only.** A glob admits hosts no rule inspects, and the
//    platform's precedence ends in public egress — see `buildGrant`'s
//    admitted-set == handled-set assertion in egress.ts.
// 2. **Method and path are asserted, host scope is not enough.** One host serves
//    read and write (`git-upload-pack` vs `git-receive-pack`; npm metadata vs
//    publish; the Cloudflare API serves Workers, DNS, R2 and billing), so the
//    rule, not the allowlist, is the control.
// 3. **A profile may only widen the deny floor deliberately.** `WRITE_SINKS`
//    holds unless a profile marks a host `overridesDeny` AND serves it with
//    rules — `github-api-read` is the one entry that does, trading a blanket
//    deny for a GET-only assertion, which is strictly more precise.
// 4. **A credential is a property of a host, not of a policy** (ADR-0006). The
//    descriptor a profile attaches rides on the `HostPolicy`, so a redirect off
//    that host leaves the credential behind — `decide` returns the matched
//    host's descriptor, and nothing accumulates across hops.
//
// Pure: no Cloudflare imports, no I/O. Unit tested in profiles.test.ts.
import type {
  CredentialDescriptor,
  EnforcementPosition,
  GrantProfileName,
} from "@fractalboxdev/flare-dispatch-substrate-contract";
import { credentialsByHost } from "./credentials";

/**
 * Methods a rule may name. Deny-by-default is unchanged by the width of this
 * union: a method with no matching rule on the matched host is refused, so
 * adding `PUT` here admits nothing until some reviewed rule asks for it.
 * `wrangler deploy` is what needs more than GET/POST — a script upload is a
 * `PUT` — and a policy engine that cannot express the method it is asserting on
 * would have to admit the host without inspecting it.
 */
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export const METHODS: readonly HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];

/** Methods that carry no request body worth capping or asserting. */
export const BODYLESS: readonly HttpMethod[] = ["GET", "DELETE"];

export type PathRule = {
  method: HttpMethod;
  match: (url: URL) => boolean;
  maxBodyBytes?: number;
  /** Returns a denial reason, or undefined when the body is acceptable. */
  assertBody?: (raw: string) => string | undefined;
};

export type HostPolicy = {
  /** Concrete hostname. An enforcing policy holds no globs — see `buildGrant`. */
  host: string;
  rules: PathRule[];
  /**
   * Attached by the handler on every request that passes this host's rules
   * (ADR-0006). Per host rather than per policy: a redirect that leaves this
   * host must not carry its credential onward, and `decide` returns the
   * matched host's descriptor for exactly that reason.
   */
  credential?: CredentialDescriptor;
};

export type EgressPolicy = {
  repo: string;
  hosts: HostPolicy[];
  deny: readonly string[];
};

/** What a grant freezes into the outbound handler's params. None of it is model-authored. */
export type GrantParams = {
  /**
   * `owner/name` from the recipe's repo — an input no model wrote. Empty only
   * for an open posture (`legacy` / `report`), which asserts no path rules;
   * `selectionProblem` refuses a profile selection without one.
   */
  repo: string;
  /**
   * The container this grant was issued to. `setOutboundByHost` is already
   * per-instance, so this is defence in depth against a handler reached from
   * an instance the grant was never issued for.
   */
  containerId: string;
  /** Admits the LFS object host, whose paths cannot be repo-scoped. Off by default. */
  lfs?: boolean;
  /**
   * Named profiles this grant composes beyond the repo read (ADR-0005). Only
   * names — the hosts, rules and credential descriptors each one implies are
   * authored in reviewed code here and in `credentials.ts`, never carried in
   * the grant. Frozen into `setOutboundByHost` params, so a handler reached
   * with a profile the fence did not grant simply has no rule to match.
   */
  profiles?: readonly GrantProfileName[];
  /**
   * Concrete dynamic hosts for a profile that accepts them (today only
   * `browser-fetch`). Already gated consumer-side against the host-pattern
   * schema in the reviewed run definition — an input host outside it fails the
   * dispatch, not the policy (ADR-0005).
   */
  targets?: readonly string[];
  /** Rollout position. Absent ⇒ `enforce`. */
  position?: EnforcementPosition;
};

/** git's pack negotiation body. Bounded, but genuinely workload-controlled — see `POST_SINK_NOTE`. */
const MAX_UPLOAD_PACK_BYTES = 1024 * 1024;
const MAX_LFS_BATCH_BYTES = 256 * 1024;
/** An e2e target is a real app — form posts and JSON APIs, not uploads. */
const MAX_TARGET_BYTES = 1024 * 1024;

/**
 * Write sinks that must never be reachable, whatever a handler decides.
 * `deniedHosts` is the one rule a handler cannot override on the container
 * side — and `decide` applies it again on redirect targets, because the
 * platform's deny list does not govern a handler's own fetch.
 *
 * Wildcards here are deliberate: these hold even if the admitted set is later
 * widened to `*.github.com`.
 */
export const WRITE_SINKS = [
  "gist.github.com",
  "uploads.github.com",
  "api.github.com",
] as const;

/**
 * `git-upload-pack` takes a workload-authored body on an allowed host, so it is
 * a bounded exfiltration sink and is not claimed otherwise (an accepted
 * residual in specs/platform.md). What the rules below buy is that it is the
 * *only* POST body that reaches github.com, capped, and to one path under one
 * repository.
 */
export const POST_SINK_NOTE =
  "git-upload-pack carries a workload-controlled body; bounded, not eliminated";

/** git appends `.git` to the remote path about half the time; accept both spellings. */
function repoPrefixes(slug: string): string[] {
  return [`/${slug}`, `/${slug}.git`];
}

function underRepo(slug: string, url: URL, suffix: string): boolean {
  return repoPrefixes(slug).some((p) => url.pathname === `${p}${suffix}`);
}

const anyPath = (): boolean => true;
const under = (prefix: string) => (url: URL): boolean => url.pathname.startsWith(prefix);

/**
 * A Cloudflare account id as it appears in an API path: 32 lowercase hex.
 * Matching the shape rather than a specific id keeps the substrate free of a
 * per-account var while still pinning the path to one account segment — the
 * token is account-scoped anyway, and what this buys is product scope, below.
 */
const CF_ACCOUNT_SEGMENT = /^[0-9a-f]{32}$/;

/**
 * A `wrangler deploy` script upload. Workers' own script-size limit is 10 MB
 * compressed; 16 MB of multipart is comfortable headroom. The cap is not
 * decorative — the body is buffered in the isolate to be counted, so raising it
 * trades directly against isolate memory, and an unbounded cap on a host
 * reached with a write-scoped token is an unbounded exfiltration sink.
 */
const MAX_CF_UPLOAD_BYTES = 16 * 1024 * 1024;
const MAX_CF_JSON_BYTES = 256 * 1024;

/** `/client/v4/accounts/<32-hex>/workers/...` — the Workers product, one account. */
function underAccountWorkers(url: URL): boolean {
  const parts = url.pathname.split("/").filter((p) => p.length > 0);
  return (
    parts[0] === "client" &&
    parts[1] === "v4" &&
    parts[2] === "accounts" &&
    parts[3] !== undefined &&
    CF_ACCOUNT_SEGMENT.test(parts[3]) &&
    parts[4] === "workers"
  );
}

/**
 * One entry in the catalog. `hosts` is a function of the grant params because
 * three things vary with them: `public-repo-read` scopes every path to the
 * recipe's repository, `browser-fetch` admits the recipe's declared targets,
 * and every credentialed host reads its descriptor from `credentialsByHost`.
 */
export type GrantProfile = {
  readonly name: GrantProfileName;
  /** Refuses the grant when the recipe carries no repo. */
  readonly requiresRepo: boolean;
  /** Whether `recipe.targets` may contribute hosts to this profile. */
  readonly acceptsTargets: boolean;
  /**
   * Hosts this profile trades out of `WRITE_SINKS`. A host listed here MUST
   * also be served with rules — the trade is a blanket deny for a narrower
   * assertion, never for nothing.
   */
  readonly overridesDeny?: readonly string[];
  readonly hosts: (
    params: GrantParams,
    credential: (host: string) => CredentialDescriptor | undefined,
  ) => HostPolicy[];
};

/**
 * Cloning and reading one public repository — fractalbot's reviewed profile,
 * unchanged. No credential is injected anywhere in it, so every rule is about
 * what the container may *say*, not what it may say it with.
 *
 * Read over git's smart HTTP transport is not GET-only — discovery is
 * `GET /info/refs?service=git-upload-pack` and negotiation is
 * `POST /git-upload-pack`. The push counterparts share both URLs, distinguished
 * only by the `service` parameter and the path's last segment, which is exactly
 * why the assertion is on method and path rather than host.
 */
const publicRepoRead: GrantProfile = {
  name: "public-repo-read",
  requiresRepo: true,
  acceptsTargets: false,
  hosts: (params) => {
    const slug = params.repo;
    const hosts: HostPolicy[] = [
      {
        host: "github.com",
        rules: [
          {
            // Ref discovery. `service=git-receive-pack` is push discovery and is
            // refused here rather than left to fail at GitHub.
            method: "GET",
            match: (url) =>
              underRepo(slug, url, "/info/refs") &&
              url.searchParams.get("service") === "git-upload-pack",
          },
          {
            method: "POST",
            match: (url) => underRepo(slug, url, "/git-upload-pack"),
            maxBodyBytes: MAX_UPLOAD_PACK_BYTES,
          },
          {
            // LFS batch. Download and upload are the same URL and the same
            // method; only the body separates them, so the body is asserted.
            method: "POST",
            match: (url) =>
              params.lfs === true && underRepo(slug, url, "/info/lfs/objects/batch"),
            maxBodyBytes: MAX_LFS_BATCH_BYTES,
            assertBody: (raw) => {
              let parsed: unknown;
              try {
                parsed = JSON.parse(raw);
              } catch {
                return "lfs batch body is not JSON";
              }
              const op = (parsed as { operation?: unknown } | null)?.operation;
              return op === "download"
                ? undefined
                : `lfs batch operation ${JSON.stringify(op)} is not download`;
            },
          },
          {
            // Archive download, which 302s to codeload.
            method: "GET",
            match: (url) => repoPrefixes(slug).some((p) => url.pathname.startsWith(`${p}/archive/`)),
          },
        ],
      },
      {
        host: "codeload.github.com",
        rules: [
          {
            method: "GET",
            match: (url) => repoPrefixes(slug).some((p) => url.pathname.startsWith(`${p}/`)),
          },
        ],
      },
    ];

    if (params.lfs === true) {
      hosts.push({
        host: "objects.githubusercontent.com",
        // LFS object URLs are opaque signed paths with no repository segment, so
        // this host cannot carry a repo-scoped path assertion — the only controls
        // left are GET-only and no body. That weakness is why LFS is opt-in
        // rather than part of the default clone grant.
        rules: [{ method: "GET", match: anyPath }],
      });
    }

    return hosts;
  },
};

/**
 * npm-family installs. GET-only is the whole control: `npm publish` is a
 * `PUT /:package` and `npm token create` a POST on the same host, so a method
 * rule separates reading the registry from writing to it. A publish is a write
 * with an artifact to hand back, so it belongs on the writeback path (ADR-0006
 * prefers it) rather than in a container holding a publish-capable token.
 *
 * The registry credential is injected handler-side when `NPM_TOKEN` is bound —
 * a private registry works without the token ever entering the container.
 */
const jsInstall: GrantProfile = {
  name: "js-install",
  requiresRepo: false,
  acceptsTargets: false,
  hosts: (_params, credential) => [
    {
      host: "registry.npmjs.org",
      credential: credential("registry.npmjs.org"),
      rules: [{ method: "GET", match: anyPath }],
    },
    { host: "registry.yarnpkg.com", rules: [{ method: "GET", match: anyPath }] },
  ],
};

/**
 * cargo installs. The sparse index (`index.crates.io`) and the `.crate` CDN
 * (`static.crates.io`) are separate hosts, and `crates.io/api/v1` is what older
 * cargo still resolves through. `cargo publish` is `PUT /api/v1/crates/new` on
 * `crates.io` — excluded by both the method rule and the path prefix.
 *
 * A git dependency does not ride this profile: it is a clone, and clones are
 * `public-repo-read`, scoped to the recipe's own repository. A workspace with
 * git deps outside that repository is a grant this catalog deliberately does
 * not express.
 */
const rustInstall: GrantProfile = {
  name: "rust-install",
  requiresRepo: false,
  acceptsTargets: false,
  hosts: () => [
    { host: "index.crates.io", rules: [{ method: "GET", match: anyPath }] },
    { host: "static.crates.io", rules: [{ method: "GET", match: anyPath }] },
    { host: "crates.io", rules: [{ method: "GET", match: under("/api/v1/crates/") }] },
  ],
};

/**
 * Browser binaries plus the run's declared e2e targets.
 *
 * Both belong to the same runs and both are GET-shaped for the download half:
 * Playwright resolves its browser bundles from `cdn.playwright.dev` (and the
 * legacy Azure edge host). Chromium's `storage.googleapis.com` mirror is
 * deliberately NOT admitted — one bucket host serves every bucket on the
 * platform, so admitting it is admitting an arbitrary object store, and a run
 * that needs it should pin the Playwright CDN instead.
 *
 * The target half is where a dispatch input reaches the policy, and the shape of
 * that is the point: the *host* arrives already checked against the pattern its
 * reviewed run definition declares (ADR-0005 — an input host outside the pattern
 * fails the dispatch, not the policy), and only then does it become an admitted
 * host with GET/POST rules. A suite drives a real app, so paths cannot be
 * scoped; the body cap is what bounds it. No credential is ever attached to a
 * target — an input-derived host must never reach a secret.
 */
const browserFetch: GrantProfile = {
  name: "browser-fetch",
  requiresRepo: false,
  acceptsTargets: true,
  hosts: (params) => [
    { host: "cdn.playwright.dev", rules: [{ method: "GET", match: anyPath }] },
    { host: "playwright.azureedge.net", rules: [{ method: "GET", match: anyPath }] },
    ...(params.targets ?? []).map((host) => ({
      host,
      rules: [
        { method: "GET" as const, match: anyPath },
        { method: "POST" as const, match: anyPath, maxBodyBytes: MAX_TARGET_BYTES },
      ],
    })),
  ],
};

/**
 * The Cloudflare REST API — what `wrangler deploy` speaks, with the token
 * attached handler-side (ADR-0006's acceptance case: the tool authenticates its
 * own HTTPS calls, so there is no artifact to hand back).
 *
 * Product scope is the containment that matters here: a write-scoped token can
 * also edit DNS, delete R2 buckets and read billing, and pinning every path
 * under `/client/v4/accounts/<id>/workers/` is what keeps a hostile
 * `postinstall` holding the injected header from reaching any of it. Writes are
 * admitted, which is exactly why the irreversible-command floor exists one layer
 * up: ADR-0007's attestation decides whether a `wrangler deploy` may run at all,
 * and this profile only decides where it may send bytes once it may.
 */
const cfApi: GrantProfile = {
  name: "cf-api",
  requiresRepo: false,
  acceptsTargets: false,
  hosts: (_params, credential) => [
    {
      host: "api.cloudflare.com",
      credential: credential("api.cloudflare.com"),
      rules: [
        // Pre-flight: wrangler verifies the token and lists memberships before
        // it uploads anything. Both are read-only and neither is account-scoped.
        { method: "GET", match: (url) => url.pathname === "/client/v4/user/tokens/verify" },
        { method: "GET", match: (url) => url.pathname === "/client/v4/memberships" },
        { method: "GET", match: underAccountWorkers },
        // The upload itself, plus version/deployment creation and the
        // subdomain/settings writes a first deploy performs.
        { method: "PUT", match: underAccountWorkers, maxBodyBytes: MAX_CF_UPLOAD_BYTES },
        { method: "POST", match: underAccountWorkers, maxBodyBytes: MAX_CF_UPLOAD_BYTES },
        { method: "PATCH", match: underAccountWorkers, maxBodyBytes: MAX_CF_JSON_BYTES },
      ],
    },
  ],
};

/**
 * Reading the GitHub REST API.
 *
 * `api.github.com` is a standing write sink — it is where an issue is opened, a
 * ref is force-updated, a release is published — so it ships denied. This is the
 * one profile that trades that blanket deny for something narrower: GET only,
 * and `/graphql` (a POST) is NOT admitted, because a GraphQL POST is a mutation
 * surface indistinguishable by path from a query. No credential is attached: a
 * run that needs to write to GitHub does it Worker-side through the App
 * installation token, never from inside a container (ADR-0006).
 */
const githubApiRead: GrantProfile = {
  name: "github-api-read",
  requiresRepo: false,
  acceptsTargets: false,
  overridesDeny: ["api.github.com"],
  hosts: () => [{ host: "api.github.com", rules: [{ method: "GET", match: anyPath }] }],
};

/** The catalog. Every name in the contract's `GrantProfileName` appears exactly once. */
export const GRANT_PROFILES: Readonly<Record<GrantProfileName, GrantProfile>> = {
  "public-repo-read": publicRepoRead,
  "js-install": jsInstall,
  "rust-install": rustInstall,
  "browser-fetch": browserFetch,
  "cf-api": cfApi,
  "github-api-read": githubApiRead,
};

export const PROFILE_NAMES = Object.keys(GRANT_PROFILES) as readonly GrantProfileName[];

/** Whether a string names a catalog profile. The one gate a consumer's selection crosses. */
export function isProfileName(name: string): name is GrantProfileName {
  return Object.hasOwn(GRANT_PROFILES, name);
}

/**
 * The profiles a grant is composed from: the repo read, plus whatever the
 * recipe selected.
 *
 * Profiles COMPOSE onto the repo read rather than replacing it. Every run that
 * selects `cf-api` or `js-install` also clones, and a catalog entry that forgot
 * to restate `public-repo-read` would otherwise produce a grant whose container
 * cannot fetch its own source — a failure mode with no diagnostic beyond a
 * denied clone. The composition widens nothing meaningful: the repo read is
 * scoped to the recipe's own repository, which the container was built from.
 *
 * With no repo there is nothing to compose onto, and `selectionProblem` has
 * already refused any selection — so this is empty and `grantFor` turns it into
 * no grant at all.
 */
export function profilesFor(params: GrantParams): readonly GrantProfileName[] {
  if (!params.repo) return [];
  const selected = params.profiles ?? [];
  return selected.includes("public-repo-read")
    ? selected
    : (["public-repo-read", ...selected] as const);
}

/**
 * Why this selection cannot be served, or undefined when it can. Called at the
 * facade (so a consumer gets a typed `recipe-rejected` before anything boots)
 * and again where the grant is built.
 */
export function selectionProblem(params: GrantParams): string | undefined {
  // ADR-0005 states it on the contract's `repo` field: a recipe with no
  // repository is "work that needs a shell but no repository — and then NO
  // egress". So a selection composes onto a repo or it composes onto nothing;
  // the alternative reading, "no repo ⇒ whatever the profile says", is how a
  // repo-less task quietly acquires a package registry.
  if (!params.repo && (params.profiles?.length ?? 0) > 0)
    return "a grant profile needs a repo to compose onto";

  for (const name of params.profiles ?? []) {
    if (!isProfileName(name)) return `grant profile ${JSON.stringify(name)} is not in the catalog`;
    if (GRANT_PROFILES[name].requiresRepo && !params.repo)
      return `grant profile ${name} needs a recipe repo`;
  }

  const targets = params.targets ?? [];
  if (targets.length > 0) {
    const accepts = profilesFor(params).some((name) => GRANT_PROFILES[name].acceptsTargets);
    if (!accepts) return "recipe declares targets but no selected profile accepts them";
    for (const host of targets) {
      // A target is a hostname, not a URL and not a pattern: a glob here would
      // admit hosts no rule was written for, and a URL would smuggle a path the
      // policy never asserted.
      if (host.includes("*") || host.includes("/") || host.trim() !== host || host === "")
        return `target ${JSON.stringify(host)} is not a bare hostname`;
    }
  }

  return undefined;
}

/**
 * Compose the selected profiles into one policy.
 *
 * Hosts merge by name — two profiles naming one host contribute their rules to
 * the same entry rather than shadowing each other, so `decide` sees the union
 * and a later profile can never narrow an earlier one by accident. A credential
 * follows the same rule: `credentialsByHost` throws when two profiles attach
 * different secrets to one host, so a catalog conflict is a build-time error
 * rather than a surprising header at request time.
 *
 * The deny set starts at `WRITE_SINKS` and loses only what a selected profile
 * declares in `overridesDeny` *and* serves with rules. Both halves are required:
 * a profile that names a sink without serving it would leave the host denied
 * nowhere and admitted nowhere, which is a silent hole rather than a policy.
 *
 * @throws when the repo slug is malformed — a bad slug widens every path rule.
 */
export function grantPolicy(params: GrantParams): EgressPolicy {
  if (params.repo && !/^[\w.-]+\/[\w.-]+$/.test(params.repo))
    throw new Error(`egress: refusing a grant for malformed repo ${JSON.stringify(params.repo)}`);

  const problem = selectionProblem(params);
  if (problem) throw new Error(`egress: ${problem}`);

  const selected = profilesFor(params);
  const byHost = credentialsByHost(selected);
  const credential = (host: string): CredentialDescriptor | undefined =>
    byHost.get(host.trim().toLowerCase());

  const merged = new Map<string, HostPolicy>();
  const traded = new Set<string>();

  for (const name of selected) {
    const profile = GRANT_PROFILES[name];
    for (const host of profile.hosts(params, credential)) {
      const existing = merged.get(host.host);
      if (existing) {
        existing.rules.push(...host.rules);
        existing.credential = existing.credential ?? host.credential;
      } else {
        merged.set(host.host, { ...host, rules: [...host.rules] });
      }
    }
    for (const host of profile.overridesDeny ?? []) traded.add(host);
  }

  const hosts = [...merged.values()];
  const served = new Set(hosts.map((h) => h.host));
  const deny = WRITE_SINKS.filter((sink) => !(traded.has(sink) && served.has(sink)));

  return { repo: params.repo, hosts, deny };
}

/**
 * The `public-repo-read` policy on its own — the shape the reference
 * implementation exposed, kept as a named entry point because it is the one
 * profile whose rules are asserted against the recipe rather than fixed.
 */
export function publicRepoPolicy(params: GrantParams): EgressPolicy {
  return grantPolicy({ ...params, profiles: ["public-repo-read"], targets: [] });
}
