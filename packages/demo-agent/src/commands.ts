// @fractalboxdev/flare-dispatch-demo-agent — @effect/cli subcommand definitions.
//
// Seven subcommands the `product-demo` run shells out to:
//   record start | record stop | play | gif | summarize | write-json | write-prior
//
// Each subcommand:
//   * decodes options via `@effect/cli`,
//   * runs the platform logic (attachCdp, runPlayLoop, fetchRecording,
//     summarizeStories, fs.writeFile),
//   * emits its JSON contract on stdout (`record stop`, `play`) or its
//     markdown payload (`summarize`),
//   * maps every tagged error to a one-line stderr message + non-zero exit.

import * as Command from "@effect/cli/Command";
import * as Options from "@effect/cli/Options";
import { Console, Effect, Match, Option } from "effect";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { attachCdp, applyViewport } from "./cdp.js";
import { ViewportPreset } from "./schemas.js";
import {
  configFromEnv as recordingConfigFromEnv,
  fetchRecording,
} from "./recorder.js";
import { runPlayLoop } from "./play.js";
import { renderGifFromDir } from "./gif.js";
import { makeLanguageModelLayer, summarizeStories } from "./model.js";
import { type AgentError, FsFailed } from "./errors.js";
import { StoriesJson } from "./schemas.js";
import { Schema } from "effect";

// ---------------------------------------------------------------------------
// Option declarations — shared across subcommands.

const cdpWsOption = Options.text("cdp-ws").pipe(
  Options.withDescription(
    "Browser Rendering CDP WebSocket endpoint (wss://...?recording=true)",
  ),
);
const outOption = Options.text("out").pipe(
  Options.withDescription("Output file path."),
);
const sessionIdOutOption = Options.text("session-id-out").pipe(
  Options.withDescription("Where to write the captured Browser Rendering session id."),
);
const sessionIdInOption = Options.text("session-id-in").pipe(
  Options.withDescription("File written by `record start` with the session id."),
);
const viewportOption = Options.choice("viewport", ["desktop", "mobile"]).pipe(
  Options.withDescription("Viewport preset — passed to Emulation.setDeviceMetricsOverride."),
  Options.withDefault("desktop" as const),
);
const dataOption = Options.text("data").pipe(
  Options.withDescription("Inline payload (JSON for write-json, markdown for write-prior)."),
);
const nameOption = Options.text("name").pipe(
  Options.withDescription("Story name — becomes the chapter marker."),
);
const proseOption = Options.text("prose").pipe(
  Options.withDescription("Story prose the model walks through."),
);
const screenshotsOption = Options.text("screenshots").pipe(
  Options.withDescription("Directory for per-story screenshots."),
);
const framesDirOption = Options.text("frames-dir").pipe(
  Options.withDescription(
    "Optional: directory to save a PNG frame after every action — the source the `gif` subcommand stitches into the walkthrough GIF. Omit to skip frame capture.",
  ),
  Options.optional,
);
const maxSecOption = Options.integer("max-sec").pipe(
  Options.withDescription("Per-story wall-clock ceiling in seconds."),
);
const storiesJsonOption = Options.text("stories-json").pipe(
  Options.withDescription("Path to the stories.json the summarizer reads."),
);
const modelOption = Options.text("model").pipe(
  Options.withDescription(
    "Provider model id (e.g. `gpt-4o`, `claude-opus-4-7`, `@cf/meta/llama-3.1-70b-instruct`). The string passes through to the configured `LanguageModel` layer verbatim.",
  ),
);
const previousOption = Options.text("previous").pipe(
  Options.optional,
  Options.withDescription("Optional: path to previous run's summary markdown."),
);

const urlOption = Options.text("url").pipe(
  Options.withDescription(
    "Optional: navigate the session to this URL before the stories run, so they start on the app under test rather than about:blank.",
  ),
  Options.optional,
);

const explicitSessionIdOption = Options.text("session-id").pipe(
  Options.withDescription(
    "REQUIRED: the REAL Browser Run session id (from the dispatcher's recording pre-acquire). `record start` writes it verbatim and `record stop` fetches the recording by it — the CDP-derived fallback id is NOT recognised by the Session Recording REST API, so persisting it would write a session id no recording can ever be fetched by.",
  ),
);

// ---------------------------------------------------------------------------
// `record start`

