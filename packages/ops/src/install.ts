// The GitHub App install routes: an operator starts GitHub's manifest flow with a `state` bound to their Access
// session, and the callback accepts that state once within 600 s before it exchanges the code (FD-OPS-072 to
// FD-OPS-075). The exchange goes through `ManifestConversion`, which the GitHub App package supplies.
import type { D1Like } from "@fractalboxdev/mameko-host-cloudflare/d1";
import { Context, Effect } from "effect";
import type { AccessIdentity } from "./access.ts";
import { appManifest } from "./app-manifest.ts";
import { esc } from "./dashboard.ts";

/** How long an install `state` stays acceptable (FD-OPS-073). */
export const STATE_TTL_MS = 600_000;

/** The App's credentials GitHub returns for a manifest code. */
export interface AppCredentials {
  readonly id: number;
  readonly slug: string;
  readonly pem: string;
  readonly webhookSecret: string;
  readonly clientId: string;
  readonly clientSecret: string;
}

/** `POST /app-manifests/{code}/conversions`. */
export class ManifestConversion extends Context.Service<
  ManifestConversion,
  { readonly convert: (code: string) => Effect.Effect<AppCredentials> }
>()("@fractalboxdev/flare-dispatch-ops/ManifestConversion") {}

const randomState = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
};

/** Starts the manifest flow: a new single-use state bound to the operator's session, and the form GitHub receives. */
export const startInstall = async (
  db: D1Like,
  operator: AccessIdentity,
  origin: string,
  now: number,
) => {
  const state = randomState();
  await db
    .prepare("insert into fd_install_states (state, session, created_at) values (?, ?, ?)")
    .bind(state, operator.subject, now)
    .run();
  const manifest = JSON.stringify(appManifest(origin));
  const body = `<!doctype html><html><body>
<form method="post" action="https://github.com/settings/apps/new?state=${encodeURIComponent(state)}">
<input type="hidden" name="manifest" value="${esc(manifest)}" />
<button type="submit">Create the GitHub App</button>
</form></body></html>`;
  return new Response(body, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
};

/** Why a callback state is refused. */
export type StateRefusal = "unknown" | "used" | "expired" | "other-session";

/**
 * Accepts a callback state once: known, unused, younger than 600 s and bound to this operator's session. The
 * acceptance marks it used in the same conditional update (FD-OPS-073, FD-OPS-074).
 */
export const acceptState = async (
  db: D1Like,
  state: string,
  operator: AccessIdentity,
  now: number,
): Promise<StateRefusal | null> => {
  const { results } = await db
    .prepare("select session, created_at, used_at from fd_install_states where state = ?")
    .bind(state)
    .all();
  const row = results[0] as
    | { session: string; created_at: number; used_at: number | null }
    | undefined;
  if (row === undefined) return "unknown";
  if (row.used_at !== null) return "used";
  if (now - row.created_at >= STATE_TTL_MS) return "expired";
  if (row.session !== operator.subject) return "other-session";
  const { results: marked } = await db
    .prepare(
      "update fd_install_states set used_at = ? where state = ? and used_at is null returning state",
    )
    .bind(now, state)
    .all();
  return marked.length === 1 ? null : "used";
};

const forbidden = (requestId: string) =>
  Response.json(
    {
      error: "forbidden",
      message: "unknown, used or expired install state",
      request_id: requestId,
    },
    { status: 403 },
  );

/**
 * The install callback: a refused state answers 403 and exchanges no code; an accepted one shows the new App's
 * credentials with `Cache-Control: no-store` to the operator who started the flow (FD-OPS-074, FD-OPS-075).
 */
export const installCallback = (
  db: D1Like,
  url: URL,
  operator: AccessIdentity,
  now: number,
  requestId: string,
) =>
  Effect.gen(function* () {
    const state = url.searchParams.get("state");
    const code = url.searchParams.get("code");
    if (state === null || code === null) return forbidden(requestId);
    const refusal = yield* Effect.promise(() => acceptState(db, state, operator, now));
    if (refusal !== null) return forbidden(requestId);
    const credentials = yield* (yield* ManifestConversion).convert(code);
    const page = `<!doctype html><html><body>
<h1>GitHub App ${esc(credentials.slug)} created</h1>
<p>Set each value with <code>wrangler secret put</code>, then run <code>fd doctor</code>.</p>
<dl>
<dt>App id</dt><dd><code>${credentials.id}</code></dd>
<dt>GITHUB_APP_PRIVATE_KEY</dt><dd><pre>${esc(credentials.pem)}</pre></dd>
<dt>GITHUB_WEBHOOK_SECRET</dt><dd><code>${esc(credentials.webhookSecret)}</code></dd>
<dt>Client id</dt><dd><code>${esc(credentials.clientId)}</code></dd>
<dt>Client secret</dt><dd><code>${esc(credentials.clientSecret)}</code></dd>
</dl></body></html>`;
    return new Response(page, {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    });
  });
