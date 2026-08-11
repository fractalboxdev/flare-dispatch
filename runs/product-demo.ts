// `product-demo` — AI-driven product demo run.
//
// A team hands it a deployed URL (preview / staging / prod) and a list of
// user stories as prose; the run drives the site through each story in
// sequence over a single CDP session with Browser Run's native rrweb
// session recording enabled, captures key screenshots, writes a per-story
// narrative, and then produces a holistic markdown summary across all
// stories that a reviewer can paste into the PR.
//
// Stories arrive in one of two shapes (provide exactly one):
//   - `stories`        — the structured `{ name, prose }[]` array.
//   - `storiesMarkdown` — a markdown doc where each `## ` heading is one
//     story (heading = name, body = prose). See `parseStoriesMarkdown`.
//     Lets an operator keep the demo script as a readable `.md` and edit it
//     like documentation rather than hand-maintaining JSON.
//
// No checkout — the target is a deployed URL, not the repo. The run only
// attaches to Browser Run over CDP and shells out to the bundled
// `demo-agent` CLI, baked into `infra/Dockerfile.sandbox-demo` (the image
// the RunSandbox class builds from; the lean classes build from
// `infra/Dockerfile.sandbox`). The agent owns
// the model loop and CDP action application; the platform owns recording
// (Browser Run records rrweb DOM events at the session level when the CDP
// connect URL carries `?recording=true`); this run only orchestrates:
// attach → record start (set viewport, capture sessionId) → for each
// story play → record stop (close session, pull rrweb events from the
// Browser Run REST API, upload as R2 JSON) → summarize.
//
// Modes:
// - **Action** — dispatched by recipes/product-demo/ci.yml on `pull_request`
//   and on manual `workflow_dispatch`. See specs/04-gha-integration.md
//   § Action mode.
// - **Schedule** — fires daily via the `schedules[]` block below; the
//   Dispatcher's `scheduled()` handler routes the cron tick to this run.
//   Operators pre-bake the default story list + deployed URL in
//   `schedules[].inputs`. See specs/04-gha-integration.md § Schedule mode.
//
// DSL: uses `browser.newCDPSession`, `sandbox.exec`, `artifact.upload`,
//      `config.get`, and `io.priorExecution` — specs/03-dsl.md § Capabilities.

import { Cause, Effect, Schedule, Schema, Option } from "effect";
import {
  defineRun,
  step,
  sandbox,
  browser,
  artifact,
  config,
  github,
  io,
  ContainerLaunchFailed,
  ExecFailed,
  ExecTimeout,
  AcceptanceFailed,
  DemoFailureKind,
  SignalArray,
  storyResultsToSignals,
  storyResultsToIncident,
  spawnChildRun,
  type DemoChapterResult,
  type DemoFailureKindT,
  type Container,
} from "@fractalboxdev/flare-dispatch-core";
import { awsAssumeRole, loadSecrets } from "@fractalboxdev/flare-dispatch-core/primitives";

// Shell single-quote a value so arbitrary story prose (quotes, URLs, `!`, `$`)
// survives being embedded in the detached `sh -c` command below.
const shellQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;

/**
 * Poll a `DONE:<exit>` sentinel file written by a detached process, with the
 * same transient-`ExecFailed` tolerance as runs/cdp-acceptance.ts: a poll
 * `cat` whose container connection is killed says nothing about the detached
 * process (which keeps running), so swallow it and keep polling; only a run of
 * killed polls (a genuinely dead container) re-surfaces the failure. Threads
 * the EXPLICIT acquired `container` handle (see run body) — the same fix that
 * makes runs/cdp-acceptance.ts reliable: the ambient sandbox SERIALISES execs,
 * so a poll `cat` queues behind the still-running detached play and never reads
 * the sentinel; an explicit container handle runs the poll as its own short
 * connection while the detached play keeps running in the background.
 */
const pollSentinel = ({
  container,
  sentinel,
  maxAttempts,
  pollEverySec = 5,
  maxConsecutiveExecFailures = 12,
}: {
  readonly container: Container;
  readonly sentinel: string;
  readonly maxAttempts: number;
  readonly pollEverySec?: number;
  readonly maxConsecutiveExecFailures?: number;
}) =>
  Effect.gen(function* () {
    let consecutive = 0;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const polled = yield* sandbox
        .exec({ container, command: `cat ${sentinel} 2>/dev/null || true` })
        .pipe(
          // Bound the poll exec ITSELF: a container exec connection can HANG
          // (not fail) — `catchTag` recovers failures, never hangs, so an
          // unbounded poll would block the whole step to the Workflows step
          // cap. A hung poll says nothing about the detached process, so it
          // funnels into the same transient path as a killed one.
          Effect.timeoutFail({
            duration: "30 seconds",
            onTimeout: () =>
              new ExecFailed({
                exitCode: -1,
                stderrTail: "poll exec hung >30s (transient, treated like a killed poll)",
              }),
          }),
          Effect.map((r) => Option.some(r.stdout)),
          Effect.catchTag("ExecFailed", () =>
            Effect.logWarning(
              `play-wait: poll exec killed (transient, ${consecutive + 1}/${maxConsecutiveExecFailures}), continuing`,
            ).pipe(Effect.as(Option.none<string>())),
          ),
        );
      if (Option.isNone(polled)) {
        consecutive += 1;
        if (consecutive >= maxConsecutiveExecFailures) {
          return yield* Effect.fail(
            new ExecFailed({
              exitCode: -1,
              stderrTail: `play-wait: ${maxConsecutiveExecFailures} consecutive poll execs killed — container appears dead`,
            }),
          );
        }
        yield* Effect.sleep(`${pollEverySec} seconds`);
        continue;
      }
      consecutive = 0;
      const match = /DONE:(-?\d+)/.exec(polled.value);
      if (match) return Number(match[1]);
      yield* Effect.sleep(`${pollEverySec} seconds`);
    }
    return yield* Effect.fail(
      new ExecTimeout({
        timeoutSec: 0,
        command: `play-wait: sentinel ${sentinel} never appeared after ${maxAttempts} polls`,
      }),
    );
  });

// A user story is just a name + prose. The agent reads the prose, decides
// the next browser action, applies it over the live CDP session, captures
// screenshots, and emits a narrative. Names must be unique within the
// `stories` array — they become chapter markers on the rrweb replay timeline.
const Story = Schema.Struct({
  name: Schema.String,
  prose: Schema.String,
});

/**
 * Parse a markdown stories document into the run's `{ name, prose }` list.
 *
 * Authoring contract — **each level-2 ATX heading (`## `) is one story**:
 *   - the heading text (trimmed, any trailing `#` stripped) becomes the
 *     story `name`;
 *   - every line from that heading down to the next `## ` (or EOF) becomes
 *     the `prose`, trimmed. Deeper headings (`###`+) are kept verbatim as
 *     part of the enclosing story's prose.
 * Content before the first `## ` — a `# Title`, a preamble paragraph — is
 * ignored, so an author can open the doc with context the agent never sees.
 *
 * This is the markdown counterpart to the structured `stories` array: it lets
 * an operator keep the demo script as a readable `.md` (one heading per
 * journey step) instead of hand-maintaining JSON. The dispatch passes the raw
 * file as `storiesMarkdown`; the run parses it here so the `demo-agent`
 * contract (`{ name, prose }`) is unchanged.
 *
 * Pure + deterministic (no Date / random / I/O) so it is safe in a run body
 * and unit-testable without a runtime.
 */
export const parseStoriesMarkdown = (
  markdown: string,
): ReadonlyArray<{ name: string; prose: string }> => {
  // Level-2 ATX only: `##` + whitespace + text. `##\s+` cannot match `###…`
  // (the char after `##` would be `#`, not whitespace), so deeper headings
  // fall through into the current story's prose. Up to 3 leading spaces are
  // tolerated per the CommonMark ATX rule.
  const headingRe = /^ {0,3}##\s+(.+?)\s*#*\s*$/;
  const stories: Array<{ name: string; prose: string[] }> = [];
  let current: { name: string; prose: string[] } | null = null;
  for (const line of markdown.split(/\r?\n/)) {
    const match = headingRe.exec(line);
    if (match) {
      // Group 1 always present when `match` is truthy — the pattern requires it.
      current = { name: match[1]!.trim(), prose: [] };
      stories.push(current);
      continue;
    }
    if (current) current.prose.push(line);
  }
  return stories.map((s) => ({
    name: s.name,
    prose: s.prose.join("\n").trim(),
  }));
};

/**
 * `demo-bundle/v1` — the machine-readable index of a product-demo execution's
 * artifacts (specs/10-demo-bundle.md). Every reference is a RELATIVE artifact
 * name, resolvable against R2 (`artifacts/<exec>/<name>`), the public
 * `/v1/artifacts/<exec>/<name>` route, or a plain local directory holding the
 * same files — so the bundle is relocatable and a downstream presentation
 * consumer (autopresenter's `import demo`, the `demo-reel` child run) needs no
 * dispatcher coupling beyond fetching sibling files next to the manifest.
 */