const recordStart = Command.make(
  "start",
  {
    cdpWs: cdpWsOption,
    viewport: viewportOption,
    sessionIdOut: sessionIdOutOption,
    url: urlOption,
    sessionId: explicitSessionIdOption,
  },
  ({ cdpWs, viewport, sessionIdOut, url, sessionId }) =>
    Effect.gen(function* () {
      const { session, page } = yield* attachCdp(
        cdpWs,
        Option.getOrUndefined(url),
      );
      yield* applyViewport(page, viewport as ViewportPreset);
      // Navigate the PERSISTENT Browser Rendering session to the app under test
      // before any story plays — `newCDPSession({targetUrl})` does not navigate,
      // so without this the browser sits on about:blank and the agent has no app
      // to drive. The page survives this short-lived connect (the platform keeps
      // the session until `record stop`), so the play loop inherits the loaded
      // app. CF Access headers are already set in `attachCdp`.
      if (Option.isSome(url)) {
        yield* session.goto(url.value);
      }
      // The REAL Browser Run session id is REQUIRED (`--session-id`, from the
      // dispatcher's recording pre-acquire) — it is the key the Session
      // Recording REST API is fetched by. There is deliberately no CDP-side
      // fallback: the id Puppeteer/CDP can hand out is a different namespace
      // the recording API does not recognise, and persisting it would make
      // `record stop` fetch a recording that can never exist. Fail loudly
      // here instead; the run recovers by re-acquiring a fresh session.
      yield* writeFile(sessionIdOut, sessionId);
      // `record start` does NOT disconnect — the WebSocket would close
      // server-side and finalize the recording prematurely. The platform
      // closes the session when `record stop` calls `Browser.close`. The
      // attach in `record start` is short-lived: we connect, set viewport,
      // get the session id, write it, and disconnect cleanly without
      // requesting Browser.close.
      yield* session.close();
      yield* Console.log(`session-id written to ${sessionIdOut}`);
    }).pipe(Effect.catchAll(reportAndDie)),
);

// ---------------------------------------------------------------------------
// `record stop`

const recordStop = Command.make(
  "stop",
  {
    cdpWs: cdpWsOption,
    sessionIdIn: sessionIdInOption,
    out: outOption,
  },
  ({ cdpWs, sessionIdIn, out }) =>
    Effect.gen(function* () {
      const sessionId = yield* readFile(sessionIdIn).pipe(
        Effect.map((s) => s.trim()),
      );
      // CLOSE the Browser Run session first — recordings only finalize after
      // the session closes ("After a session closes, its recording is
      // available"), and the keep_alive idle timer (minutes) outlives the
      // fetch's retry budget. Re-attach and send a Browser.close, but DO NOT
      // wait for puppeteer's full teardown: `browser.close()` blocks until the
      // browser process exit propagates back — which through the CDP proxy it
      // never does, hanging record-stop ~10min (near the step cap). Send the
      // `Browser.close` CDP frame directly, then disconnect. The frame is what
      // triggers finalization; we don't need the teardown ack. Best-effort.
      yield* attachCdp(cdpWs).pipe(
        Effect.flatMap(({ browser, page }) =>
          Effect.tryPromise({
            try: async () => {
              const cdp = await page.createCDPSession();
              await cdp.send("Browser.close").catch(() => undefined);
              await browser.disconnect().catch(() => undefined);
            },
            catch: (e) => e,
          }),
        ),
        Effect.timeout("20 seconds"),
        Effect.catchAll(() => Effect.void),
      );
      // Give the platform a moment to finalize before the first fetch.
      yield* Effect.sleep("3 seconds");
      const cfg = yield* recordingConfigFromEnv(process.env);
      const events = yield* fetchRecording(sessionId, cfg);
      yield* writeFile(out, JSON.stringify(events));
      // Final-line JSON per the run's contract.
      yield* Console.log(
        JSON.stringify({ sessionId, eventCount: events.length }),
      );
    }).pipe(Effect.catchAll(reportAndDie)),
);

const recordCommand = Command.make("record", {}).pipe(
  Command.withSubcommands([recordStart, recordStop]),
);

// ---------------------------------------------------------------------------
// `play`

