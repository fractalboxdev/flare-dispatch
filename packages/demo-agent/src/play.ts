// @fractalboxdev/flare-dispatch-demo-agent — the play loop.
//
// One story = one bounded loop:
//
//   record chapterStartMs (wall-clock since Browser Rendering opened the
//                          session — Date.now() at attach time);
//   loop until done | max-actions | max-sec:
//     snapshot accessibility tree
//     ask the model (via @effect/ai's LanguageModel): next action?
//     apply via CDP
//     append to history (oldest first)
//     if the model said "screenshot", save it as the key screenshot path
//   record chapterEndMs
//   emit one JSON line on stdout (PlayOutput shape)
//
// The CdpSession interface keeps the loop unit-testable — `runPlayLoop` takes
// a fake session in tests, a real puppeteer-backed one in the CLI entry.

import type { LanguageModel } from "@effect/ai";
import { Effect, Match } from "effect";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import type { CdpSession } from "./cdp.js";
import { pickNextAction } from "./model.js";
import { FsFailed, type AgentError } from "./errors.js";
import type { ModelAction, PlayOutput } from "./schemas.js";

export type PlayInput = {
  readonly name: string;
  readonly prose: string;
  readonly screenshotsDir: string;
  readonly maxSec: number;
  /** Hard ceiling on action count regardless of time. Default 20. */
  readonly maxActions?: number;
  /** Wall-clock at session attach time — chapter offsets ride off this. */
  readonly attachedAtMs: number;
  /**
   * The app-under-test URL. If the page is still on `about:blank` when the
   * story starts (the first story, or a session that didn't carry navigation
   * across the connect boundary), the loop navigates here ONCE so the agent
   * has the real app to drive instead of a blank page.
   */
  readonly startUrl?: string;
  /**
   * Optional GIF-frame capture directory. When set, the loop saves a PNG
   * frame after the initial navigation and after every applied action into
   * `${framesDir}/${name}-NNNN.png` (zero-padded, story-name-prefixed so a
   * later glob sorts chapters in order). These frames are the source the
   * `demo-agent gif` subcommand stitches into the walkthrough GIF embedded in
   * the PR comment — separate from `keyScreenshotPath` (one key frame). Frame
   * capture is best-effort: a failed screenshot is ignored so it never sinks
   * the story. Unset ⇒ no frames (the pre-GIF behaviour, unchanged).
   */
  readonly framesDir?: string;
};

export type PlayDeps = {
  readonly session: CdpSession;
  /**
   * Inject the action picker for tests. Defaults to the live `pickNextAction`
   * which calls the configured `LanguageModel` provider Layer.
   */
  readonly pickAction?: typeof pickNextAction;
  /** Current wall-clock; defaults to `Date.now`. */
  readonly now?: () => number;
};

// Per-story action budget. Rich product-demo chapters (open a game, fill the
// creative form, generate, navigate to the library, verify the critic grid,
// switch aspect tabs, screenshot) legitimately need 40-60 model actions; at 40
// the heaviest chapters intermittently ran out mid-journey ("did not signal
// done after 40 actions") even though they finished well inside the time
// budget. 80 gives ~2x headroom over a chapter's observed action count.
// Callers can still override via `input.maxActions`.
const MAX_ACTIONS_DEFAULT = 80;
const FINAL_KEY_SCREENSHOT_FALLBACK = "final.png";

/**
 * Run the play loop for one story. Returns a fully-shaped `PlayOutput`; even
 * the failure paths (timeout, model error, CDP error) resolve to a
 * structured `{ status: "failed" }` so the run's `Effect.forEach` over
 * stories doesn't short-circuit on one bad story.
 */