export type DemoBundleManifest = {
  readonly kind: "demo-bundle/v1";
  readonly repo: string;
  readonly sha: string;
  /** The deployed URL the demo drove. */
  readonly target: string;
  /** Always `summary.md` — the human-readable per-chapter table. */
  readonly summary: string;
  /** `demo.gif` when the combined walkthrough GIF was encoded + uploaded. */
  readonly gif?: string;
  /**
   * `frames.tar` when the raw per-action PNG frames were archived. The frames
   * inside are named `<story>-NNNN.png` (see each story's `framesPrefix`) —
   * full-resolution footage, unlike the ≤800px camo-budgeted GIFs.
   */
  readonly framesArchive?: string;
  readonly stories: ReadonlyArray<{
    readonly name: string;
    /** The operator-authored story prose — the narration source. */
    readonly prose: string;
    readonly status: "passed" | "failed";
    readonly failureKind?: DemoFailureKindT;
    /** UNTRUSTED (LLM-written over a live page) — display, don't execute. */
    readonly narrative: string;
    readonly durationMs: number;
    readonly chapterStartMs: number;
    readonly chapterEndMs: number;
    /** Frame-file prefix (`<name>-`) selecting this chapter inside `framesArchive`. */
    readonly framesPrefix: string;
    /** `<name>.png` when the key screenshot uploaded. */
    readonly keyScreenshot?: string;
    /** `chapter-<i>.gif` when this chapter's own GIF uploaded. */
    readonly gif?: string;
    /** `replay-<i>.json` (rrweb events) when the recording uploaded. */
    readonly replayJson?: string;
  }>;
};

/** The per-chapter fields the manifest builder reads — structurally satisfied
 * by the run's `StoryOutcome` (+ folded `chapterGifUri`), kept narrow so the
 * builder stays pure and unit-testable without the run body. */
export type DemoBundleChapter = {
  readonly name: string;
  readonly status: "passed" | "failed";
  readonly failureKind?: DemoFailureKindT;
  readonly durationMs: number;
  readonly chapterStartMs: number;
  readonly chapterEndMs: number;
  readonly narrative: string;
  readonly keyScreenshotUri: string;
  readonly chapterGifUri?: string;
  readonly replayJsonUri: string;
};

/**
 * Build the `demo-bundle/v1` manifest from the played chapters. Pure +
 * deterministic (no Date / random / I/O). Optional entries appear only when
 * the corresponding upload actually landed (signalled by a non-empty URI on
 * the chapter / the `hasGif` / `hasFramesArchive` flags), so a consumer can
 * trust that every name in the manifest resolves.
 */
export const buildDemoBundleManifest = (opts: {
  readonly repo: string;
  readonly sha: string;
  readonly target: string;
  readonly chapters: ReadonlyArray<DemoBundleChapter>;
  readonly proseByName: ReadonlyMap<string, string>;
  readonly hasGif: boolean;
  readonly hasFramesArchive: boolean;
}): DemoBundleManifest => ({
  kind: "demo-bundle/v1",
  repo: opts.repo,
  sha: opts.sha,
  target: opts.target,
  summary: "summary.md",
  ...(opts.hasGif ? { gif: "demo.gif" } : {}),
  ...(opts.hasFramesArchive ? { framesArchive: "frames.tar" } : {}),
  stories: opts.chapters.map((c, i) => ({
    name: c.name,
    prose: opts.proseByName.get(c.name) ?? "",
    status: c.status,
    ...(c.failureKind !== undefined ? { failureKind: c.failureKind } : {}),
    narrative: c.narrative,
    durationMs: c.durationMs,
    chapterStartMs: c.chapterStartMs,
    chapterEndMs: c.chapterEndMs,
    framesPrefix: `${c.name}-`,
    ...(c.keyScreenshotUri !== "" ? { keyScreenshot: `${c.name}.png` } : {}),
    ...(c.chapterGifUri !== undefined && c.chapterGifUri !== "" ? { gif: `chapter-${i}.gif` } : {}),
    ...(c.replayJsonUri !== "" ? { replayJson: `replay-${i}.json` } : {}),
  })),
});

const Input = Schema.Struct({
  // The deployed URL the demo runs against. No checkout — this is the
  // target site, not the repo. `repo` and `sha` are still required because
  // the check-run callback anchors to them (specs/04-gha-integration.md
  // § Check-runs callback).
  repo: Schema.String,
  sha: Schema.String,
  deployedUrl: Schema.String,
  // Two ways to supply the story script — provide exactly one:
  //   - `stories`: the structured `{ name, prose }[]` list (the original
  //     contract; what `schedules[].inputs` and the recipe `ci.yml` pass).
  //   - `storiesMarkdown`: a markdown doc where each `## ` heading is one
  //     story (see `parseStoriesMarkdown`). Lets an operator keep the demo
  //     script as a readable `.md` instead of hand-rolled JSON.
  // If both are present, `stories` wins. The run resolves the effective list
  // and dies loudly on a payload with neither (see § "resolve stories").
  stories: Schema.optional(Schema.Array(Story)),
  storiesMarkdown: Schema.optional(Schema.String),
  // The viewport preset is passed through to the agent — it sets the CDP
  // viewport once at attach time via Emulation.setDeviceMetricsOverride so
  // every rrweb event in the session uses one resolution. Default desktop;
  // "mobile" emulates a phone profile in the agent.
  viewportPreset: Schema.optional(Schema.Literal("desktop", "mobile")),
  // Per-story wall-clock ceiling. Stories run sequentially against ONE
  // rrweb-recorded session so the replay timeline is continuous; without
  // a per-story cap one stuck story would burn the whole run's
  // `maxDurationSec`.
  maxDurationSecPerStory: Schema.optional(Schema.Number),
  // AWS Bedrock BYOC trust path — when present, the run mints short-lived
  // STS creds via `awsAssumeRole` (OIDC trust → Bedrock invoke role) and
  // threads them into demo-agent through `agentEnv`. Required for any
  // `product-demo.model.*` value with the `bedrock/` prefix; ignored
  // otherwise (the agent's compat path doesn't read AWS_*).
  // Setup: same trust policy / IAM role that `pr-review`'s `bedrock`
  // backend uses, with `sub` widened to also accept `product-demo:*`. See
  // recipes/ai-code-review/README.md § Bedrock backend — the BYOC trust path.
  bedrockRoleArn: Schema.optional(Schema.String),
  bedrockRegion: Schema.optional(Schema.String),
  // PR comment on completion (GIF + summary). When `pr` is present, the run
  // posts ONE top-level PR review comment on completion — success OR failure —
  // carrying the holistic summary, the per-chapter table, and the walkthrough
  // as an animated GIF embedded inline (GitHub comments can't embed video but
  // render GIFs). Best-effort: absent `pr` (e.g. a Schedule-mode firing) ⇒ no
  // comment, the check-run stays the report. `installationId` authenticates
  // the write — Action mode usually omits it and the live `github` Layer
  // resolves the installation per-repo; Webhook-threaded dispatches pass it.
  pr: Schema.optional(Schema.Number),
  installationId: Schema.optional(Schema.Number),
});

// Each story round-trips its own per-chapter record so the summary can
// point a reviewer at the exact span of the rrweb replay to look at.
const StoryResult = Schema.Struct({
  name: Schema.String,
  status: Schema.Literal("passed", "failed"),
  // Why a failed chapter failed — the keystone discriminator. Only "assertion"
  // (the agent played the journey and the app misbehaved) is a code-fix signal;
  // "infra"/"timeout"/"unparseable" are flake/environment. Absent on a pass.
  // `storyResultsToSignals` gates emission on this so flake never reaches the
  // triage PR (or a future self-heal). See packages/core/src/demo-signals.ts.
  failureKind: Schema.optional(DemoFailureKind),
  durationMs: Schema.Number,
  // rrweb timestamps in ms from session start — a reviewer can jump straight
  // to a story's chapter in the replay player by seeking to chapterStartMs.
  chapterStartMs: Schema.Number,
  chapterEndMs: Schema.Number,
  narrative: Schema.String,
  keyScreenshotUri: Schema.String,
  // Stable artifact URL (`/v1/artifacts/<exec>/chapter-<i>.gif`) to THIS
  // chapter's own animated GIF — the per-action frames for just this story,
  // stitched on its own. Powers the per-chapter gallery the `/demos/:execution`
  // page renders. Absent when the chapter captured no frames or the encode was
  // skipped.
  chapterGifUri: Schema.optional(Schema.String),
  // Each story now records on its OWN CDP session (the run plays stories in
  // parallel), so the replay links are per-story, not one shared timeline.
  replayUri: Schema.String,
  replayJsonUri: Schema.String,
});