const playCommand = Command.make(
  "play",
  {
    cdpWs: cdpWsOption,
    name: nameOption,
    prose: proseOption,
    screenshots: screenshotsOption,
    framesDir: framesDirOption,
    maxSec: maxSecOption,
    model: modelOption,
    url: urlOption,
  },
  ({ cdpWs, name, prose, screenshots, framesDir, maxSec, model, url }) =>
    Effect.gen(function* () {
      // HARD process-level failsafe deadline. The play loop's between-action
      // deadline check can't fire while an action is in flight, and the
      // in-container `timeout -s KILL` has proven unreliable at stopping a
      // wedged play (it ran to the 600s step cap). So arm an OS timer that, if
      // ANYTHING wedges the play past its budget — a slow/hung `attachCdp`, a
      // model call choking on a huge DOM snapshot, a stuck CDP op — writes a
      // parseable failed verdict to stdout and exits, so the run gets a result
      // instead of a hung container. `unref()` so it never delays a clean exit;
      // cleared on the normal path below.
      const killer = setTimeout(() => {
        try {
          process.stdout.write(
            JSON.stringify({
              status: "failed",
              durationMs: (maxSec + 45) * 1000,
              chapterStartMs: 0,
              chapterEndMs: 0,
              narrative: `play hit the hard ${maxSec + 45}s process deadline — wedged before completing (likely a slow/hung attach, accessibility snapshot, or model call)`,
              keyScreenshotPath: "",
            }) + "\n",
          );
        } catch {
          /* stdout may be gone */
        }
        process.exit(0);
      }, (maxSec + 45) * 1000);
      if (typeof killer.unref === "function") killer.unref();

      const attachedAtMs = Date.now();
      const attached = yield* attachCdp(cdpWs, Option.getOrUndefined(url));
      const result = yield* runPlayLoop(
        {
          name,
          prose,
          screenshotsDir: screenshots,
          maxSec,
          attachedAtMs,
          startUrl: Option.getOrUndefined(url),
          framesDir: Option.getOrUndefined(framesDir),
        },
        { session: attached.session },
      ).pipe(Effect.provide(makeLanguageModelLayer(model)));
      yield* attached.session.close();
      yield* Effect.sync(() => clearTimeout(killer));
      yield* Console.log(JSON.stringify(result));
    }).pipe(Effect.catchAll(reportAndDie)),
);

// ---------------------------------------------------------------------------
// `gif` — stitch the frames captured during `play --frames-dir` into one
// animated GIF the run uploads + embeds in its PR comment. Pure-JS encode
// (see gif.ts); holds the output under a byte budget for GitHub's image proxy.

const framesOption = Options.text("frames").pipe(
  Options.withDescription("Directory of PNG frames (from `play --frames-dir`)."),
);
const maxWidthOption = Options.integer("max-width").pipe(
  Options.withDefault(800),
  Options.withDescription("Max GIF width in px — frames are downscaled, never upscaled."),
);
const maxFramesOption = Options.integer("max-frames").pipe(
  Options.withDefault(60),
  Options.withDescription("Cap on frames in the GIF — excess are dropped evenly."),
);
const maxBytesOption = Options.integer("max-bytes").pipe(
  Options.withDefault(10_000_000),
  Options.withDescription("Byte budget — GitHub's camo proxy won't render larger images."),
);
const delayMsOption = Options.integer("delay-ms").pipe(
  Options.withDefault(600),
  Options.withDescription("Per-frame delay in milliseconds."),
);
const matchOption = Options.text("match").pipe(
  Options.withDescription(
    "Optional: only stitch frames whose filename starts with this prefix (e.g. a story name like `Sign up-`) — how the run renders one per-chapter GIF from the shared frames dir. Omit to stitch every frame.",
  ),
  Options.optional,
);

const gifCommand = Command.make(
  "gif",
  {
    frames: framesOption,
    out: outOption,
    maxWidth: maxWidthOption,
    maxFrames: maxFramesOption,
    maxBytes: maxBytesOption,
    delayMs: delayMsOption,
    match: matchOption,
  },
  ({ frames, out, maxWidth, maxFrames, maxBytes, delayMs, match }) =>
    Effect.gen(function* () {
      const matchPrefix = Option.getOrUndefined(match);
      const result = yield* Effect.try({
        try: () =>
          renderGifFromDir({
            framesDir: frames,
            out,
            maxWidth,
            maxFrames,
            maxBytes,
            delayMs,
            ...(matchPrefix !== undefined ? { match: matchPrefix } : {}),
          }),
        catch: (e) =>
          new FsFailed({
            path: frames,
            op: "read",
            message: e instanceof Error ? e.message : String(e),
          }),
      });
      // Final-line JSON the run parses — `gifPath: ""` ⇒ no frames, no GIF.
      yield* Console.log(JSON.stringify(result));
    }).pipe(Effect.catchAll(reportAndDie)),
);

// ---------------------------------------------------------------------------
// `summarize`

