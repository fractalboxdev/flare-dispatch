// FlareDispatch Dispatcher — `POST /v1/webhooks/signals/:source`.
//
// The PUSH-path signal ingress. Any observability vendor that can POST a JSON
// alert webhook (Datadog / SigNoz / Grafana / PagerDuty / …) triggers an
// immediate `ci-triage-pr` dispatch carrying that alert as a single
// `signals/v1` signal. The payload → signal mapping is CONFIGURATION
// (CONFIG_KV), not vendor code: the dispatcher stays vendor-blind, the same way
// the pull-path `signals/v1` contract keeps vendor query logic on the caller.
//
// --- Why a separate route, distinct from `/v1/dispatch/ci-triage-pr` ---------
//
// The Action-mode dispatch path requires an HMAC over the raw body — a vendor's
// generic webhook UI cannot produce our `X-FlareDispatch-Signature: sha256=…`
// scheme. Alert webhooks are the only cross-vendor quasi-standard, so the
// ingress meets them where they are: a static bearer token (CONFIG_KV) the
// operator pastes into the vendor's webhook custom-header config, and a
// CONFIG_KV-driven dot-path mapping that turns the vendor's arbitrary JSON into
// one `signals/v1` signal. After mapping, the signal is validated against the
// SAME core Schema the dispatch gate uses, then instantiated through the SAME
// `instantiateRun` path Action + Schedule mode share.
//
// --- Contract ----------------------------------------------------------------
//
//   404  `:source` not `^[a-z0-9-]{1,32}$`        — bad/unknown source label
//   503  CONFIG_KV / `signals.webhook.token` unset — ingress not configured
//   401  Authorization bearer missing/mismatch     — fail closed
//   400  body not valid JSON
//   422  payload yields no title AND no detail      — nothing to triage
//   202  accepted                                   — `{ executionId }`
//
// The `firedAt` carried into the dispatch is `Date.now()` (the ingest time) —
// an alert webhook has no schedule tick. The signal folds into the same daily,
// date-keyed `ci-triage-pr` draft PR: mid-day alerts UPDATE the same day's PR.
//
// Spec: specs/04-gha-integration.md § Signal ingress, packages/core signals.ts.

import { Either, Schema } from "effect";
import {
  MAX_SIGNAL_DETAIL_CHARS,
  MAX_SIGNAL_SOURCE_CHARS,
  MAX_SIGNAL_TITLE_CHARS,
  MAX_SIGNAL_URL_CHARS,
  Signal,
  type SignalT,
} from "@fractalboxdev/flare-dispatch-core";
import type { Env } from "../env";
import { constantTimeEqual } from "../hmac";
import { instantiateRun } from "../instantiate";

/** CONFIG_KV key holding the shared ingress bearer token. */
const TOKEN_KEY = "signals.webhook.token";
/** CONFIG_KV key prefix holding the per-source mapping template. */
const MAP_KEY_PREFIX = "signals.map.";
/** The run every ingress dispatches. */
const TARGET_RUN = "ci-triage-pr";
/** Allowed `:source` label shape — an operator-chosen, path-safe slug. */
const SOURCE_RE = /^[a-z0-9-]{1,32}$/;

const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const BEARER_PREFIX = "Bearer ";

/** Extract the bearer token from an `Authorization` header (`null` if absent). */
const bearerToken = (header: string | null): string | null =>
  header !== null && header.startsWith(BEARER_PREFIX)
    ? header.slice(BEARER_PREFIX.length)
    : null;

// --- Dot-path resolution -----------------------------------------------------

/**
 * Resolve a dot-path (e.g. `alert.title`, `items.0.name`) against a parsed JSON
 * value. Array indices are plain integer segments. Returns `undefined` for any
 * missing/non-traversable segment — the mapper omits the field rather than
 * emitting `undefined`.
 */
const resolvePath = (root: unknown, path: string): unknown => {
  let cur: unknown = root;
  for (const seg of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    if (Array.isArray(cur)) {
      const idx = Number(seg);
      if (!Number.isInteger(idx) || idx < 0 || idx >= cur.length) return undefined;
      cur = cur[idx];
    } else {
      if (!Object.prototype.hasOwnProperty.call(cur, seg)) return undefined;
      cur = (cur as Record<string, unknown>)[seg];
    }
  }
  return cur;
};

const PATH_PREFIX = "$.";

/**
 * Resolve one template value against the payload. A `"$."`-prefixed string is a
 * dot-path reference; anything else is a literal. A path that resolves to an
 * object/array is JSON-stringified (so a template can lift a sub-tree into
 * `detail`); a primitive is stringified directly. A missing path → `undefined`
 * (field omitted by the caller).
 */