const Output = Schema.Struct({
  // The docs-site rrweb player URL (https://<docsBase>/replay/<sessionId>).
  // Reviewers click through to scrub the recording. The replay UI itself
  // ships separately — see specs/pm/plan.md § Replay UI; until then this
  // links to a "coming soon" page that displays the raw replayJsonUri.
  replayUri: Schema.String,
  // Signed R2 URL to the raw rrweb event JSON (30-day TTL). Power-user
  // escape hatch — drop into an rrweb-player iframe to self-host the
  // replay. The dispatcher mirrors Browser Run's 30-day retention.
  replayJsonUri: Schema.String,
  summaryMd: Schema.String, // the holistic LLM-written summary
  stories: Schema.Array(StoryResult),
  // `signals/v1` derived from the assertion-failed chapters — the first-party
  // adapter output a consumer folds into `ci-triage-pr` (and, later, a heal).
  // Empty on a fully-green run or when every failure was flake/infra. Also
  // persisted as the `signals.json` artifact so the FAILED path (whose Output
  // the dispatcher discards) keeps it. See packages/core/src/demo-signals.ts.
  signals: Schema.optionalWith(SignalArray, { default: () => [] }),
  // Stable artifact URL (`/v1/artifacts/<exec>/demo.gif`) to the walkthrough
  // GIF the run stitched from the per-action frames + embedded in the PR
  // comment. Absent when no frames were captured or the encode was skipped.
  gifUri: Schema.optional(Schema.String),
  // Stable artifact URL (`/v1/artifacts/<exec>/manifest.json`) to the
  // `demo-bundle/v1` manifest — the machine-readable index of this execution's
  // demo artifacts (frames archive, per-chapter GIFs, screenshots, replay
  // JSONs). A presentation consumer (the `demo-reel` child run / autopresenter
  // `import demo`) resolves sibling artifacts relative to this URL. Absent
  // when the manifest upload failed. See specs/10-demo-bundle.md.
  bundleUri: Schema.optional(Schema.String),
});