export const runPlayLoop = (
  input: PlayInput,
  deps: PlayDeps,
): Effect.Effect<PlayOutput, FsFailed, LanguageModel.LanguageModel> =>
  Effect.gen(function* () {
    const now = deps.now ?? (() => Date.now());
    const pick = deps.pickAction ?? pickNextAction;
    const maxActions = input.maxActions ?? MAX_ACTIONS_DEFAULT;
    const chapterStartMs = now() - input.attachedAtMs;
    const startMs = now();
    const deadlineMs = startMs + input.maxSec * 1_000;

    yield* ensureDir(input.screenshotsDir);
    if (input.framesDir !== undefined) yield* ensureDir(input.framesDir);

    // Best-effort GIF-frame capture. Each call saves one PNG into `framesDir`
    // under a zero-padded, story-prefixed name so a cross-story glob sorts the
    // walkthrough in chapter order. A capture failure is swallowed — a missing
    // frame must never fail the story (the GIF is a reporting nicety, the
    // verdict is the verdict). No-op when `framesDir` is unset.
    let frameSeq = 0;
    const captureFrame = (): Effect.Effect<void, never> =>
      input.framesDir === undefined
        ? Effect.void
        : deps.session
            .screenshot(
              path.join(
                input.framesDir,
                `${input.name}-${String(frameSeq++).padStart(4, "0")}.png`,
              ),
            )
            .pipe(Effect.ignore);

    // If the page is still blank (first story, or navigation didn't carry
    // across the connect boundary), load the app under test ONCE — otherwise
    // the agent drives about:blank and has nothing to do.
    if (input.startUrl !== undefined) {
      const url = yield* deps.session.currentUrl();
      if (url === "about:blank" || url === "" || url === "chrome://newtab/") {
        yield* deps.session.goto(input.startUrl).pipe(Effect.ignore);
      }
    }

    // Opening frame — the loaded app before the agent's first action, so even
    // a one-action story yields a watchable two-frame GIF.
    yield* captureFrame();

    const history: string[] = [];
    let keyScreenshotPath: string | undefined;
    let narrative = "";
    let status: PlayOutput["status"] = "failed";
    let terminated: "done" | "max-actions" | "max-sec" | "error" =
      "max-actions";

    for (let i = 0; i < maxActions; i++) {
      const secsRemaining = Math.max(0, Math.round((deadlineMs - now()) / 1_000));
      if (secsRemaining === 0) {
        terminated = "max-sec";
        break;
      }

      // 1. Snapshot the page. CDP errors here mean we can't see the page,
      //    which is unrecoverable for this story — emit failed and exit.
      const snapshotResult = yield* deps.session.accessibilitySnapshot().pipe(
        Effect.either,
      );
      if (snapshotResult._tag === "Left") {
        narrative = `CDP error snapshotting page: ${snapshotResult.left.message}`;
        terminated = "error";
        break;
      }

      // 2. Ask the model for the next action. Same logic — a model error
      //    fails the story, not the whole run.
      const actionResult = yield* pick({
        prose: input.prose,
        snapshot: snapshotResult.right,
        history: [...history],
        secsRemaining,
      }).pipe(Effect.either);

      if (actionResult._tag === "Left") {
        narrative = `model error: ${actionResult.left.message}`;
        terminated = "error";
        break;
      }
      const action = actionResult.right;

      // 3. Apply the action. `done` exits the loop; other actions go through
      //    the CDP session and append to history.
      const applyResult = yield* applyAction(action, deps.session, {
        screenshotsDir: input.screenshotsDir,
        storyName: input.name,
      }).pipe(Effect.either);

      if (applyResult._tag === "Left") {
        const tag = (applyResult.left as { _tag?: string })._tag ?? "AgentError";
        narrative = `${tag} applying ${action.type}: ${describeError(applyResult.left)}`;
        terminated = "error";
        break;
      }

      const applied = applyResult.right;
      if (applied.kind === "screenshot") {
        keyScreenshotPath = applied.path;
      }
      history.push(describeAction(action));

      // Capture the post-action page state as a GIF frame (best-effort).
      yield* captureFrame();

      if (action.type === "done") {
        narrative = action.narrative;
        status = action.status;
        terminated = "done";
        break;
      }
    }

    // 4. Always take a final screenshot — if the model never emitted one
    //    explicitly, this becomes the key-screenshot fallback.
    if (keyScreenshotPath === undefined) {
      const fallback = path.join(
        input.screenshotsDir,
        `${input.name}.${FINAL_KEY_SCREENSHOT_FALLBACK}`,
      );
      const sc = yield* deps.session.screenshot(fallback).pipe(Effect.either);
      if (sc._tag === "Right") {
        keyScreenshotPath = fallback;
      } else {
        keyScreenshotPath = "";
      }
    }

    const endNow = now();
    const chapterEndMs = endNow - input.attachedAtMs;
    const durationMs = endNow - startMs;

    if (terminated === "max-actions" || terminated === "max-sec") {
      narrative =
        narrative ||
        `story did not signal done after ${maxActions} actions / ${input.maxSec}s budget`;
    }

    return {
      status,
      durationMs,
      chapterStartMs,
      chapterEndMs,
      narrative,
      keyScreenshotPath,
    };
  });

type Applied =
  | { kind: "applied" }
  | { kind: "screenshot"; path: string }
  | { kind: "done" };

const applyAction = (
  action: ModelAction,
  session: CdpSession,
  ctx: { readonly screenshotsDir: string; readonly storyName: string },
): Effect.Effect<Applied, AgentError> =>
  Match.value(action).pipe(
    Match.discriminatorsExhaustive("type")({
      click: ({ target }) =>
        session.click(target).pipe(Effect.as({ kind: "applied" as const })),
      type: ({ target, text }) =>
        session
          .type(target, text)
          .pipe(Effect.as({ kind: "applied" as const })),
      nav: ({ url }) =>
        session.goto(url).pipe(Effect.as({ kind: "applied" as const })),
      key: ({ key }) =>
        session.key(key).pipe(Effect.as({ kind: "applied" as const })),
      wait: ({ ms }) =>
        session.wait(ms).pipe(Effect.as({ kind: "applied" as const })),
      screenshot: () => {
        const target = path.join(ctx.screenshotsDir, `${ctx.storyName}.png`);
        return session
          .screenshot(target)
          .pipe(Effect.as({ kind: "screenshot" as const, path: target }));
      },
      done: () => Effect.succeed({ kind: "done" as const }),
    }),
  );

const describeAction = (action: ModelAction): string =>
  Match.value(action).pipe(
    Match.discriminatorsExhaustive("type")({
      click: ({ target }) => `click ${target}`,
      type: ({ target, text }) =>
        `type "${text.length > 24 ? `${text.slice(0, 24)}…` : text}" into ${target}`,
      nav: ({ url }) => `nav ${url}`,
      key: ({ key }) => `key ${key}`,
      wait: ({ ms }) => `wait ${ms}ms`,
      screenshot: () => "screenshot (key frame)",
      done: ({ status }) => `done (${status})`,
    }),
  );

const describeError = (e: unknown): string =>
  typeof e === "object" && e !== null && "message" in e
    ? String((e as { message?: unknown }).message)
    : String(e);

const ensureDir = (dir: string): Effect.Effect<void, FsFailed> =>
  Effect.tryPromise({
    try: () => fs.mkdir(dir, { recursive: true }).then(() => undefined),
    catch: (e) =>
      new FsFailed({
        path: dir,
        op: "mkdir",
        message: e instanceof Error ? e.message : String(e),
      }),
  });