const resolveTemplateValue = (
  template: unknown,
  payload: unknown,
): string | number | undefined => {
  if (typeof template !== "string") return undefined;
  if (!template.startsWith(PATH_PREFIX)) return template; // literal
  const resolved = resolvePath(payload, template.slice(PATH_PREFIX.length));
  if (resolved === undefined || resolved === null) return undefined;
  if (typeof resolved === "number") return resolved;
  if (typeof resolved === "string") return resolved;
  if (typeof resolved === "boolean") return String(resolved);
  return JSON.stringify(resolved);
};

// --- Default mapping ---------------------------------------------------------

/** First present string field among the candidates, for the default mapping. */
const firstString = (
  payload: Record<string, unknown>,
  keys: readonly string[],
): string | undefined => {
  for (const k of keys) {
    const v = payload[k];
    if (typeof v === "string" && v.length > 0) return v;
    if (typeof v === "number") return String(v);
  }
  return undefined;
};

/** A bounded JSON excerpt of the payload — the default-mapping `detail` floor. */
const jsonExcerpt = (payload: unknown): string => {
  try {
    return JSON.stringify(payload);
  } catch {
    return String(payload);
  }
};

/**
 * Map a payload with NO configured `signals.map.<source>` — best-effort across
 * the common alert-webhook field names, falling back to a JSON excerpt for
 * `detail` so an unrecognized shape still yields a triageable signal.
 */
const mapDefault = (
  payload: unknown,
): { title?: string; detail?: string; url?: string; count?: number } => {
  const obj =
    payload !== null && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  const title = firstString(obj, ["title", "alert", "message", "summary", "name"]);
  const detailRaw = firstString(obj, ["body", "description", "text", "detail", "message"]);
  const url = firstString(obj, ["url", "link", "alert_url", "permalink"]);
  const countRaw = obj.count;
  const count = typeof countRaw === "number" ? countRaw : undefined;
  // `detail` always derivable: a recognized field, else a JSON excerpt.
  const detail = detailRaw ?? jsonExcerpt(payload);
  return {
    ...(title !== undefined ? { title } : {}),
    detail,
    ...(url !== undefined ? { url } : {}),
    ...(count !== undefined ? { count } : {}),
  };
};

/**
 * Apply a configured object template (string values are `"$."` paths or
 * literals) to the payload. Only the four `signals/v1` body fields are honored;
 * unknown template keys are ignored.
 */
const applyTemplate = (
  template: Record<string, unknown>,
  payload: unknown,
): { title?: string; detail?: string; url?: string; count?: number } => {
  const out: { title?: string; detail?: string; url?: string; count?: number } = {};
  const title = resolveTemplateValue(template.title, payload);
  if (typeof title === "string") out.title = title;
  else if (typeof title === "number") out.title = String(title);
  const detail = resolveTemplateValue(template.detail, payload);
  if (typeof detail === "string") out.detail = detail;
  else if (typeof detail === "number") out.detail = String(detail);
  const url = resolveTemplateValue(template.url, payload);
  if (typeof url === "string") out.url = url;
  else if (typeof url === "number") out.url = String(url);
  const count = resolveTemplateValue(template.count, payload);
  if (typeof count === "number") out.count = count;
  return out;
};

/** Truncate to a cap — clamp, never reject (spec: signals/v1 caps). */
const clamp = (s: string, max: number): string =>
  s.length > max ? s.slice(0, max) : s;

/**
 * Build a validated `signals/v1` signal from a payload + source label. Returns
 * the signal, or `undefined` when the payload yields neither a title nor a
 * derivable detail (→ 422). The `source` field is always `webhook:<source>`.
 */
const buildSignal = (
  source: string,
  template: Record<string, unknown> | undefined,
  payload: unknown,
): SignalT | undefined => {
  const mapped =
    template !== undefined ? applyTemplate(template, payload) : mapDefault(payload);

  // Unmappable: a custom template that resolved no title AND no detail. (The
  // default mapping always produces a detail floor, so this only bites a
  // configured template that pointed at absent paths.)
  if (mapped.title === undefined && mapped.detail === undefined) return undefined;

  // A signal needs both `title` and `detail` (required by the Schema). Derive
  // the missing one from the other so a single-field template still validates.
  const title = mapped.title ?? mapped.detail!;
  const detail = mapped.detail ?? mapped.title!;

  const candidate = {
    source: clamp(`webhook:${source}`, MAX_SIGNAL_SOURCE_CHARS),
    title: clamp(title, MAX_SIGNAL_TITLE_CHARS),
    detail: clamp(detail, MAX_SIGNAL_DETAIL_CHARS),
    ...(mapped.url !== undefined
      ? { url: clamp(mapped.url, MAX_SIGNAL_URL_CHARS) }
      : {}),
    ...(mapped.count !== undefined ? { count: mapped.count } : {}),
  };

  // Validate against the SAME core Schema the dispatch gate uses. Clamping
  // already enforced the caps, so this should always pass — but a future cap
  // tightening or a non-finite count is caught here rather than downstream.
  return Either.getOrUndefined(Schema.decodeUnknownEither(Signal)(candidate));
};