export const productDemo = defineRun({
  name: "product-demo",
  version: "1.0.0",
  // The operator's sandbox image (the one bound to `RUNS_SANDBOX` via
  // `wrangler.jsonc`) MUST include the `demo-agent` binary on PATH — model
  // loop, CDP-driver glue, and the Browser Run recording REST client.
  // No `image:` field here: FlareDispatch has one container binding per
  // Worker; the image is pinned by `infra/Dockerfile.sandbox-demo` (the
  // full variant with the `demo-agent` layer — the class this run acquires,
  // RunSandbox, is the DEFAULT image class and builds from it; see
  // `wrangler.jsonc` `containers`). Point the acquired class at that file to
  // enable this run.
  inputs: Input,
  outputs: Output,
  // Stories run IN PARALLEL, each on its own Browser Run CDP session (own
  // rrweb recording) — see the run body's per-story `playStory`. `requiresBrowser`
  // reserves a Browser Run slot, and the dispatcher's `newCDPSession` primitive
  // appends `?recording=true` so each session captures its own rrweb stream.
  // `maxConcurrency: 1` is the RUN-level limit (one product-demo execution at a
  // time); per-story concurrency is capped inside the run.
  limits: { maxDurationSec: 3600, maxConcurrency: 1, requiresBrowser: true },

  // Schedule-mode binding — 14:00 UTC daily. The cron expression MUST also
  // appear in wrangler.jsonc `triggers.crons`. See specs/04-gha-integration.md
  // § Schedule mode. The dedup key is per-UTC-day so a duplicate Cron Trigger
  // delivery (or a same-day operator-triggered Worker recycle) collapses to
  // the original instance via CF Workflows' `create({ id })` no-op semantics.
  // OPERATOR: edit the inputs below to point at your tracking repo + your
  // deployed URL + your story list. Action-mode dispatches (via ci.yml) take
  // their inputs from the workflow_dispatch payload and ignore these defaults.
  schedules: [
    {
      cron: "0 14 * * *",
      idempotencyKey: ({ firedAt }) =>
        `product-demo-${new Date(firedAt).toISOString().slice(0, 10)}`,
      inputs: () => ({
        repo: "OWNER/REPO",
        sha: "main",
        deployedUrl: "https://staging.example.com",
        stories: [
          {
            name: "landing",
            prose:
              "Visit the homepage and verify the primary call-to-action is visible above the fold.",
          },
        ],
        viewportPreset: "desktop" as const,
      }),
    },
  ],

  run: (input) =>
    Effect.gen(function* () {
      const viewport = input.viewportPreset ?? "desktop";
      // Clamped: every step below is budgeted (detached kill → poll bound →
      // bounded reads → explicit step `timeoutSec`) so its worst case stays
      // under control; an unclamped operator value would silently push the
      // play step past its budget arithmetic.
      // Ceiling raised 300 → 720s: with the per-story action budget at 80 (see
      // demo-agent MAX_ACTIONS_DEFAULT), a rich chapter spending ~4s/action can
      // run ~320s, so a 300s clamp would make TIME the new ceiling and re-fail
      // the heaviest chapters. 720s leaves headroom; the step arithmetic below
      // (killAfterSec / pollBudgetSec / timeoutSec) all derive from this, so it
      // stays internally consistent.
      const perStorySec = Math.min(input.maxDurationSecPerStory ?? 240, 720);

      // -1. Resolve the effective story list BEFORE any browser/sandbox work,
      //     so a misconfigured payload dies cheaply (no CDP session leaked, no
      //     image pull). `stories` wins over `storiesMarkdown`; the markdown is
      //     parsed into the same `{ name, prose }` shape the rest of the run
      //     (and `demo-agent`) consumes, so nothing downstream is markdown-aware.
      const resolvedStories =
        input.stories !== undefined && input.stories.length > 0
          ? input.stories
          : input.storiesMarkdown !== undefined
            ? parseStoriesMarkdown(input.storiesMarkdown)
            : [];
      if (resolvedStories.length === 0) {
        // A demo with no stories is never what the operator meant — a typo in
        // the markdown headings or a forgotten `stories` array. Die loudly.
        return yield* Effect.die(
          "product-demo: no stories to play — supply a non-empty `stories` array, " +
            "or a `storiesMarkdown` doc with at least one `## ` heading.",
        );
      }
      const duplicateNames = [
        ...new Set(resolvedStories.map((s) => s.name).filter((n, i, a) => a.indexOf(n) !== i)),
      ];
      if (duplicateNames.length > 0) {
        // Names become rrweb chapter markers — duplicates would collide on the
        // replay timeline and in the per-story result map.
        return yield* Effect.die(
          `product-demo: duplicate story names ${JSON.stringify(duplicateNames)} — ` +
            "each story name becomes a unique rrweb chapter marker.",
        );
      }

      // 0. Resolve the demo-agent's runtime credentials from CONFIG_KV. The
      //    container holds NO ambient credentials — every `sandbox.exec` is
      //    explicit about which env vars cross the boundary. The agent's
      //    model transport is provider-agnostic (built on `@effect/ai`'s
      //    `LanguageModel` Tag over the OpenAI wire protocol) and always routes
      //    through a Cloudflare AI Gateway; the operator picks the upstream by
      //    what they configure on the gateway.
      //      * `CF_AI_GATEWAY_ID`       — the gateway slug. The agent derives
      //        the endpoint as
      //        `https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/compat`
      //        from this + `CLOUDFLARE_ACCOUNT_ID` (no `MODEL_BASE_URL`).
      //      * `CLOUDFLARE_ACCOUNT_ID`  — account that owns the gateway AND the
      //        Browser Rendering session; both the model URL and the recorder
      //        REST URL key off this.
      //      * `CLOUDFLARE_API_TOKEN`   — same token shape as
      //        `BROWSER_CDP_API_TOKEN` on the Worker. Authorises the
      //        recording REST fetch.
      //      * `MODEL_API_KEY` (optional) — UPSTREAM provider key, sent as
      //        `Authorization: Bearer`. Set only to go around BYOK; empty /
      //        unset is fine for the BYOK-via-gateway path.
      //      * `CF_AI_GATEWAY_TOKEN` (optional) — the gateway's OWN auth
      //        ("Authenticated Gateway"), sent as `cf-aig-authorization`.
      //        Orthogonal to `MODEL_API_KEY`; set only when the gateway is
      //        locked down.
      //    Values are Worker secrets/vars by bare name (`wrangler secret put`).
      const requiredAgentEnv = yield* loadSecrets(
        ["CF_AI_GATEWAY_ID", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"],
        { required: true },
      );
      const optionalAgentEnv = yield* loadSecrets(["MODEL_API_KEY", "CF_AI_GATEWAY_TOKEN"]);
      // Optional CF Access service token — when the `deployedUrl` sits behind
      // Cloudflare Access (the numu staging Pages site 302s to the Access login
      // otherwise), demo-agent sets these as extra HTTP headers so the browser
      // gets past the wall. Same bare Worker secret names as
      // cdp-acceptance/playwright-demo. Absent ⇒ a public target.
      const cfAccessEnv = yield* loadSecrets(["CF_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_SECRET"]);

      // Optional BYOC Bedrock trust path — when the caller hands in
      // `bedrockRoleArn`, mint short-lived STS creds and pass them to
      // demo-agent via env. The agent picks up the `bedrock/` model id
      // (from CONFIG_KV) and uses these to SigV4-sign Bedrock InvokeModel
      // calls through the AI Gateway forwarder. See packages/demo-agent/
      // src/bedrock-invoke.ts for the consumer side.
      const bedrockEnv: Record<string, string> = {};
      if (input.bedrockRoleArn !== undefined) {
        const region = input.bedrockRegion ?? "us-east-1";
        const creds = yield* step("assume-bedrock-role", () =>
          awsAssumeRole({
            roleArn: input.bedrockRoleArn!,
            region,
            // Audience is the same `sts.amazonaws.com` that #111's
            // pr-review bedrock backend uses; the trust policy keys off `sub`
            // (run name + execution id) — adjust the trust policy to
            // also accept `product-demo:*`.
          }),
        );
        bedrockEnv.AWS_ACCESS_KEY_ID = creds.accessKeyId;
        bedrockEnv.AWS_SECRET_ACCESS_KEY = creds.secretAccessKey;
        bedrockEnv.AWS_SESSION_TOKEN = creds.sessionToken;
        bedrockEnv.AWS_REGION = region;
      }
      const agentEnv = {
        ...requiredAgentEnv,
        ...optionalAgentEnv,
        ...cfAccessEnv,
        ...bedrockEnv,
      };

      // 0. Acquire ONE explicit container and thread its handle through every
      //    `sandbox.exec` / `runDetached` / poll below. This is the structural
      //    fix that makes the run reliable (mirrors runs/cdp-acceptance.ts,
      //    which threads the `workspace()` container): the AMBIENT sandbox
      //    serialises execs against the execution-scoped box, so a detached
      //    multi-minute play blocks every subsequent `cat` poll behind it (the
      //    sentinel is never read → the step spins to CF Workflows' ~10-min
      //    cap), while a blocking play holds one connection long enough to be
      //    killed (ExecFailed). An explicit, persistent container handle lets
      //    the play run detached in the background while short poll execs read
      //    its sentinel on their own connections. No repo checkout — unlike
      //    cdp-acceptance we run the baked `demo-agent` against a live URL, so
      //    `acquire` (not `workspace`) is the right primitive.
      const container = yield* step("acquire", () => sandbox.acquire({}));

      // 1. Resolve config-store knobs ONCE for the whole run: the per-story
      //    play model + the replay docs base. Read before any browser work so a
      //    misconfigured deploy dies cheaply. (No summary model — the holistic
      //    summary is now built deterministically in-run as markdown below, so
      //    there is no second LLM round-trip and no fragile stories.json file.)
      const playModel = yield* step("resolve-play-model", () =>
        config
          .get("product-demo.model.play")
          .pipe(
            Effect.flatMap((v) =>
              v !== undefined && v !== ""
                ? Effect.succeed(v)
                : Effect.die(
                    "CONFIG_KV missing required key: product-demo.model.play (e.g. `gpt-4o`, `claude-opus-4-7`, `@cf/meta/llama-3.1-70b-instruct`)",
                  ),
            ),
          ),
      );
      const docsBase = yield* step("resolve-docs-base", () =>
        config
          .get("product-demo.docsBase")
          .pipe(Effect.map((override) => override ?? "https://flare-dispatch.fractalbox.com")),
      );

      const screenshotsDir = "/tmp/demo/screenshots";
      // Shared across stories (sequential, concurrency 1): each `play` writes
      // its frames here as `${story}-NNNN.png`, so the final `gif` glob sorts
      // every chapter into walkthrough order. The GIF is built from these.
      const framesDir = "/tmp/demo/frames";

      // WARM the container before the first story. The first exec on a freshly
      // acquired box pays a cold-start tax (image page-cache miss, the 6.7MB
      // demo-agent bundle load, the Sandbox exec path), which made the FIRST
      // play's detached-exec + sentinel-poll slow enough that the poll couldn't
      // read the `DONE` sentinel before the step's wall-clock ceiling — the
      // story came back as a -2 "exceeded wall-clock budget" instead of a real
      // verdict (and its recording with it). One cheap blocking exec here loads
      // demo-agent into cache + warms the exec path so story 0 starts warm.
      yield* step("warmup", () =>
        sandbox
          .exec({
            container,
            command: "mkdir -p /tmp/demo/screenshots; demo-agent --help >/dev/null 2>&1 || true",
          })
          .pipe(
            Effect.timeout("60 seconds"),
            Effect.catchAll(() => Effect.succeed(undefined as never)),
          ),
      );

      /**
       * Run one demo-agent invocation with NO unbounded waits anywhere:
       * detached exec + in-container `timeout -s KILL` + bounded sentinel poll
       * + bounded out/err reads. This is the load-bearing reliability pattern —
       * a container exec connection can HANG (not fail), and `catchAll`
       * recovers failures, never hangs, so any unbounded blocking exec
       * (or an unbounded poll/read after a detached one) eventually rides a
       * step to the CF Workflows step cap and sinks the chapter. Worst-case
       * wall clock ≈ 30s (detach) + pollBudgetSec + 30s (poll grace) + 90s
       * (reads) — callers size their step `timeoutSec` above that.
       */
      const runAgent = ({
        tag,
        argv,
        killAfterSec,
        pollBudgetSec,
      }: {
        readonly tag: string;
        readonly argv: ReadonlyArray<string>;
        readonly killAfterSec: number;
        readonly pollBudgetSec: number;
      }) =>
        Effect.gen(function* () {
          const outPath = `/tmp/demo/${tag}.out`;
          const errPath = `/tmp/demo/${tag}.err`;
          const sentinelPath = `/tmp/demo/${tag}.done`;
          const detachedCmd =
            `( timeout -s KILL ${killAfterSec} ${argv.map(shellQuote).join(" ")} ` +
            `> ${outPath} 2> ${errPath} ); echo "DONE:$?" > ${sentinelPath}`;
          yield* sandbox.runDetached({ container, command: detachedCmd, env: agentEnv }).pipe(
            Effect.timeoutFail({
              duration: "30 seconds",
              onTimeout: () =>
                new ExecTimeout({
                  timeoutSec: 30,
                  command: `${tag}: runDetached hung`,
                }),
            }),
            // The CF Sandbox intermittently rejects a detached process launch
            // with a transient `ContainerLaunchFailed` — the box is alive
            // (every story shares the one acquired container), `startProcess`
            // itself flaked. Un-retried, a single flaked launch propagates out
            // of `runAgent`, fails the `play-${i}` / `record-start-${i}` step
            // (both `retries: 0`), and the outer `catchAll` records the chapter
            // as an exit -3 "infra" failure. That is the dominant reason
            // product-demo chapters fail nondeterministically run-to-run (a
            // different subset every run). Retry the launch up to 3× with
            // exponential backoff; `outPath`/`errPath`/`sentinelPath` are
            // tag-scoped, so a re-launch starts from a clean slate. Only the
            // launch is retried — once the agent is running, the bounded
            // sentinel poll owns the outcome.
            Effect.retry(
              Schedule.exponential("1 second").pipe(
                Schedule.intersect(Schedule.recurs(3)),
                Schedule.whileInput(
                  (e: ContainerLaunchFailed | ExecTimeout) => e._tag === "ContainerLaunchFailed",
                ),
              ),
            ),
          );
          const exitCode = yield* pollSentinel({
            container,
            sentinel: sentinelPath,
            maxAttempts: Math.ceil(pollBudgetSec / 5),
          }).pipe(
            Effect.timeoutTo({
              duration: `${pollBudgetSec + 30} seconds`,
              onSuccess: (c: number) => c,
              onTimeout: () => -2,
            }),
            Effect.catchAll(() => Effect.succeed(-3)),
          );
          const readBounded = (path: string) =>
            sandbox.exec({ container, command: `cat ${path} 2>/dev/null || true` }).pipe(
              Effect.timeout("45 seconds"),
              Effect.map((r) => r.stdout),
              Effect.catchAll(() => Effect.succeed("")),
            );
          const stdout = yield* readBounded(outPath);
          const stderr = yield* readBounded(errPath);
          return { stdout, stderr, exitCode };
        });

      // Defensive parse of an agent's last JSON stdout line — returns null when
      // the agent left no parseable verdict (crash / empty / non-JSON). Lets
      // the caller TELL a real verdict from a synthesized fallback, which is
      // how `failureKind` distinguishes an assertion failure (parseable verdict
      // with status "failed") from infra/timeout/unparseable noise.
      const tryParseLastJson = <T>(stdout: string): T | null => {
        const lastLine = stdout.trim().split("\n").pop() ?? "";
        if (lastLine === "") return null;
        try {
          return JSON.parse(lastLine) as T;
        } catch {
          return null;
        }
      };
      // One bad story marks itself failed, never throws and sinks the run.
      const parseLastJson = <T>(stdout: string, fallback: T): T =>
        tryParseLastJson<T>(stdout) ?? fallback;
      type PlayJson = {
        status: "passed" | "failed";
        durationMs: number;
        chapterStartMs: number;
        chapterEndMs: number;
        narrative: string;
        keyScreenshotPath: string;
      };
      type RecordStopJson = { sessionId: string; eventCount: number };
      type StoryOutcome = {
        name: string;
        status: "passed" | "failed";
        failureKind?: DemoFailureKindT;
        durationMs: number;
        chapterStartMs: number;
        chapterEndMs: number;
        narrative: string;
        keyScreenshotUri: string;
        replayUri: string;
        replayJsonUri: string;
      };

      // 2. Play every story IN PARALLEL, each on its OWN Browser Rendering CDP
      //    session — so each story gets an independent rrweb recording + replay,
      //    its own detached play process, and its own attach → record-start →
      //    play → record-stop pipeline. This is the in-run-parallel design: one
      //    workflow + one container, N concurrent self-contained stories. Each
      //    story's full cycle stays well under CF Workflows' ~600s per-`step.do`
      //    cap, and a slow/stuck story can't starve the others (no shared
      //    session, no first-play serialisation). The detached plays overlap in
      //    the background while short poll/cat execs read their sentinels, so
      //    the expensive work is genuinely concurrent even on one container.
      //    Concurrency is capped so we don't exhaust the Browser Rendering
      //    session pool or the container CPU; extra stories queue.
      //
      // CONCURRENCY 1 (sequential): at 3-wide, three node+puppeteer+model loops
      // (each now also driving a recording session) saturated the standard-4
      // box — even the short `cat` sentinel polls queued, so plays never
      // returned a result before the step ceiling ("exceeded wall-clock
      // budget", exit -2). Sequential keeps the box responsive so each play
      // self-aborts at its `--max-sec` and returns a real verdict; total wall
      // time (~3×5min) still fits maxDurationSec. Raise once a play reliably
      // completes + we confirm the box can take 2-wide.
      const PER_STORY_CONCURRENCY = 1;

      const playStory = (story: { name: string; prose: string }, i: number) =>
        Effect.gen(function* () {
          const sessionIdPath = `/tmp/demo/session-${i}`;
          const replayJsonPath = `/tmp/demo/replay-${i}.json`;

          // prep — reap any demo-agent left wedged by a PRIOR chapter (a hung
          // play/record process keeps puppeteer + its CDP socket alive and
          // degrades every later chapter's CDP ops on the shared box). The
          // pattern can't match this exec's own shell (its cmdline carries the
          // literal `(play|record)` group, not the word). Best-effort.
          yield* step(`prep-${i}`, () =>
            sandbox
              .exec({
                container,
                command: `pkill -9 -f 'demo-agent (play|record)' 2>/dev/null; mkdir -p ${screenshotsDir}; true`,
              })
              .pipe(
                Effect.timeout("30 seconds"),
                Effect.catchAll(() => Effect.succeed(undefined as never)),
              ),
          );

          // attach — this story's OWN session, pre-acquired with Session
          // Recording armed (Browser Run rrweb, Beta). The pre-acquire gives us
          // the REAL session id (the key the recording REST API is fetched by)
          // + a `?browser_session=<id>` re-attach endpoint every demo-agent
          // exec below dials.
          const attached = yield* step(`attach-cdp-${i}`, () =>
            browser.newCDPSession({ targetUrl: input.deployedUrl, recording: true }).pipe(
              Effect.map((session) => ({
                wsEndpoint: session.wsEndpoint,
                sessionId: session.sessionId ?? "",
              })),
            ),
          );
          // The session the rest of the chapter dials — replaced by a fresh
          // one if record-start finds it dead (see recovery below).
          let activeWs = attached.wsEndpoint;
          let activeSessionId = attached.sessionId;

          // record-start — navigate to the app + persist the REAL session id.
          // The agent REQUIRES `--session-id` (the CDP-derived fallback id is
          // not recognised by the recording REST API — the agent fails loudly
          // without it rather than persist an unusable one; the recovery below
          // is that loud failure's path). Runs DETACHED + bounded
          // (`runAgent`): as a blocking exec this was the run's worst wedge —
          // the navigation to a heavy app page can hang the agent, and a hung
          // exec connection rode the step to the Workflows step cap, killing
          // the session and the chapter with it.
          const recordStartArgv = (ws: string, sid: string) => [
            "demo-agent",
            "record",
            "start",
            "--cdp-ws",
            ws,
            "--viewport",
            viewport,
            "--session-id-out",
            sessionIdPath,
            "--url",
            input.deployedUrl,
            ...(sid !== "" ? ["--session-id", sid] : []),
          ];
          const startResult = yield* step(
            `record-start-${i}`,
            () =>
              runAgent({
                tag: `record-start-${i}`,
                argv: recordStartArgv(activeWs, activeSessionId),
                killAfterSec: 120,
                pollBudgetSec: 150,
              }),
            { timeoutSec: 360, retries: 0 },
          ).pipe(
            Effect.catchAll((cause) =>
              Effect.succeed({
                stdout: "",
                stderr: `record-start step failed: ${String(cause)}`,
                exitCode: -3,
              }),
            ),
          );

          // recovery — a failed record-start usually means the pre-acquired
          // session died (or never came up). Acquire ONE fresh session and
          // retry; if that fails too, play anyway WITHOUT a recording (the
          // agent's play navigates an about:blank page itself). A chapter
          // with no replay beats a chapter lost to recording setup.
          if (startResult.exitCode !== 0) {
            yield* io.log(
              "warn",
              `story '${story.name}': record-start failed (exit ${startResult.exitCode}) — re-acquiring session. stderr tail: ${startResult.stderr.slice(-200)}`,
            );
            const fresh = yield* step(`reattach-cdp-${i}`, () =>
              browser.newCDPSession({ targetUrl: input.deployedUrl, recording: true }).pipe(
                Effect.map((session) => ({
                  wsEndpoint: session.wsEndpoint,
                  sessionId: session.sessionId ?? "",
                })),
              ),
            ).pipe(
              Effect.catchAll(() =>
                Effect.succeed<{ wsEndpoint: string; sessionId: string } | null>(null),
              ),
            );
            if (fresh !== null) {
              activeWs = fresh.wsEndpoint;
              activeSessionId = fresh.sessionId;
              yield* step(
                `record-start-${i}-retry`,
                () =>
                  runAgent({
                    tag: `record-start-${i}-retry`,
                    argv: recordStartArgv(activeWs, activeSessionId),
                    killAfterSec: 120,
                    pollBudgetSec: 150,
                  }),
                { timeoutSec: 360, retries: 0 },
              ).pipe(Effect.catchAll(() => Effect.succeed(undefined)));
            }
          }

          // play — DETACHED + sentinel-poll via `runAgent` (every wait
          // bounded). If the poll missed the sentinel (-2/-3) but the play
          // left a parseable verdict in its out file, treat it as a clean
          // completion — the verdict is the verdict regardless of how the
          // poll fared.
          const playResult = yield* step(
            `play-${i}`,
            () =>
              runAgent({
                tag: `play-${i}`,
                argv: [
                  "demo-agent",
                  "play",
                  "--cdp-ws",
                  activeWs,
                  "--name",
                  story.name,
                  "--prose",
                  story.prose,
                  "--screenshots",
                  screenshotsDir,
                  "--frames-dir",
                  framesDir,
                  "--max-sec",
                  String(perStorySec),
                  "--model",
                  playModel,
                  "--url",
                  input.deployedUrl,
                ],
                killAfterSec: perStorySec + 60,
                pollBudgetSec: perStorySec + 90,
              }).pipe(
                Effect.map((r) => ({
                  ...r,
                  exitCode: r.exitCode < 0 && r.stdout.trim() !== "" ? 0 : r.exitCode,
                })),
              ),
            { timeoutSec: perStorySec + 330, retries: 0 },
          ).pipe(
            Effect.catchAll((cause) =>
              Effect.succeed({
                stdout: "",
                stderr: `play step failed: ${String(cause)}`,
                exitCode: -3,
              }),
            ),
          );

          // record-stop — close THIS session + pull its rrweb recording.
          // DETACHED + bounded like record-start: the recording REST fetch
          // retries + the session close can both stall, and a blocking exec
          // that hangs would ride the step to the cap. Best-effort.
          const recordStopResult = yield* step(
            `record-stop-${i}`,
            () =>
              runAgent({
                tag: `record-stop-${i}`,
                argv: [
                  "demo-agent",
                  "record",
                  "stop",
                  "--cdp-ws",
                  activeWs,
                  "--session-id-in",
                  sessionIdPath,
                  "--out",
                  replayJsonPath,
                ],
                killAfterSec: 120,
                pollBudgetSec: 150,
              }),
            { timeoutSec: 360, retries: 0 },
          ).pipe(Effect.catchAll(() => Effect.succeed({ stdout: "", stderr: "", exitCode: 1 })));

          const playParsed = tryParseLastJson<PlayJson>(playResult.stdout);
          const pj: PlayJson = playParsed ?? {
            status: "failed",
            durationMs: 0,
            chapterStartMs: 0,
            chapterEndMs: 0,
            narrative: `play produced no parseable result (exit ${playResult.exitCode}). stderr tail: ${playResult.stderr.slice(-400)}`,
            keyScreenshotPath: "",
          };
          // Classify WHY a chapter failed (the keystone gate). A parseable
          // verdict with status "failed" = the agent played the journey and the
          // app misbehaved (assertion — heal-worthy). No parseable verdict =
          // flake/environment: exit -2 is the wall-clock kill (timeout), -3 the
          // step/poll death (infra), anything else a crash (unparseable). Only
          // "assertion" ever becomes a signal — see storyResultsToSignals.
          const failureKind: DemoFailureKindT | undefined =
            pj.status === "passed"
              ? undefined
              : playParsed !== null
                ? "assertion"
                : playResult.exitCode === -2
                  ? "timeout"
                  : playResult.exitCode === -3
                    ? "infra"
                    : "unparseable";
          const rs = parseLastJson<RecordStopJson>(recordStopResult.stdout, {
            sessionId: "",
            eventCount: 0,
          });

          // Per-story uploads (best-effort): the replay JSON + the key frame.
          const replayJsonUri = yield* step(`upload-replay-${i}`, () =>
            artifact
              .upload({
                name: `replay-${i}.json`,
                path: replayJsonPath,
                // `container` is REQUIRED — the runtime reads `path` from THIS
                // container's filesystem. Omitting it silently fails the upload
                // (caught below) so the artifact never lands in R2 — the cause
                // of the empty replay links / "replay is not a valid url".
                container,
                contentType: "application/json",
                signedUrlTTL: "30 days",
              })
              .pipe(
                // The upload reads from the container FS — bound it like every
                // other container interaction (a hung read = a capped step).
                Effect.timeout("90 seconds"),
                // Best-effort, but NEVER silent: a bare `catchAll(() => "")`
                // here swallowed every replay-upload failure — the step
                // "succeeded" with "" and nothing recorded why. Log the cause
                // so a broken upload is diagnosable from the run's io.log.
                Effect.catchAllCause((cause) =>
                  io
                    .log(
                      "warn",
                      `story '${story.name}': replay-${i}.json upload failed — ${Cause.pretty(cause).slice(0, 400)}`,
                    )
                    .pipe(Effect.as("")),
                ),
              ),
          );
          const keyScreenshotUri =
            pj.keyScreenshotPath === ""
              ? ""
              : yield* step(`upload-screenshot-${i}`, () =>
                  artifact
                    .upload({
                      name: `${story.name}.png`,
                      path: pj.keyScreenshotPath,
                      container,
                      contentType: "image/png",
                      signedUrlTTL: "30 days",
                    })
                    .pipe(
                      Effect.timeout("90 seconds"),
                      Effect.catchAllCause((cause) =>
                        io
                          .log(
                            "warn",
                            `story '${story.name}': screenshot upload failed — ${Cause.pretty(cause).slice(0, 400)}`,
                          )
                          .pipe(Effect.as("")),
                      ),
                    ),
                );

          const replayUri = rs.sessionId !== "" ? `${docsBase}/replay/${rs.sessionId}` : "";

          yield* io.log(
            "info",
            `story '${story.name}': ${pj.status} (${rs.eventCount} rrweb events, replay ${rs.sessionId !== "" ? "ok" : "none: " + (recordStopResult.stderr || "").slice(-120)})`,
          );

          return {
            name: story.name,
            status: pj.status,
            ...(failureKind !== undefined ? { failureKind } : {}),
            durationMs: pj.durationMs,
            chapterStartMs: pj.chapterStartMs,
            chapterEndMs: pj.chapterEndMs,
            narrative: pj.narrative,
            keyScreenshotUri,
            replayUri,
            replayJsonUri,
          };
        }).pipe(
          // One story's INFRA failure (a failed attach, a dropped session)
          // must not sink the parallel run — mark that one story failed. This
          // path is by definition `infra` (the pipeline itself broke, not the
          // app), so it never becomes a heal signal.
          Effect.catchAll((cause) =>
            Effect.succeed<StoryOutcome>({
              name: story.name,
              status: "failed",
              failureKind: "infra",
              durationMs: 0,
              chapterStartMs: 0,
              chapterEndMs: 0,
              narrative: `story pipeline failed: ${String(cause)}`,
              keyScreenshotUri: "",
              replayUri: "",
              replayJsonUri: "",
            }),
          ),
        );

      const stories = yield* Effect.forEach(resolvedStories, playStory, {
        concurrency: PER_STORY_CONCURRENCY,
      });

      // 3. Build the holistic summary as MARKDOWN, in-run + deterministic — no
      //    second LLM call, no stories.json file to go missing across execs.
      const passedCount = stories.filter((s) => s.status === "passed").length;
      const summaryMd = [
        `# product-demo — ${passedCount}/${stories.length} chapters passed`,
        "",
        "| Chapter | Result | Replay | Notes |",
        "| --- | --- | --- | --- |",
        ...stories.map((s) => {
          const replay =
            s.replayUri !== ""
              ? `[replay](${s.replayUri})`
              : s.replayJsonUri !== ""
                ? `[rrweb json](${s.replayJsonUri})`
                : "—";
          const note = s.narrative.replace(/\n+/g, " ").slice(0, 200);
          return `| ${s.name} | ${s.status === "passed" ? "✅ pass" : "❌ fail"} | ${replay} | ${note} |`;
        }),
      ].join("\n");

      yield* io.log("info", `product-demo: ${stories.length} stories, ${passedCount} passed`);

      // The top-level replay points at the first story that produced one (the
      // structured per-story replays live in `stories[]`).
      const primary = stories.find((s) => s.replayUri !== "") ?? stories[0];

      // 3.5. Persist the markdown summary (with per-story narratives) as an
      //      artifact on BOTH the pass AND fail paths — so a FAILED run (whose
      //      `summary_json` the dispatcher discards on a failed Exit) is still
      //      diagnosable: fetch `artifacts/<execId>/summary.md` from R2. Without
      //      this, an honest red check hides WHY every chapter failed.
      //      Best-effort — never let a diagnostics upload change the verdict.
      yield* step("upload-summary", () =>
        sandbox
          .exec({
            container,
            // shellQuote — the CF Sandbox runs commands through a shell, and
            // the markdown `--data` (pipes, newlines, quotes, maybe `&`) would
            // otherwise break parsing (this is also why the earlier array form
            // silently produced no summary.md). write-prior writes `--data`
            // verbatim to `--out`.
            command: [
              "demo-agent",
              "write-prior",
              "--out",
              "/tmp/demo/summary.md",
              "--data",
              summaryMd,
            ]
              .map(shellQuote)
              .join(" "),
          })
          .pipe(
            Effect.timeout("60 seconds"),
            Effect.andThen(
              artifact.upload({
                name: "summary.md",
                path: "/tmp/demo/summary.md",
                container,
                contentType: "text/markdown",
                signedUrlTTL: "30 days",
              }),
            ),
            Effect.timeout("3 minutes"),
            Effect.catchAll(() => Effect.succeed("")),
          ),
      );

      // 3.6. Stitch the per-action frames into ONE walkthrough GIF, then —
      //      when this dispatch named a PR — post the holistic summary as a PR
      //      comment with the GIF embedded inline. GitHub PR comments can't
      //      embed video, but they render animated GIFs, so this lands the demo
      //      itself in the review thread (the rrweb replay link stays for full
      //      fidelity). Runs on BOTH the pass and fail paths (below the honest
      //      check) so a RED demo still drops its walkthrough on the PR. Every
      //      part is best-effort: a GIF-encode, upload, or comment failure logs
      //      + is swallowed and never flips the verdict (which derives purely
      //      from `passedCount`). No `pr` (e.g. a Schedule-mode firing) ⇒ no
      //      comment; the check-run summary remains the report.
      const gifStdout = yield* step("render-gif", () =>
        sandbox
          .exec({
            container,
            // shellQuote — same shell-safety the upload-summary exec needs.
            // The `gif` subcommand globs `framesDir` (sorted), downscales to
            // <=800px, drops frames evenly to stay under GitHub camo's ~10MB
            // limit, and emits `{gifPath,frameCount,bytes,...}` on its last line.
            command: [
              "demo-agent",
              "gif",
              "--frames",
              framesDir,
              "--out",
              "/tmp/demo/demo.gif",
              "--max-width",
              "800",
              "--max-bytes",
              "10000000",
            ]
              .map(shellQuote)
              .join(" "),
          })
          .pipe(
            Effect.timeout("120 seconds"),
            Effect.map((r) => r.stdout),
            Effect.catchAll(() => Effect.succeed("")),
          ),
      );
      type GifJson = { gifPath: string; frameCount: number; bytes: number };
      const gj = parseLastJson<GifJson>(gifStdout, {
        gifPath: "",
        frameCount: 0,
        bytes: 0,
      });
      // Upload the GIF under the STABLE artifact URL (not a presigned R2 URL):
      // GitHub's camo proxy fetches it server-side, so the embed keeps
      // rendering after any presign would have rotated. `image/gif` so the
      // single-file artifact branch serves the bytes as an image.
      const gifUri =
        gj.gifPath === "" || gj.frameCount === 0
          ? ""
          : yield* step("upload-gif", () =>
              artifact
                .upload({
                  name: "demo.gif",
                  path: "/tmp/demo/demo.gif",
                  container,
                  contentType: "image/gif",
                  signedUrlTTL: "30 days",
                })
                .pipe(
                  Effect.timeout("90 seconds"),
                  Effect.catchAllCause((cause) =>
                    io
                      .log(
                        "warn",
                        `product-demo: demo.gif upload failed — ${Cause.pretty(cause).slice(0, 400)}`,
                      )
                      .pipe(Effect.as("")),
                  ),
                ),
            );

      // 3.7. Render ONE GIF per chapter from that chapter's own frames (the
      //      play loop names every frame `${story}-NNNN.png`, so `--match` on
      //      the story name selects exactly one chapter out of the shared
      //      frames dir). These power the per-chapter gallery on the
      //      `/demos/:execution` page — the combined `demo.gif` above stays the
      //      single walkthrough the PR comment embeds. Best-effort per chapter:
      //      an encode/upload failure leaves that chapter's `chapterGifUri`
      //      unset (the page falls back to its key screenshot) and never flips
      //      the verdict. Indexed by the chapter's position in `stories`.
      const chapterGifUris = yield* Effect.forEach(
        stories,
        (s, i) =>
          step(`render-chapter-gif-${i}`, () =>
            sandbox
              .exec({
                container,
                command: [
                  "demo-agent",
                  "gif",
                  "--frames",
                  framesDir,
                  "--match",
                  `${s.name}-`,
                  "--out",
                  `/tmp/demo/chapter-${i}.gif`,
                  "--max-width",
                  "800",
                  "--max-bytes",
                  "10000000",
                ]
                  .map(shellQuote)
                  .join(" "),
              })
              .pipe(
                Effect.timeout("120 seconds"),
                Effect.map((r) => r.stdout),
                Effect.catchAll(() => Effect.succeed("")),
              ),
          ).pipe(
            Effect.flatMap((stdout) => {
              const cj = parseLastJson<GifJson>(stdout, {
                gifPath: "",
                frameCount: 0,
                bytes: 0,
              });
              if (cj.gifPath === "" || cj.frameCount === 0) {
                return Effect.succeed("");
              }
              return step(`upload-chapter-gif-${i}`, () =>
                artifact
                  .upload({
                    name: `chapter-${i}.gif`,
                    path: `/tmp/demo/chapter-${i}.gif`,
                    container,
                    contentType: "image/gif",
                    signedUrlTTL: "30 days",
                  })
                  .pipe(
                    Effect.timeout("90 seconds"),
                    Effect.catchAllCause((cause) =>
                      io
                        .log(
                          "warn",
                          `product-demo: chapter-${i}.gif upload failed — ${Cause.pretty(cause).slice(0, 400)}`,
                        )
                        .pipe(Effect.as("")),
                    ),
                  ),
              );
            }),
          ),
        { concurrency: PER_STORY_CONCURRENCY },
      );

      // Fold each chapter's GIF URL back onto its story result so the page (and
      // any downstream consumer of `summary_json`) gets it inline.
      const storiesWithGifs = stories.map((s, i) =>
        chapterGifUris[i] !== undefined && chapterGifUris[i] !== ""
          ? { ...s, chapterGifUri: chapterGifUris[i]! }
          : s,
      );

      // 3.8. Derive `signals/v1` from the ASSERTION-failed chapters (the pure,
      //      unit-tested adapter — packages/core/src/demo-signals.ts). Flake,
      //      infra, timeout, and passing chapters produce nothing, so the
      //      output is heal-worthy by construction. The chapter NARRATIVE is
      //      UNTRUSTED (an LLM summary of a live, possibly attacker-influenced
      //      page); the adapter fences it into `detail` and fingerprints on the
      //      operator-authored chapter name.
      const signals = storyResultsToSignals(storiesWithGifs, {
        repo: input.repo,
        deployedUrl: input.deployedUrl,
      });
      yield* io.log("info", `product-demo: ${signals.length} signal(s) from assertion failures`);

      // 3.9. Persist the STRUCTURED chapter results + derived signals as R2
      //      artifacts on BOTH paths. The dispatcher discards `summary_json`
      //      (the Output) on a FAILED Exit — exactly the run that most warrants
      //      triage — so without this the structured data (per-chapter status,
      //      failureKind, replay URIs) and the signals are lost on red. A
      //      consumer (ci-triage-pr today; self-heal later) reads
      //      `artifacts/<execId>/signals.json`. Best-effort: a diagnostics
      //      upload never changes the verdict. `write-prior` writes `--data`
      //      verbatim; shellQuote keeps the JSON intact through the shell.
      const persistJsonArtifact = (name: string, value: unknown) =>
        step(`upload-${name}`, () =>
          sandbox
            .exec({
              container,
              command: [
                "demo-agent",
                "write-prior",
                "--out",
                `/tmp/demo/${name}`,
                "--data",
                JSON.stringify(value),
              ]
                .map(shellQuote)
                .join(" "),
            })
            .pipe(
              Effect.timeout("60 seconds"),
              Effect.andThen(
                artifact.upload({
                  name,
                  path: `/tmp/demo/${name}`,
                  container,
                  contentType: "application/json",
                  signedUrlTTL: "30 days",
                }),
              ),
              Effect.timeout("3 minutes"),
              Effect.catchAllCause((cause) =>
                io
                  .log(
                    "warn",
                    `product-demo: ${name} upload failed (best-effort) — ${Cause.pretty(cause).slice(0, 400)}`,
                  )
                  .pipe(Effect.as("")),
              ),
            ),
        );
      yield* persistJsonArtifact("stories.json", storiesWithGifs);
      yield* persistJsonArtifact("signals.json", signals);

      // Story name → operator-authored prose. Feeds the bundle manifest's
      // narration source (3.92) and the self-heal confirm re-plays (3.95).
      const proseByName = new Map(resolvedStories.map((s) => [s.name, s.prose]));

      // 3.92. demo-bundle/v1 (specs/10-demo-bundle.md): archive the raw
      //       per-action PNG frames and publish a machine-readable manifest of
      //       this execution's demo artifacts. The GIFs above are lossy +
      //       downscaled for GitHub's camo budget; `frames.tar` keeps the
      //       full-resolution footage so a downstream presentation consumer
      //       (autopresenter via the `demo-reel` child run) can render real
      //       video from it. Manifest entries are RELATIVE artifact names, so
      //       the bundle works as an R2 prefix, a `/v1/artifacts/<exec>/`
      //       fetch, or a plain local directory. Best-effort on BOTH paths (a
      //       red demo still ships its bundle — failing footage is exactly
      //       what a triager wants to watch); never flips the verdict.
      const framesTarStdout = yield* step("archive-frames", () =>
        sandbox
          .exec({
            container,
            // Plain tar, no gzip: the PNGs are already compressed. TAR_OK on
            // the last line is the success sentinel; an absent/empty frames
            // dir (no story captured a frame) reports TAR_EMPTY and skips.
            command:
              `if [ -d ${framesDir} ] && [ -n "$(ls -A ${framesDir} 2>/dev/null)" ]; ` +
              `then tar -cf /tmp/demo/frames.tar -C ${framesDir} . && echo TAR_OK; ` +
              `else echo TAR_EMPTY; fi`,
          })
          .pipe(
            Effect.timeout("120 seconds"),
            Effect.map((r) => r.stdout),
            Effect.catchAll(() => Effect.succeed("")),
          ),
      );
      const framesTarUri = !framesTarStdout.includes("TAR_OK")
        ? ""
        : yield* step("upload-frames-archive", () =>
            artifact
              .upload({
                name: "frames.tar",
                path: "/tmp/demo/frames.tar",
                container,
                contentType: "application/x-tar",
                signedUrlTTL: "30 days",
              })
              .pipe(
                Effect.timeout("3 minutes"),
                Effect.catchAllCause((cause) =>
                  io
                    .log(
                      "warn",
                      `product-demo: frames.tar upload failed (best-effort) — ${Cause.pretty(cause).slice(0, 400)}`,
                    )
                    .pipe(Effect.as("")),
                ),
              ),
          );
      const bundleUri = yield* persistJsonArtifact(
        "manifest.json",
        buildDemoBundleManifest({
          repo: input.repo,
          sha: input.sha,
          target: input.deployedUrl,
          chapters: storiesWithGifs,
          proseByName,
          hasGif: gifUri !== "",
          hasFramesArchive: framesTarUri !== "",
        }),
      );

      // 3.93. (gated, OFF by default) Ride the bundle into a presentation:
      //       dispatch the `demo-reel` child run, which renders a narrated
      //       deck (+ MP4 when the image carries ffmpeg) from this
      //       execution's demo-bundle/v1 via autopresenter. Opt-in
      //       (`demo-reel.enabled` = "true") because every reel is a
      //       container + (potentially) TTS/encode spend; deduped on the
      //       bundle URL so a Workflow replay never double-renders.
      //       Best-effort — a reel dispatch failure never flips the demo
      //       verdict. See runs/demo-reel.ts + specs/10-demo-bundle.md.
      const reelEnabled = (yield* config.get("demo-reel.enabled")) === "true";
      if (reelEnabled && bundleUri !== "") {
        yield* step("dispatch-demo-reel", () =>
          spawnChildRun({
            run: "demo-reel",
            input: {
              repo: input.repo,
              sha: input.sha,
              bundleUrl: bundleUri,
              ...(input.pr !== undefined ? { pr: input.pr } : {}),
              ...(input.installationId !== undefined
                ? { installationId: input.installationId }
                : {}),
            },
            instanceId: `demo-reel:${bundleUri}`.slice(0, 200),
          }),
        ).pipe(
          Effect.flatMap((handle) =>
            io.log(
              "info",
              `product-demo: dispatched demo-reel ${handle.executionId}${handle.created ? "" : " (deduped — already dispatched)"}`,
            ),
          ),
          Effect.catchAllCause((cause) =>
            io.log(
              "warn",
              `product-demo: demo-reel dispatch failed (best-effort) — ${Cause.pretty(cause).slice(0, 400)}`,
            ),
          ),
        );
      }

      // 3.95. (gated, OFF by default) Auto-dispatch self-heal for assertion
      //       failures. A demo verdict is LLM-driven, so a single red chapter is
      //       NOT ground truth — re-play each assertion failure k-of-n times and
      //       escalate only the ones that fail DETERMINISTICALLY. Confirmed
      //       chapters become a `demo`-class incident/v1 pack (verified later by
      //       a regression test the agent writes — never a browser re-run; see
      //       specs/08 § 4.1) dispatched to `self-heal-pr` as a child run.
      //
      //       COST POSTURE (specs/08 § 9): every control is opt-in + bounded.
      //       OFF unless `self-heal.demo.enabled=true`; each confirm re-play is a
      //       full browser+model loop, so `confirm-runs` is clamped (≤5) and only
      //       up to `max-chapters` (≤10) assertion failures are confirmed per
      //       run; per-heal model spend is bounded by the AgentBudget DO; child
      //       dedup is the deterministic instanceId (incidentId + sha). Best-
      //       effort throughout — never flips the demo verdict.
      const demoHealEnabled = (yield* config.get("self-heal.demo.enabled")) === "true";
      if (demoHealEnabled) {
        const clampInt = (raw: string | undefined, def: number, lo: number, hi: number) => {
          const n = Number.parseInt(raw ?? "", 10);
          return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
        };
        const testCommand = yield* config.get("self-heal.demo.test-command");
        const confirmRuns = clampInt(yield* config.get("self-heal.demo.confirm-runs"), 2, 1, 5);
        const threshold = Math.min(
          confirmRuns,
          clampInt(yield* config.get("self-heal.demo.confirm-threshold"), 2, 1, 5),
        );
        const maxChapters = clampInt(yield* config.get("self-heal.demo.max-chapters"), 3, 1, 10);

        // One confirmation re-play on a fresh NON-recording session (cheaper than
        // playStory: no rrweb, no frames, no uploads). Returns the agent verdict,
        // or "inconclusive" on any infra/parse failure — an inconclusive re-play
        // is NOT counted as a failure, so flake/infra can only ever REDUCE the
        // confidence to escalate, never manufacture it.
        const confirmPlay = (name: string, prose: string, tag: string) =>
          Effect.gen(function* () {
            const attached = yield* browser.newCDPSession({
              targetUrl: input.deployedUrl,
              recording: false,
            });
            const res = yield* runAgent({
              tag,
              argv: [
                "demo-agent",
                "play",
                "--cdp-ws",
                attached.wsEndpoint,
                "--name",
                name,
                "--prose",
                prose,
                "--screenshots",
                "/tmp/demo/confirm",
                "--frames-dir",
                "/tmp/demo/confirm",
                "--max-sec",
                String(perStorySec),
                "--model",
                playModel,
                "--url",
                input.deployedUrl,
              ],
              killAfterSec: perStorySec + 60,
              pollBudgetSec: perStorySec + 90,
            });
            const parsed = tryParseLastJson<PlayJson>(res.stdout);
            return (parsed?.status ?? "inconclusive") as "passed" | "failed" | "inconclusive";
          }).pipe(Effect.catchAll(() => Effect.succeed("inconclusive" as const)));

        const toConfirm = storiesWithGifs
          .filter((s) => s.status === "failed" && s.failureKind === "assertion")
          .slice(0, maxChapters);

        const confirmed: DemoChapterResult[] = [];
        for (let ci = 0; ci < toConfirm.length; ci++) {
          const s = toConfirm[ci]!;
          const prose = proseByName.get(s.name) ?? "";
          let failures = 1; // the original assertion failure
          let conclusive = 1;
          for (let r = 1; r < confirmRuns; r++) {
            const verdict = yield* step(
              `confirm-${ci}-${r}`,
              () => confirmPlay(s.name, prose, `confirm-${ci}-${r}`),
              { timeoutSec: perStorySec + 330, retries: 0 },
            ).pipe(Effect.catchAll(() => Effect.succeed("inconclusive" as const)));
            if (verdict !== "inconclusive") conclusive += 1;
            if (verdict === "failed") failures += 1;
          }
          yield* io.log(
            "info",
            `product-demo: chapter '${s.name}' confirm ${failures}/${conclusive} failed (threshold ${threshold})`,
          );
          if (failures >= threshold) {
            confirmed.push({
              name: s.name,
              status: "failed",
              failureKind: "assertion",
              narrative: s.narrative,
              replayUri: s.replayUri,
              replayJsonUri: s.replayJsonUri,
              keyScreenshotUri: s.keyScreenshotUri,
              chapterStartMs: s.chapterStartMs,
              chapterEndMs: s.chapterEndMs,
              failedRuns: failures,
              totalRuns: conclusive,
            });
          }
        }

        if (confirmed.length === 0) {
          yield* io.log(
            "info",
            "product-demo: no chapters confirmed deterministically — no self-heal",
          );
        } else if ((testCommand ?? "") === "") {
          yield* io.log(
            "warn",
            `product-demo: ${confirmed.length} confirmed failure(s) but self-heal.demo.test-command is unset — cannot verify a fix, skipping self-heal`,
          );
        } else {
          const incident = storyResultsToIncident(confirmed, {
            repo: input.repo,
            deployedUrl: input.deployedUrl,
            headSha: input.sha,
            testCommand,
          });
          if (incident !== null) {
            yield* step("dispatch-self-heal", () =>
              spawnChildRun({
                run: "self-heal-pr",
                input: { incident },
                // Deterministic dedup: same failing chapter-set on the same head
                // SHA collapses to one heal (CF create({id}) no-op on replay /
                // re-dispatch). A new commit re-heals.
                instanceId: `self-heal:${incident.incidentId}:${input.sha}`.slice(0, 200),
              }),
            ).pipe(
              Effect.flatMap((handle) =>
                io.log(
                  "info",
                  `product-demo: dispatched self-heal-pr ${handle.executionId} for ${confirmed.length} confirmed chapter(s)${handle.created ? "" : " (deduped — already dispatched)"}`,
                ),
              ),
              Effect.catchAllCause((cause) =>
                io.log(
                  "warn",
                  `product-demo: self-heal dispatch failed (best-effort) — ${Cause.pretty(cause).slice(0, 400)}`,
                ),
              ),
            );
          }
        }
      }

      if (input.pr !== undefined) {
        const commentBody = [
          summaryMd,
          "",
          ...(gifUri !== "" ? [`![product-demo walkthrough](${gifUri})`, ""] : []),
          ...(primary?.replayUri !== undefined && primary.replayUri !== ""
            ? [`▶ [Scrub the full rrweb replay](${primary.replayUri})`]
            : []),
        ].join("\n");
        yield* step("post-pr-comment", () =>
          github
            .pullReview({
              repo: input.repo,
              pr: input.pr!,
              sha: input.sha,
              body: commentBody,
              ...(input.installationId !== undefined
                ? { installationId: input.installationId }
                : {}),
            })
            .pipe(
              Effect.timeout("60 seconds"),
              Effect.catchAllCause((cause) =>
                io.log(
                  "warn",
                  `product-demo: PR comment post failed (best-effort) — ${Cause.pretty(cause).slice(0, 400)}`,
                ),
              ),
            ),
        );
      }

      // 4. HONEST CHECK: a demo where NO chapter passed is broken, not green —
      //    fail so the dispatcher posts a `failure` conclusion (the verdict
      //    derives from the run Exit; the markdown summary + per-story replays
      //    are persisted to R2 as `summary.md` above, so a red run is still
      //    diagnosable). A partial pass still SUCCEEDS so the green check + the
      //    summary table show which chapters passed/failed, and the email links
      //    the replay URL of the first recorded chapter.
      if (passedCount === 0) {
        // Attach the per-chapter table to the typed failure (issue #85) — the
        // dispatcher embeds `summaryMd` beneath the generic line in the red
        // check-run summary + the notify email, so the failure narrative is
        // visible on the PR itself, not only in the R2 `summary.md`.
        return yield* Effect.fail(new AcceptanceFailed({ exitCode: 1, summaryMd }));
      }

      // The check-run summary the Dispatcher posts EMBEDS `summaryMd` verbatim.
      return {
        replayUri: primary?.replayUri ?? "",
        replayJsonUri: primary?.replayJsonUri ?? "",
        summaryMd,
        stories: storiesWithGifs,
        signals,
        ...(gifUri !== "" ? { gifUri } : {}),
        ...(bundleUri !== "" ? { bundleUri } : {}),
      };
    }),
});
