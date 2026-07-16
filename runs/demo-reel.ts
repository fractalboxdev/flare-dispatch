// `demo-reel` — render a captured product demo into a presentation.
//
// Consumes a `demo-bundle/v1` (specs/10-demo-bundle.md) — the relocatable
// capture bundle a `product-demo` execution publishes (frames archive,
// per-chapter GIFs, screenshots, story prose) — and renders it through
// [autopresenter](https://github.com/fractalbox/autopresenter) into:
//
//   - a self-contained HTML **deck** (always — autopresenter's slides target
//     has zero native deps, so it renders on the lean sandbox image), and
//   - a narrated **MP4 reel** (tool-gated — autopresenter's video target
//     shells out to ffmpeg + rsvg-convert, which the lean image does not
//     carry; see recipes/demo-reel/Dockerfile.example for the layer that
//     enables it. Absent tools ⇒ the video is SKIPPED with a reason, never
//     failed — the deck is the baseline deliverable).
//
// The division of labour is deliberate (see specs/10-demo-bundle.md):
// FlareDispatch owns CAPTURE (browser + rrweb + frames), autopresenter owns
// PRESENTATION (SceneGraph composition, narration, deck/video projection).
// The coupling is the bundle contract + autopresenter's CLI — no shared
// libraries, no API auth: the bundle rides the public artifact route and
// autopresenter is fetched by `git clone` at a pinned ref (zero runtime deps,
// runs straight off `node src/cli.ts` on the image's Node 24).
//
// Dispatch: spawned as a CHILD run by `product-demo` when the operator opts
// in (`demo-reel.enabled` = "true" in CONFIG_KV), deduped per bundle URL; or
// Action-mode with an explicit `bundleUrl`.
//
// DSL: `sandbox.exec`, `artifact.upload`, `config.get`, `github.pullReview`.

import { Cause, Effect, Schema } from "effect";
import {
  artifact,
  config,
  defineRun,
  ExecFailed,
  github,
  io,
  sandbox,
  step,
} from "@fractalboxdev/flare-dispatch-core";
import { loadSecrets } from "@fractalboxdev/flare-dispatch-core/primitives";

const Input = Schema.Struct({
  // `repo` + `sha` anchor the check-run callback, same as every run.
  repo: Schema.String,
  sha: Schema.String,
  // URL of the demo-bundle/v1 `manifest.json`. A relative
  // `/v1/artifacts/<exec>/manifest.json` (what `product-demo` passes from its
  // own `bundleUri` output) resolves against the docs base; an absolute URL
  // is used as-is, so an operator can point the run at any hosted bundle.
  bundleUrl: Schema.String,
  // PR comment on completion (deck + reel links), same best-effort posture as
  // product-demo's comment. Absent ⇒ no comment.
  pr: Schema.optional(Schema.Number),
  installationId: Schema.optional(Schema.Number),
});

const Output = Schema.Struct({
  // Stable artifact URL to the self-contained HTML deck.
  deckUri: Schema.optional(Schema.String),
  // Stable artifact URL to the narrated MP4 — absent when the video was
  // skipped (no ffmpeg/rsvg in the image) or its render failed (best-effort).
  videoUri: Schema.optional(Schema.String),
  // Scene count autopresenter reported from the bundle lowering.
  scenes: Schema.Number,
  // Why there is no `videoUri`, when there isn't one.
  videoSkipped: Schema.optional(Schema.String),
});

const BUNDLE_DIR = "/tmp/reel/bundle";
const AP_DIR = "/tmp/reel/ap";
const COMP_DIR = "/tmp/reel/comp";

