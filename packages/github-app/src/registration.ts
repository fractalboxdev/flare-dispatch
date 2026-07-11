// @fractalbox/flare-dispatch-github-app — App registration read + drift diff.
//
// GitHub exposes NO endpoint to *update* an existing App's registration
// (permissions / events / name) — those are UI-only at
// github.com/organizations/<org>/settings/apps/<slug>, and changing
// permissions also forces every installation to re-approve. The one thing that
// is programmatically writable is the webhook config (`PATCH /app/hook/config`,
// JWT-authed) — intentionally NOT done here; this module is read-only.
//
// What IS available read-side, without any auth, is the *public* App view:
//
//   GET /apps/{slug}  →  { permissions, events, name, description, external_url }
//
// So `fetchPublicAppRegistration` reads the live App and `diffRegistration`
// compares it against the desired state declared in
// `infra/github-app-manifest.json` (`default_permissions` / `default_events`).
// The `github-app verify` CLI + the verify-app-registration workflow use these
// to fail CI when the live App drifts from the committed manifest.
//
// Provider-neutral plain `async` — same property as the rest of the package, no
// Effect dependency; the CLI does the Effect wrapping one layer up.

import { GithubApiError } from "./errors";
import { resolveClient } from "./http";

/** The live, public-readable view of a GitHub App's registration. */
export type AppRegistration = {
  /** Permission name → access level (`"read"` | `"write"` | …). */
  readonly permissions: Record<string, string>;
  /** Subscribed webhook event names. */
  readonly events: readonly string[];
  readonly name: string;
  readonly description: string;
  /** Owner login (org or user) — used to build the exact settings URL. */
  readonly ownerLogin: string;
  /** `"Organization"` | `"User"` — org vs personal App settings URL differ. */
  readonly ownerType: string;
};

/**
 * The settings URL where an App's registration is edited by hand (GitHub has no
 * API for it). Org-owned and user-owned Apps live at different paths.
 */
export const appSettingsUrl = (reg: {
  ownerLogin: string;
  ownerType: string;
}, slug: string): string =>
  reg.ownerType === "Organization"
    ? `https://github.com/organizations/${reg.ownerLogin}/settings/apps/${slug}`
    : `https://github.com/settings/apps/${slug}`;

/**
 * The desired registration, as declared in the manifest's `default_permissions`
 * / `default_events`. (The manifest's URL fields are placeholders and are NOT
 * part of drift detection — they're resolved per-origin at install time.)
 */
export type DesiredRegistration = {
  readonly default_permissions: Record<string, string>;
  readonly default_events: readonly string[];
};

export type PermissionDrift = {
  readonly permission: string;
  /** Level the manifest declares, or `undefined` if the manifest omits it. */
  readonly desired: string | undefined;
  /** Level the live App grants, or `undefined` if the live App omits it. */
  readonly live: string | undefined;
};

/**
 * The result of comparing desired (manifest) vs live (App) registration.
 *
 * Severity split: `permissionDrift` and `missingEvents` are *failing* — a
 * permission mismatch is a security/functionality break (over-privilege or a
 * missing grant), and an event the manifest declares but the App doesn't
 * subscribe to means deliveries the Dispatcher expects never arrive. `extraEvents`
 * (subscribed on the App, absent from the manifest) is a *warning*: a webhook
 * the Dispatcher simply ignores is harmless, but it signals registration drift
 * worth a human's attention (e.g. an unused subscription to trim in the UI).
 */
export type RegistrationDrift = {
  readonly permissionDrift: readonly PermissionDrift[];
  /** Declared in the manifest, NOT subscribed on the live App. Failing. */
  readonly missingEvents: readonly string[];
  /** Subscribed on the live App, NOT declared in the manifest. Warning. */
  readonly extraEvents: readonly string[];
};

export type FetchAppRegistrationOptions = {
  /** API base override (tests / GitHub Enterprise). */
  readonly apiBase?: string;
  /** `fetch` override — defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
};

/**
 * Read a GitHub App's public registration via `GET /apps/{slug}`. No
 * authentication — the App's permissions/events are public even for a private
 * (`public: false`) App, so this needs neither a PAT nor an App JWT.
 *
 * @throws {GithubApiError} on a non-2xx response (e.g. 404 for an unknown slug).
 */
export const fetchPublicAppRegistration = async (
  slug: string,
  opts: FetchAppRegistrationOptions = {},
): Promise<AppRegistration> => {
  const { apiBase, doFetch } = resolveClient(opts);
  const res = await doFetch(`${apiBase}/apps/${encodeURIComponent(slug)}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "flare-dispatch",
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new GithubApiError(
      `GET /apps/${slug} failed`,
      res.status,
      body,
    );
  }
  const json = (await res.json()) as {
    permissions?: Record<string, string>;
    events?: readonly string[];
    name?: string;
    description?: string | null;
    owner?: { login?: string; type?: string } | null;
  };
  return {
    permissions: json.permissions ?? {},
    events: json.events ?? [],
    name: json.name ?? "",
    description: json.description ?? "",
    ownerLogin: json.owner?.login ?? "",
    ownerType: json.owner?.type ?? "",
  };
};

/**
 * Compare desired (manifest) vs live (App) registration. Pure — no I/O. The
 * permission diff walks the union of both key sets so it catches BOTH a
 * manifest grant the App lacks AND an over-privilege the App holds but the
 * manifest never asked for.
 */
export const diffRegistration = (
  desired: DesiredRegistration,
  live: AppRegistration,
): RegistrationDrift => {
  const permissionKeys = new Set<string>([
    ...Object.keys(desired.default_permissions),
    ...Object.keys(live.permissions),
  ]);
  const permissionDrift: PermissionDrift[] = [];
  for (const permission of [...permissionKeys].sort()) {
    const wanted = desired.default_permissions[permission];
    const granted = live.permissions[permission];
    if (wanted !== granted) {
      permissionDrift.push({ permission, desired: wanted, live: granted });
    }
  }

  const liveEvents = new Set(live.events);
  const desiredEvents = new Set(desired.default_events);
  const missingEvents = [...desiredEvents]
    .filter((e) => !liveEvents.has(e))
    .sort();
  const extraEvents = [...liveEvents]
    .filter((e) => !desiredEvents.has(e))
    .sort();

  return { permissionDrift, missingEvents, extraEvents };
};

/** Whether a drift result has any *failing* (CI-breaking) entries. */
export const hasFailingDrift = (drift: RegistrationDrift): boolean =>
  drift.permissionDrift.length > 0 || drift.missingEvents.length > 0;
