// @fractalboxdev/flare-dispatch-demo-agent — Browser Rendering rrweb recording REST client.
//
// When a Browser Rendering CDP connect URL carries `?recording=true`, the
// platform records the session as a stream of rrweb DOM events for its entire
// lifetime. The events are only fetchable after the session closes, via
//
//   GET https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/browser-rendering/recording/<SESSION_ID>
//
// (or a custom REST base when the operator runs against a non-public Browser
// Rendering endpoint). This module owns that one HTTP call: retry while the
// platform is still finalizing, return the event array, map every failure
// mode to a tagged `RecordingFetchFailed`.
//
// The two env vars driving the REST fetch:
//   * `CLOUDFLARE_ACCOUNT_ID`           — the account the session lives under
//   * `CLOUDFLARE_API_TOKEN`            — same token used in BROWSER_CDP_API_TOKEN
// An optional `BROWSER_RECORDING_API_BASE` overrides the default
// https://api.cloudflare.com base — useful for staging tests.

import { Effect, Schedule } from "effect";
import { MissingEnv, RecordingFetchFailed } from "./errors.js";

const DEFAULT_API_BASE = "https://api.cloudflare.com";

export type RecordingFetchConfig = {
  readonly accountId: string;
  readonly apiToken: string;
  readonly apiBase?: string;
  /** Inject a fetch impl for tests; defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
};

/** Read the REST-fetch config from process.env, or `MissingEnv` on first gap. */
export const configFromEnv = (
  env: NodeJS.ProcessEnv,
): Effect.Effect<RecordingFetchConfig, MissingEnv> =>
  Effect.gen(function* () {
    const accountId = env.CLOUDFLARE_ACCOUNT_ID;
    const apiToken = env.CLOUDFLARE_API_TOKEN;
    if (accountId === undefined || accountId === "") {
      return yield* Effect.fail(new MissingEnv({ name: "CLOUDFLARE_ACCOUNT_ID" }));
    }
    if (apiToken === undefined || apiToken === "") {
      return yield* Effect.fail(new MissingEnv({ name: "CLOUDFLARE_API_TOKEN" }));
    }
    return {
      accountId,
      apiToken,
      apiBase: env.BROWSER_RECORDING_API_BASE,
    };
  });

const classifyHttpStatus = (
  status: number,
): RecordingFetchFailed["reason"] => {
  if (status === 401 || status === 403) return "auth-failed";
  if (status === 404) return "not-found";
  if (status === 425 || status === 202 || status === 503)
    return "still-processing";
  return "unknown";
};

/**
 * Fetch the rrweb event stream for `sessionId`. Retries with exponential
 * backoff while the platform reports `still-processing` (capped at 6 attempts
 * over ~12 s) — Browser Rendering finalizes recordings asynchronously after
 * `Browser.close`.
 */
export const fetchRecording = (
  sessionId: string,
  config: RecordingFetchConfig,
): Effect.Effect<readonly unknown[], RecordingFetchFailed> => {
  const base = config.apiBase ?? DEFAULT_API_BASE;
  const url = `${base}/client/v4/accounts/${config.accountId}/browser-rendering/recording/${sessionId}`;
  const fetchImpl = config.fetchImpl ?? fetch;

  const attempt: Effect.Effect<readonly unknown[], RecordingFetchFailed> =
    Effect.gen(function* () {
      const res = yield* Effect.tryPromise({
        try: () =>
          fetchImpl(url, {
            method: "GET",
            headers: {
              Authorization: `Bearer ${config.apiToken}`,
              Accept: "application/json",
            },
          }),
        catch: (e) =>
          new RecordingFetchFailed({
            sessionId,
            reason: "unknown",
            message: e instanceof Error ? e.message : String(e),
          }),
      });

      if (!res.ok) {
        const text = yield* Effect.promise(() => res.text().catch(() => ""));
        return yield* Effect.fail(
          new RecordingFetchFailed({
            sessionId,
            reason: classifyHttpStatus(res.status),
            message: `HTTP ${res.status}: ${text.slice(0, 200)}`,
          }),
        );
      }

      const body = yield* Effect.tryPromise({
        try: () => res.json() as Promise<unknown>,
        catch: (e) =>
          new RecordingFetchFailed({
            sessionId,
            reason: "malformed",
            message: e instanceof Error ? e.message : String(e),
          }),
      });

      const events = extractEvents(body);
      if (events === null) {
        return yield* Effect.fail(
          new RecordingFetchFailed({
            sessionId,
            reason: "malformed",
            message: `expected { result: { events: [] } } or { events: [] }, got ${truncate(body)}`,
          }),
        );
      }
      return events;
    });

  return attempt.pipe(
    Effect.retry({
      while: (e: RecordingFetchFailed) => e.reason === "still-processing",
      schedule: Schedule.exponential("1 second").pipe(
        Schedule.compose(Schedule.recurs(5)),
      ),
    }),
  );
};

/**
 * Cloudflare's REST envelope is `{ result, success, errors, messages }`.
 * Tolerate either `result.events` (canonical) or a bare `events` array
 * (mock-friendly).
 */
const extractEvents = (body: unknown): readonly unknown[] | null => {
  if (body === null || typeof body !== "object") return null;
  const obj = body as Record<string, unknown>;
  const fromShape = (events: unknown): readonly unknown[] | null => {
    if (Array.isArray(events)) return events;
    // LIVE API shape (verified against the real endpoint): `events` is a MAP
    // of targetId → rrweb event array — one stream per page/target. Flatten
    // all targets and order by rrweb `timestamp` so the replay plays as one
    // continuous timeline.
    if (events !== null && typeof events === "object") {
      const flattened = Object.values(events as Record<string, unknown>)
        .filter(Array.isArray)
        .flat();
      return [...flattened].sort((a, b) => {
        const ta = (a as { timestamp?: number }).timestamp ?? 0;
        const tb = (b as { timestamp?: number }).timestamp ?? 0;
        return ta - tb;
      });
    }
    return null;
  };
  const direct = fromShape(obj["events"]);
  if (direct !== null) return direct;
  const result = obj["result"];
  if (result !== null && typeof result === "object") {
    return fromShape((result as Record<string, unknown>)["events"]);
  }
  return null;
};

const truncate = (v: unknown): string => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > 200 ? `${s.slice(0, 200)}…` : s;
};