// Download the manifest + every sibling it references, then unpack the frames
// archive. Runs as ONE bounded exec: the bundle is small (PNGs/GIFs already
// compressed) and the artifact route is public — a curl loop beats N execs.
// `replayJson` entries are deliberately NOT downloaded: rrweb is the replay
// artifact, not footage (specs/10-demo-bundle.md § Design rules).
// NOTE: `\${…}` is escaped where it would read as TS interpolation — all
// `$` vars here expand in the CONTAINER shell, not in TS.
const FETCH_BUNDLE_SCRIPT = `set -eu
mkdir -p ${BUNDLE_DIR}
curl -fsSL "$BUNDLE_URL" -o ${BUNDLE_DIR}/manifest.json
base="\${BUNDLE_URL%/*}"
cd ${BUNDLE_DIR}
node -e '
  const fs = require("fs");
  const m = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
  if (m.kind !== "demo-bundle/v1") { console.error("not a demo-bundle/v1: " + m.kind); process.exit(2); }
  const names = [m.summary, m.gif, m.framesArchive]
    .concat(m.stories.flatMap((s) => [s.keyScreenshot, s.gif]))
    .filter(Boolean);
  fs.writeFileSync("names.txt", names.join("\\n") + "\\n");
'
while IFS= read -r n; do [ -n "$n" ] && curl -fsSL "$base/$n" -o "$n"; done < names.txt
if [ -f frames.tar ]; then mkdir -p frames && tar -xf frames.tar -C frames; fi
echo BUNDLE_OK`;

// Shallow-fetch autopresenter at the operator-pinned ref. `git fetch <ref>`
// accepts a branch OR a commit sha, so `demo-reel.autopresenter-ref` can pin
// either (pin a sha for reproducible reels; default `main` tracks upstream).
const CLONE_AP_SCRIPT = `set -eu
rm -rf ${AP_DIR} && mkdir -p ${AP_DIR} && cd ${AP_DIR}
git init -q .
git remote add origin https://github.com/fractalbox/autopresenter.git
git fetch -q --depth=1 origin "$AP_REF"
git checkout -q FETCH_HEAD
echo CLONE_OK`;

