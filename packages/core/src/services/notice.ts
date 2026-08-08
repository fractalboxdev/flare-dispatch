// @fractalboxdev/flare-dispatch-core — the `notice` capability (say something, out loud).
//
// A run that produced something people should read has, until now, had exactly
// one way to say so: write a file and open a PR. That is the right *record* and
// the wrong *announcement* — a digest nobody is told about is a digest nobody
// reads.
//
// The obvious fix is not available and must not become available. This
// dispatcher holds no Slack credential, on purpose and in two places
// (`apps/dispatcher/src/slack-notify.ts`, substrate ADR-0006), so a run cannot
// be handed one. What it gets instead is this: a way to say *what* to publish
// and *what kind of thing it is*, and nothing about where it lands.
//
// --- The shape is the security property --------------------------------------
//
//   notice.publish({ useCase, text, dedupeKey, links })
//
// There is no channel field, no thread, no recipient, and no URL. `useCase` is
// a routing KEY, resolved against a map that lives in the receiver's own
// deployment config; a run naming `C0ABCDEF` names a use case that does not
// exist and is refused. That is the whole reason the field is not a
// destination: the emit side is the untrusted half — its `text` is model
// authored — so it may describe what it wants said, never who hears it.
//
// `text` is DATA, not markup. The receiver escapes it (`&`, `<`, `>`) before it
// reaches Slack, which is what neutralizes `<!channel>` and friends. A run must
// therefore NOT hand-build markup here — links that need to survive ride in the
// typed `links[]` field and are rendered by the receiver from a validated URL.
//
// --- Best-effort, like `email` and `checks` -----------------------------------
//
// `publish` is **total** — no error channel. A notice that did not land is a
// logged line and a `delivered: false` result, never a flipped verdict: the
// run's real output is already recorded (a PR, a check-run, a D1 row) and an
// announcement failing must not retroactively make that work a failure. A
// deploy with no notice backend configured degrades to `skipped: true`, exactly
// as `email.send` does without an Email Routing binding.
//
// --- `dedupeKey`: at-most-once is the caller's job too ------------------------
//
// The receiver claims a delivery id before it posts, so the guarantee it offers
// is "at most one post per delivery id". That guarantee is worth nothing if the
// id changes on every attempt — and a Workflow step CAN be retried, which is
// precisely the case it exists to cover. So the caller supplies the stable half
// of the id and the runtime Layer prefixes the run name onto it. A scheduled
// run's day string is the natural value: the same intended post keeps its id
// across a retry, and tomorrow's post gets a different one.
//
// A random id, or one derived from `Date.now()`, would defeat the receiver's
// dedup and double-post on the first retry.
//
// Contract (the receiver's half): fractalbot `specs/flare-dispatch-notify.md`.

import { Context, Effect } from "effect";

/**
 * A link that must survive into the published message. Rendered by the
 * RECEIVER from these fields — never by the caller, because caller-authored
 * markup inside `text` is escaped along with everything else in it.
 */
export type NoticeLink = {
  /** Absolute `https://` URL. */
  readonly url: string;
  /** Short human label, e.g. `"the questions PR"`. */
  readonly label: string;
};

/** One thing a run wants said. */
export type NoticeRequest = {
  /**
   * WHAT KIND of notice this is — the routing key the receiver resolves to a
   * destination it chose. Lowercase kebab-case. Never a channel, a user, or a
   * URL: naming a destination is not a thing a run is allowed to do.
   */
  readonly useCase: string;
  /**
   * The message body, as data. The receiver escapes it and owns presentation,
   * so do not build markup here — put links in `links`.
   */
  readonly text: string;
  /**
   * What makes this notice *this* notice. Stable across a retry of the same
   * intended post, different for the next one — a scheduled run's day string
   * is the canonical value. Combined with the run name into the delivery id
   * the receiver dedups on.
   */
  readonly dedupeKey: string;
  /** Up to a handful of links, rendered by the receiver. */
  readonly links?: readonly NoticeLink[];
};

/**
 * What one `publish` did. `delivered` and `duplicate` are both successes from
 * the caller's point of view — a duplicate means the message is already out
 * there, which is the outcome that was wanted. `skipped` means the deploy has
 * no notice backend at all.
 */
export type NoticeResult = {
  /** `true` when the receiver accepted and posted it. */
  readonly delivered: boolean;
  /** `true` when the receiver had already accepted this delivery id. */
  readonly duplicate: boolean;
  /** `true` when this deploy has no notice backend configured — a logged no-op. */
  readonly skipped: boolean;
  /** Why it did not land, when it did not. */
  readonly reason?: string;
};

/** The service contract a runtime Layer implements. Total — no error channel. */
export interface NoticeService {
  readonly publish: (req: NoticeRequest) => Effect.Effect<NoticeResult>;
}

/** Context.Tag — the notice dependency a run carries until a Layer provides it. */
export class Notice extends Context.Tag("@fractalboxdev/flare-dispatch-core/Notice")<
  Notice,
  NoticeService
>() {}

/**
 * The `notice` accessor namespace — reads the Notice service from context and
 * delegates, so a run writes `notice.publish(...)` rather than the explicit
 * `Effect.flatMap(Notice, ...)`.
 */
export const notice = {
  publish: (req: NoticeRequest) => Effect.flatMap(Notice, (s) => s.publish(req)),
} as const;