// --- SHA-256 of the raw body (the dedup fallback) ----------------------------

const sha256Hex = async (bytes: ArrayBuffer): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
};

/**
 * A delivery id from a common vendor header (so vendor RETRIES dedupe) — else
 * `undefined`, signalling the SHA-256-of-body fallback (so DISTINCT alerts
 * don't collide).
 */
const deliveryHeader = (request: Request): string | undefined => {
  for (const h of ["X-Delivery-Id", "X-Request-Id", "X-Message-Id"]) {
    const v = request.headers.get(h);
    if (v !== null && v.length > 0) return v;
  }
  return undefined;
};

/**
 * Handle `POST /v1/webhooks/signals/:source`.
 *
 * The whole handler is total — every branch returns a `Response`, no uncaught
 * throw escapes (`instantiateRun` only throws on a non-duplicate `create`
 * failure, which the runtime's top-level handler converts to a 500; that is the
 * one intentional propagation, matching dispatch.ts).
 */
export const handleSignalsWebhook = async (
  request: Request,
  env: Env,
  source: string,
): Promise<Response> => {
  // 1. Validate the `:source` label BEFORE anything else — a malformed label
  //    is a 404 (the route shape is wrong), not an auth failure.
  if (!SOURCE_RE.test(source)) {
    return json(
      { error: "not_found", message: "source must match ^[a-z0-9-]{1,32}$" },
      404,
    );
  }

  // 2. Fail closed if the ingress is not configured. No CONFIG_KV, or no
  //    `signals.webhook.token`, means the operator hasn't turned ingress on.
  if (env.CONFIG_KV === undefined) {
    return json(
      {
        error: "ingress_not_configured",
        message: "CONFIG_KV is unbound; signal ingress is off on this deploy",
      },
      503,
    );
  }
  const expectedToken = await env.CONFIG_KV.get(TOKEN_KEY);
  if (expectedToken === null || expectedToken.length === 0) {
    return json(
      {
        error: "ingress_not_configured",
        message: `${TOKEN_KEY} is unset; signal ingress is off on this deploy`,
      },
      503,
    );
  }

  // 3. Static bearer auth — constant-time compare against the configured token.
  const presented = bearerToken(request.headers.get("Authorization"));
  const authOk = await constantTimeEqual(presented, expectedToken);
  if (!authOk) {
    return json(
      {
        error: "unauthorized",
        message: "Authorization bearer token missing or invalid",
      },
      401,
    );
  }

  // 4. Read raw bytes ONCE (the SHA-256 dedup fallback needs them), then parse.
  const rawBody = await request.arrayBuffer();
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(rawBody));
  } catch (cause) {
    return json(
      {
        error: "invalid_body",
        message: "request body is not valid JSON",
        detail: cause instanceof Error ? cause.message : String(cause),
      },
      400,
    );
  }

  // 5. Resolve the per-source mapping template (a JSON object) — absent or
  //    unparseable → the default mapping.
  const rawTemplate = await env.CONFIG_KV.get(`${MAP_KEY_PREFIX}${source}`);
  let template: Record<string, unknown> | undefined;
  if (rawTemplate !== null && rawTemplate.length > 0) {
    try {
      const parsed: unknown = JSON.parse(rawTemplate);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        template = parsed as Record<string, unknown>;
      }
    } catch {
      // Malformed mapping config — fall back to the default mapping rather than
      // failing the alert; a 503/500 here would silently drop alerts on a typo.
      template = undefined;
    }
  }

  // 6. Map → clamp → validate. An unmappable payload (no title, no detail) → 422.
  const signal = buildSignal(source, template, payload);
  if (signal === undefined) {
    return json(
      {
        error: "unmappable_payload",
        message:
          "payload yielded neither a title nor a derivable detail; check signals.map." +
          source,
      },
      422,
    );
  }

  // 7. Dedup key: a vendor delivery header (retries collapse) else SHA-256 of
  //    the raw body (distinct alerts stay distinct), prefixed `signals:<source>:`.
  const delivery = deliveryHeader(request) ?? (await sha256Hex(rawBody));
  const executionId = `signals:${source}:${delivery}`;

  // 8. Instantiate through the SAME RunWorkflow path Action + Schedule mode use.
  //    The github context is fabricated (a webhook ingress has no repo/sha),
  //    following the schedule-mode precedent (routes/scheduled.ts): the run's
  //    own config carries the report repo; this block is executions-row metadata
  //    + the (no-op) check-run Layer.
  const { detailsUrl } = await instantiateRun(env, {
    executionId,
    run: TARGET_RUN,
    github: {
      repo: `signals/${source}`,
      ref: "refs/heads/main",
      sha: "signals",
    },
    inputs: { firedAt: Date.now(), signals: [signal] },
    origin: env.PUBLIC_ORIGIN ?? new URL(request.url).origin,
  });

  return json(
    { executionId, ...(detailsUrl !== undefined ? { detailsUrl } : {}) },
    202,
  );
};