export const demoReel = defineRun({
  name: "demo-reel",
  version: "1.0.0",
  inputs: Input,
  outputs: Output,
  // No browser, no checkout of the consumer repo — the inputs are the bundle
  // (fetched over HTTP) and autopresenter (cloned). Deck render is seconds;
  // the ceiling budgets a slow TTS + ffmpeg encode on a long demo.
  limits: { maxDurationSec: 1800, maxConcurrency: 2 },

  run: (input) =>
    Effect.gen(function* () {
      // Resolve the docs base once — it absolutizes the relative `bundleUrl`
      // a parent product-demo passes, and the artifact links in the comment.
      const docsBase = yield* step("resolve-docs-base", () =>
        config.get("product-demo.docsBase").pipe(
          Effect.map(
            (override) => override ?? "https://flare-dispatch.fractalbox.com",
          ),
        ),
      );
      const absolute = (uri: string): string =>
        uri.startsWith("http") ? uri : `${docsBase}${uri}`;
      const bundleUrl = absolute(input.bundleUrl);

      const apRef = yield* step("resolve-autopresenter-ref", () =>
        config.get("demo-reel.autopresenter-ref").pipe(
          Effect.map((v) => (v !== undefined && v !== "" ? v : "main")),
        ),
      );

      // Optional TTS credentials for autopresenter's narration (Workers AI
      // Aura via REST). Reuses product-demo's secret namespace — same account
      // that owns the gateway/browser. Absent ⇒ autopresenter renders the
      // video without narration credentials and falls back per its own CLI
      // semantics; the deck is unaffected either way.
      const ttsEnv = yield* loadSecrets(
        ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"],
      );

      const container = yield* step("acquire", () => sandbox.acquire({}));

      // The container exec returns non-zero exits as RESULTS (only infra
      // faults raise) — every fatal stage asserts its sentinel/exit itself.
      // A sentinel (not just exit 0) proves the script ran to ITS end, not a
      // truncated variant of it.
      const execChecked = (opts: {
        readonly command: string;
        readonly env?: Record<string, string>;
        readonly timeoutSec: number;
        readonly sentinel?: string;
      }) =>
        sandbox
          .exec({
            container,
            command: opts.command,
            ...(opts.env !== undefined ? { env: opts.env } : {}),
            timeoutSec: opts.timeoutSec,
          })
          .pipe(
            Effect.filterOrFail(
              (r) =>
                r.exitCode === 0 &&
                (opts.sentinel === undefined ||
                  r.stdout.includes(opts.sentinel)),
              (r) =>
                new ExecFailed({
                  exitCode: r.exitCode,
                  stderrTail: (r.stderr || r.stdout).slice(-400),
                }),
            ),
          );

      // 1. Fetch the bundle. FATAL on failure — with no bundle there is
      //    nothing to render, and an honest red beats an empty green.
      yield* step(
        "fetch-bundle",
        () =>
          execChecked({
            command: FETCH_BUNDLE_SCRIPT,
            env: { BUNDLE_URL: bundleUrl },
            timeoutSec: 300,
            sentinel: "BUNDLE_OK",
          }),
        { timeoutSec: 360, retries: 1 },
      );

      // 2. Clone autopresenter at the pinned ref.
      yield* step(
        "clone-autopresenter",
        () =>
          execChecked({
            command: CLONE_AP_SCRIPT,
            env: { AP_REF: apRef },
            timeoutSec: 180,
            sentinel: "CLONE_OK",
          }),
        { timeoutSec: 240, retries: 1 },
      );

      // 3. Lower the bundle into a composition. autopresenter's `import demo`
      //    prints a final JSON line `{"scenes": n, "deck": "<path>"}` — the
      //    machine half of its CLI contract with this run.
      const importResult = yield* step(
        "import-demo",
        () =>
          execChecked({
            command: `node ${AP_DIR}/src/cli.ts import demo ${BUNDLE_DIR} -o ${COMP_DIR}`,
            timeoutSec: 120,
          }),
        { timeoutSec: 180, retries: 0 },
      );
      const lastLine = importResult.stdout.trim().split("\n").pop() ?? "";
      let scenes = 0;
      try {
        scenes = Number((JSON.parse(lastLine) as { scenes?: number }).scenes ?? 0);
      } catch {
        // Older/foreign autopresenter that doesn't print the JSON line: the
        // deck may still have been written — carry on with scenes unknown.
        yield* io.log(
          "warn",
          `demo-reel: import demo printed no parseable JSON tail — ${lastLine.slice(0, 120)}`,
        );
      }

      // 4. Deck (always): slides target is pure Node — renders on lean.
      //    FATAL on failure: the deck is the baseline deliverable.
      yield* step(
        "render-deck",
        () =>
          execChecked({
            command: `node ${AP_DIR}/src/cli.ts render ${COMP_DIR}/deck.md --target slides -o /tmp/reel/deck`,
            timeoutSec: 120,
          }),
        { timeoutSec: 180, retries: 0 },
      );
      const deckUri = yield* step("upload-deck", () =>
        artifact
          .upload({
            name: "demo-deck.html",
            path: "/tmp/reel/deck/index.html",
            container,
            contentType: "text/html",
            signedUrlTTL: "30 days",
          })
          .pipe(
            Effect.timeout("90 seconds"),
            Effect.catchAllCause((cause) =>
              io
                .log(
                  "warn",
                  `demo-reel: deck upload failed — ${Cause.pretty(cause).slice(0, 400)}`,
                )
                .pipe(Effect.as("")),
            ),
          ),
      );

      // 5. Reel (tool-gated, best-effort): only when the image carries the
      //    native encoders autopresenter's video projector shells out to.
      const toolsStdout = yield* step("probe-video-tools", () =>
        sandbox
          .exec({
            container,
            command:
              "if command -v ffmpeg >/dev/null 2>&1 && command -v rsvg-convert >/dev/null 2>&1; then echo TOOLS_OK; else echo TOOLS_MISSING; fi",
            timeoutSec: 30,
          })
          .pipe(
            Effect.map((r) => r.stdout),
            Effect.catchAll(() => Effect.succeed("TOOLS_MISSING")),
          ),
      );

      let videoUri = "";
      let videoSkipped = "";
      if (!toolsStdout.includes("TOOLS_OK")) {
        videoSkipped =
          "ffmpeg/rsvg-convert not in the sandbox image — deck only. Bake them (recipes/demo-reel/Dockerfile.example) to enable the MP4 reel.";
        yield* io.log("info", `demo-reel: ${videoSkipped}`);
      } else {
        const videoExit = yield* step(
          "render-video",
          () =>
            sandbox
              .exec({
                container,
                command: `node ${AP_DIR}/src/cli.ts render ${COMP_DIR}/deck.md --target video -o /tmp/reel/demo-reel.mp4`,
                env: ttsEnv,
                timeoutSec: 900,
              })
              .pipe(Effect.map((r) => r.exitCode)),
          { timeoutSec: 960, retries: 0 },
        ).pipe(
          // Best-effort: a narration/encode failure downgrades to deck-only,
          // it never fails the run (the deck already shipped).
          Effect.catchAllCause((cause) =>
            io
              .log(
                "warn",
                `demo-reel: video render failed (best-effort) — ${Cause.pretty(cause).slice(0, 400)}`,
              )
              .pipe(Effect.as(-1)),
          ),
        );
        if (videoExit === 0) {
          videoUri = yield* step("upload-video", () =>
            artifact
              .upload({
                name: "demo-reel.mp4",
                path: "/tmp/reel/demo-reel.mp4",
                container,
                contentType: "video/mp4",
                signedUrlTTL: "30 days",
              })
              .pipe(
                Effect.timeout("3 minutes"),
                Effect.catchAllCause((cause) =>
                  io
                    .log(
                      "warn",
                      `demo-reel: video upload failed — ${Cause.pretty(cause).slice(0, 400)}`,
                    )
                    .pipe(Effect.as("")),
                ),
              ),
          );
        }
        if (videoUri === "") {
          videoSkipped = videoSkipped !== "" ? videoSkipped : "video render/upload failed — see run logs";
        }
      }

      yield* io.log(
        "info",
        `demo-reel: ${scenes} scene(s) — deck ${deckUri !== "" ? "ok" : "missing"}, video ${videoUri !== "" ? "ok" : "skipped"}`,
      );

      // 6. PR comment (best-effort, same posture as product-demo's).
      if (input.pr !== undefined && deckUri !== "") {
        const body = [
          `## 🎬 Demo reel`,
          "",
          `Rendered from this PR's product-demo capture (${scenes} scene${scenes === 1 ? "" : "s"}).`,
          "",
          `- 🖥 [Open the deck](${absolute(deckUri)})`,
          ...(videoUri !== ""
            ? [`- 🎥 [Watch the narrated reel](${absolute(videoUri)})`]
            : [`- 🎥 Reel: ${videoSkipped}`]),
        ].join("\n");
        yield* step("post-pr-comment", () =>
          github
            .pullReview({
              repo: input.repo,
              pr: input.pr!,
              sha: input.sha,
              body,
              ...(input.installationId !== undefined
                ? { installationId: input.installationId }
                : {}),
            })
            .pipe(
              Effect.timeout("60 seconds"),
              Effect.catchAllCause((cause) =>
                io.log(
                  "warn",
                  `demo-reel: PR comment failed (best-effort) — ${Cause.pretty(cause).slice(0, 400)}`,
                ),
              ),
            ),
        );
      }

      return {
        ...(deckUri !== "" ? { deckUri } : {}),
        ...(videoUri !== "" ? { videoUri } : {}),
        scenes,
        ...(videoSkipped !== "" ? { videoSkipped } : {}),
      };
    }),
});