const summarizeCommand = Command.make(
  "summarize",
  {
    storiesJson: storiesJsonOption,
    model: modelOption,
    out: outOption,
    previous: previousOption,
  },
  ({ storiesJson, model, out, previous }) =>
    Effect.gen(function* () {
      const raw = yield* readFile(storiesJson);
      const parsed: unknown = JSON.parse(raw);
      const decode = Schema.decodeUnknownEither(StoriesJson);
      const decoded = decode(parsed);
      if (decoded._tag === "Left") {
        yield* Console.error(
          `error: --stories-json malformed: ${decoded.left.message}`,
        );
        return yield* Effect.die("StoriesJson decode failed");
      }
      const previousMd =
        previous._tag === "Some"
          ? yield* readFile(previous.value).pipe(
              Effect.catchTag("FsFailed", () => Effect.succeed("")),
            )
          : "";
      const md = yield* summarizeStories({
        stories: decoded.right.stories,
        replayUri: decoded.right.replayUri,
        replayJsonUri: decoded.right.replayJsonUri,
        previous: previousMd,
      }).pipe(Effect.provide(makeLanguageModelLayer(model)));
      yield* writeFile(out, md);
      yield* Console.log(md);
    }).pipe(Effect.catchAll(reportAndDie)),
);

// ---------------------------------------------------------------------------
// `write-json` / `write-prior`

const writeJsonCommand = Command.make(
  "write-json",
  { out: outOption, data: dataOption },
  ({ out, data }) =>
    Effect.gen(function* () {
      // Validate JSON before writing — a malformed --data is a config bug
      // we'd rather fail loudly than persist.
      try {
        JSON.parse(data);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        yield* Console.error(`error: --data is not valid JSON: ${msg}`);
        return yield* Effect.die("invalid --data");
      }
      yield* writeFile(out, data);
    }).pipe(Effect.catchAll(reportAndDie)),
);

const writePriorCommand = Command.make(
  "write-prior",
  { out: outOption, data: dataOption },
  ({ out, data }) =>
    writeFile(out, data).pipe(Effect.catchAll(reportAndDie)),
);

// ---------------------------------------------------------------------------
// Top-level export consumed by main.ts. `@effect/cli`'s `withSubcommands`
// expects a non-empty readonly tuple, so we spell the tuple out rather than
// going through `Array<Command>`.

export const subcommands = [
  recordCommand,
  playCommand,
  gifCommand,
  summarizeCommand,
  writeJsonCommand,
  writePriorCommand,
] as const;

// ---------------------------------------------------------------------------
// Helpers.

const writeFile = (
  filePath: string,
  body: string,
): Effect.Effect<void, FsFailed> =>
  Effect.gen(function* () {
    yield* Effect.tryPromise({
      try: () => fs.mkdir(path.dirname(filePath), { recursive: true }).then(() => undefined),
      catch: (e) =>
        new FsFailed({
          path: path.dirname(filePath),
          op: "mkdir",
          message: e instanceof Error ? e.message : String(e),
        }),
    });
    yield* Effect.tryPromise({
      try: () => fs.writeFile(filePath, body, "utf8"),
      catch: (e) =>
        new FsFailed({
          path: filePath,
          op: "write",
          message: e instanceof Error ? e.message : String(e),
        }),
    });
  });

const readFile = (filePath: string): Effect.Effect<string, FsFailed> =>
  Effect.tryPromise({
    try: () => fs.readFile(filePath, "utf8"),
    catch: (e) =>
      new FsFailed({
        path: filePath,
        op: "read",
        message: e instanceof Error ? e.message : String(e),
      }),
  });

const reportAndDie = (e: AgentError): Effect.Effect<never, never, never> =>
  Match.value(e).pipe(
    Match.tag("CdpAttachFailed", (err) =>
      Effect.gen(function* () {
        yield* Console.error(
          `error: CDP attach failed (${err.reason}): ${err.message}`,
        );
        return yield* Effect.die(err);
      }),
    ),
    Match.tag("CdpCommandFailed", (err) =>
      Effect.gen(function* () {
        yield* Console.error(
          `error: CDP ${err.method} failed: ${err.message}`,
        );
        return yield* Effect.die(err);
      }),
    ),
    Match.tag("RecordingFetchFailed", (err) =>
      Effect.gen(function* () {
        yield* Console.error(
          `error: recording fetch failed (${err.reason}) for session ${err.sessionId}: ${err.message}`,
        );
        return yield* Effect.die(err);
      }),
    ),
    Match.tag("ModelCallFailed", (err) =>
      Effect.gen(function* () {
        yield* Console.error(
          `error: model ${err.model} failed (${err.reason}): ${err.message}`,
        );
        return yield* Effect.die(err);
      }),
    ),
    Match.tag("MissingEnv", (err) =>
      Effect.gen(function* () {
        yield* Console.error(`error: required env var not set: ${err.name}`);
        return yield* Effect.die(err);
      }),
    ),
    Match.tag("FsFailed", (err) =>
      Effect.gen(function* () {
        yield* Console.error(
          `error: fs ${err.op} ${err.path}: ${err.message}`,
        );
        return yield* Effect.die(err);
      }),
    ),
    Match.exhaustive,
  );
