// Unit tests for the `product-demo` run.
//
// The substantive surface this PR adds is `parseStoriesMarkdown` — a pure
// function turning a markdown demo script (one `## ` heading per story) into
// the run's `{ name, prose }[]`. It's covered exhaustively here because that's
// where the parsing bugs live; the function is pure (no runtime needed).
//
// The run-level cases cover the input RESOLUTION that sits before any
// browser/sandbox work, so they need no CDP/agent stubs:
//   (a) neither `stories` nor `storiesMarkdown` → the run Effect dies.
//   (b) `storiesMarkdown` with no `## ` heading → dies (parses to empty).
//   (c) duplicate story names → dies (names are rrweb chapter markers).
// The full play/record/summarize orchestration needs the demo-agent CLI +
// Browser Run and is exercised end-to-end on the Dispatcher, not here.

import { it } from "@effect/vitest";
import { Cause, Effect, Exit, Match, Option } from "effect";
import { describe, expect } from "vitest";
import { makeCFRuntimeTest } from "@fractalbox/flare-dispatch-core/testing";
import {
  buildDemoBundleManifest,
  parseStoriesMarkdown,
  productDemo,
} from "./product-demo";

const baseInput = {
  repo: "owner/app",
  sha: "deadbeef",
  deployedUrl: "https://staging.example.com",
} as const;

describe("parseStoriesMarkdown", () => {
  it("turns each `## ` heading into a { name, prose } story", () => {
    const md = [
      "## sign-in",
      "Open the site and log in with the demo account.",
      "",
      "## create-project",
      "Create a project called Demo and confirm the empty-state CTA.",
    ].join("\n");

    expect(parseStoriesMarkdown(md)).toEqual([
      {
        name: "sign-in",
        prose: "Open the site and log in with the demo account.",
      },
      {
        name: "create-project",
        prose: "Create a project called Demo and confirm the empty-state CTA.",
      },
    ]);
  });

  it("ignores a `# Title` and preamble before the first `## ` heading", () => {
    const md = [
      "# Demo script",
      "",
      "Some context the agent never sees.",
      "",
      "## landing",
      "Visit the homepage; the primary CTA is above the fold.",
    ].join("\n");

    expect(parseStoriesMarkdown(md)).toEqual([
      {
        name: "landing",
        prose: "Visit the homepage; the primary CTA is above the fold.",
      },
    ]);
  });

  it("keeps deeper headings (`###`) inside the enclosing story's prose", () => {
    const md = [
      "## checkout",
      "Add an item to the cart, then:",
      "",
      "### edge case",
      "Apply an expired coupon and confirm the inline error.",
    ].join("\n");

    const stories = parseStoriesMarkdown(md);
    expect(stories).toHaveLength(1);
    expect(stories[0]!.name).toBe("checkout");
    expect(stories[0]!.prose).toContain("### edge case");
    expect(stories[0]!.prose).toContain("expired coupon");
  });

  it("trims heading whitespace, trailing `#`, and surrounding blank lines", () => {
    const md = ["##   spaced heading  ##  ", "", "  body text  ", ""].join(
      "\n",
    );
    expect(parseStoriesMarkdown(md)).toEqual([
      { name: "spaced heading", prose: "body text" },
    ]);
  });

  it("returns [] for a doc with no `## ` headings", () => {
    expect(parseStoriesMarkdown("# Title only\n\njust prose, no stories")).toEqual(
      [],
    );
    expect(parseStoriesMarkdown("")).toEqual([]);
  });

  it("does not treat `###`+ as a story boundary", () => {
    const md = ["### not a story", "body"].join("\n");
    expect(parseStoriesMarkdown(md)).toEqual([]);
  });

  it("handles CRLF line endings", () => {
    const md = "## a\r\nfirst\r\n## b\r\nsecond";
    expect(parseStoriesMarkdown(md)).toEqual([
      { name: "a", prose: "first" },
      { name: "b", prose: "second" },
    ]);
  });
});

describe("product-demo input resolution", () => {
  const expectDie = (input: Record<string, unknown>, substring: string) => {
    const { layer } = makeCFRuntimeTest();
    return Effect.gen(function* () {
      // `input` is intentionally partial (missing/invalid stories) to exercise
      // the resolution guard — cast past the decoded Input type for the test.
      const exit = yield* Effect.exit(
        productDemo.run(input as Parameters<typeof productDemo.run>[0]),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain(substring);
      }
    }).pipe(Effect.provide(layer));
  };

  it.effect("dies when neither `stories` nor `storiesMarkdown` is given", () =>
    expectDie(baseInput, "no stories to play"),
  );

  it.effect("dies when `storiesMarkdown` has no `## ` heading", () =>
    expectDie(
      { ...baseInput, storiesMarkdown: "# Title\n\nno stories here" },
      "no stories to play",
    ),
  );

  it.effect("dies on duplicate story names", () =>
    expectDie(
      {
        ...baseInput,
        stories: [
          { name: "dup", prose: "first" },
          { name: "dup", prose: "second" },
        ],
      },
      "duplicate story names",
    ),
  );
});

describe("product-demo honest check (issue #85)", () => {
  it.effect(
    "fails with AcceptanceFailed CARRYING the per-chapter summaryMd when no story passes",
    () => {
      const { layer } = makeCFRuntimeTest({
        // Seed the secrets `loadSecrets({ required: true })` resolves + the
        // mandatory play model — the run dies before any story otherwise.
        config: {
          "product-demo.secret/CF_AI_GATEWAY_ID": "gw",
          "product-demo.secret/CLOUDFLARE_ACCOUNT_ID": "acct",
          "product-demo.secret/CLOUDFLARE_API_TOKEN": "tok",
          "product-demo.model.play": "claude-opus-4-7",
        },
        // The sentinel poll reads `DONE:1` on its first `cat` (the detached
        // play exited non-zero); the play's stdout stays empty, so the parse
        // fallback marks the story failed → passedCount === 0 → honest fail.
        sandboxProgram: { ".done": { exitCode: 0, stdout: "DONE:1" } },
      });

      return Effect.gen(function* () {
        const exit = yield* Effect.exit(
          productDemo.run({
            ...baseInput,
            stories: [{ name: "landing", prose: "Visit the homepage." }],
          } as Parameters<typeof productDemo.run>[0]),
        );

        expect(Exit.isFailure(exit)).toBe(true);
        const summaryMd = Exit.isFailure(exit)
          ? Option.match(Cause.failureOption(exit.cause), {
              onNone: () => undefined,
              onSome: (failure) =>
                Match.value(failure).pipe(
                  Match.tag("AcceptanceFailed", (e) => e.summaryMd),
                  Match.orElse(() => undefined),
                ),
            })
          : undefined;

        // The typed failure carries the SAME chapter table a green run
        // returns as output — the dispatcher embeds it in the red check-run.
        expect(summaryMd).toBeDefined();
        expect(summaryMd).toContain("0/1 chapters passed");
        expect(summaryMd).toContain("| landing |");
        expect(summaryMd).toContain("❌ fail");
      }).pipe(Effect.provide(layer));
    },
  );
});

describe("product-demo self-heal auto-dispatch (gated)", () => {
  // A play that returns a PARSEABLE failed verdict ⇒ failureKind "assertion".
  const assertionFailProgram = {
    ".done": { exitCode: 0, stdout: "DONE:0" },
    "play-0.out": {
      exitCode: 0,
      stdout: JSON.stringify({
        status: "failed",
        durationMs: 1,
        chapterStartMs: 0,
        chapterEndMs: 1,
        narrative: "the checkout button did nothing",
        keyScreenshotPath: "",
      }),
    },
  };
  const secrets = {
    "product-demo.secret/CF_AI_GATEWAY_ID": "gw",
    "product-demo.secret/CLOUDFLARE_ACCOUNT_ID": "acct",
    "product-demo.secret/CLOUDFLARE_API_TOKEN": "tok",
    "product-demo.model.play": "claude-opus-4-7",
  };
  const story = { name: "checkout", prose: "Buy an item." };

  it.effect("dispatches a demo-class self-heal-pr for a confirmed assertion failure", () => {
    const { layer, handles } = makeCFRuntimeTest({
      config: {
        ...secrets,
        "self-heal.demo.enabled": "true",
        "self-heal.demo.test-command": "pnpm test",
        // confirm-runs 1 ⇒ no re-play needed; the original failure alone meets
        // threshold (clamped to ≤ confirm-runs).
        "self-heal.demo.confirm-runs": "1",
      },
      sandboxProgram: assertionFailProgram,
    });
    return Effect.gen(function* () {
      // The run fails the honest check (0/1 passed) AFTER dispatching — assert
      // the spawn happened regardless of the terminal Exit.
      yield* Effect.exit(
        productDemo.run({ ...baseInput, stories: [story] } as Parameters<
          typeof productDemo.run
        >[0]),
      );
      expect(handles.childRuns.spawned).toHaveLength(1);
      const spawn = handles.childRuns.spawned[0]!;
      expect(spawn.run).toBe("self-heal-pr");
      expect(spawn.instanceId).toContain("self-heal:demo:");
      const incident = (spawn.input as { incident: { class: string; repo: string; repro?: { command?: string } } }).incident;
      expect(incident.class).toBe("demo");
      expect(incident.repro?.command).toBe("pnpm test");
    }).pipe(Effect.provide(layer));
  });

  it.effect("does NOT dispatch when self-heal.demo.enabled is unset", () => {
    const { layer, handles } = makeCFRuntimeTest({
      config: { ...secrets, "self-heal.demo.test-command": "pnpm test" },
      sandboxProgram: assertionFailProgram,
    });
    return Effect.gen(function* () {
      yield* Effect.exit(
        productDemo.run({ ...baseInput, stories: [story] } as Parameters<
          typeof productDemo.run
        >[0]),
      );
      expect(handles.childRuns.spawned).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("does NOT dispatch when no test-command is configured (can't verify)", () => {
    const { layer, handles } = makeCFRuntimeTest({
      config: { ...secrets, "self-heal.demo.enabled": "true", "self-heal.demo.confirm-runs": "1" },
      sandboxProgram: assertionFailProgram,
    });
    return Effect.gen(function* () {
      yield* Effect.exit(
        productDemo.run({ ...baseInput, stories: [story] } as Parameters<
          typeof productDemo.run
        >[0]),
      );
      expect(handles.childRuns.spawned).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });
});

describe("buildDemoBundleManifest (demo-bundle/v1)", () => {
  const fullChapter = {
    name: "checkout",
    status: "failed" as const,
    failureKind: "assertion" as const,
    durationMs: 1200,
    chapterStartMs: 0,
    chapterEndMs: 1200,
    narrative: "the checkout button did nothing",
    keyScreenshotUri: "/v1/artifacts/e/checkout.png",
    chapterGifUri: "/v1/artifacts/e/chapter-0.gif",
    replayJsonUri: "/v1/artifacts/e/replay-0.json",
  };
  const base = {
    repo: "owner/app",
    sha: "deadbeef",
    target: "https://staging.example.com",
    proseByName: new Map([["checkout", "Buy an item."]]),
    hasGif: true,
    hasFramesArchive: true,
  };

  it("maps chapters to RELATIVE artifact names (relocatable bundle)", () => {
    const manifest = buildDemoBundleManifest({
      ...base,
      chapters: [fullChapter],
    });
    expect(manifest.kind).toBe("demo-bundle/v1");
    expect(manifest.summary).toBe("summary.md");
    expect(manifest.gif).toBe("demo.gif");
    expect(manifest.framesArchive).toBe("frames.tar");
    expect(manifest.stories).toEqual([
      {
        name: "checkout",
        prose: "Buy an item.",
        status: "failed",
        failureKind: "assertion",
        narrative: "the checkout button did nothing",
        durationMs: 1200,
        chapterStartMs: 0,
        chapterEndMs: 1200,
        framesPrefix: "checkout-",
        keyScreenshot: "checkout.png",
        gif: "chapter-0.gif",
        replayJson: "replay-0.json",
      },
    ]);
  });

  it("omits every optional entry whose upload never landed", () => {
    const manifest = buildDemoBundleManifest({
      ...base,
      hasGif: false,
      hasFramesArchive: false,
      chapters: [
        {
          ...fullChapter,
          status: "passed" as const,
          failureKind: undefined,
          keyScreenshotUri: "",
          chapterGifUri: undefined,
          replayJsonUri: "",
        },
      ],
    });
    expect(manifest.gif).toBeUndefined();
    expect(manifest.framesArchive).toBeUndefined();
    const story = manifest.stories[0]!;
    expect(story.failureKind).toBeUndefined();
    expect(story.keyScreenshot).toBeUndefined();
    expect(story.gif).toBeUndefined();
    expect(story.replayJson).toBeUndefined();
    // The frames prefix is always present — it names files inside a FUTURE
    // frames archive, and the consumer already gates on `framesArchive`.
    expect(story.framesPrefix).toBe("checkout-");
  });

  it("indexes chapter GIF / replay names by POSITION, prose by NAME", () => {
    const manifest = buildDemoBundleManifest({
      ...base,
      proseByName: new Map([
        ["a", "First journey."],
        ["b", "Second journey."],
      ]),
      chapters: [
        { ...fullChapter, name: "a" },
        { ...fullChapter, name: "b" },
      ],
    });
    expect(manifest.stories[0]).toMatchObject({
      name: "a",
      prose: "First journey.",
      gif: "chapter-0.gif",
      replayJson: "replay-0.json",
    });
    expect(manifest.stories[1]).toMatchObject({
      name: "b",
      prose: "Second journey.",
      gif: "chapter-1.gif",
      replayJson: "replay-1.json",
    });
  });

  it("falls back to empty prose for a chapter missing from the story list", () => {
    const manifest = buildDemoBundleManifest({
      ...base,
      proseByName: new Map(),
      chapters: [fullChapter],
    });
    expect(manifest.stories[0]!.prose).toBe("");
  });
});

describe("product-demo bundle persistence (demo-bundle/v1)", () => {
  const secrets = {
    "product-demo.secret/CF_AI_GATEWAY_ID": "gw",
    "product-demo.secret/CLOUDFLARE_ACCOUNT_ID": "acct",
    "product-demo.secret/CLOUDFLARE_API_TOKEN": "tok",
    "product-demo.model.play": "claude-opus-4-7",
  };

  it.effect(
    "uploads manifest.json + frames.tar even when every chapter fails (red demo ships its bundle)",
    () => {
      const { layer, handles } = makeCFRuntimeTest({
        config: secrets,
        sandboxProgram: {
          // Every sentinel poll reads an exited play → the chapter fails.
          ".done": { exitCode: 0, stdout: "DONE:1" },
          // The archive-frames guard finds frames and tars them.
          "tar -cf": { exitCode: 0, stdout: "TAR_OK" },
        },
      });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(
          productDemo.run({
            repo: "owner/app",
            sha: "deadbeef",
            deployedUrl: "https://staging.example.com",
            stories: [{ name: "landing", prose: "Visit the homepage." }],
          } as Parameters<typeof productDemo.run>[0]),
        );
        // 0/1 chapters passed ⇒ the honest check fails the run …
        expect(Exit.isFailure(exit)).toBe(true);
        // … but the bundle artifacts were persisted BEFORE the verdict.
        const uploads = handles.artifact.uploads;
        const names = uploads.map((u) => u.name);
        expect(names).toContain("manifest.json");
        expect(names).toContain("frames.tar");
        expect(
          uploads.find((u) => u.name === "manifest.json")?.contentType,
        ).toBe("application/json");
        expect(uploads.find((u) => u.name === "frames.tar")?.contentType).toBe(
          "application/x-tar",
        );
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "dispatches the demo-reel child with the bundle URL when demo-reel.enabled=true",
    () => {
      const { layer, handles } = makeCFRuntimeTest({
        config: { ...secrets, "demo-reel.enabled": "true" },
        sandboxProgram: { ".done": { exitCode: 0, stdout: "DONE:1" } },
      });
      return Effect.gen(function* () {
        yield* Effect.exit(
          productDemo.run({
            repo: "owner/app",
            sha: "deadbeef",
            deployedUrl: "https://staging.example.com",
            pr: 7,
            stories: [{ name: "landing", prose: "Visit the homepage." }],
          } as Parameters<typeof productDemo.run>[0]),
        );
        const reelSpawns = handles.childRuns.spawned.filter(
          (s) => s.run === "demo-reel",
        );
        expect(reelSpawns).toHaveLength(1);
        const spawn = reelSpawns[0]!;
        expect(spawn.instanceId).toContain("demo-reel:");
        const reelInput = spawn.input as {
          repo: string;
          bundleUrl: string;
          pr?: number;
        };
        expect(reelInput.repo).toBe("owner/app");
        expect(reelInput.pr).toBe(7);
        // The bundle URL is the manifest upload's own artifact URL.
        expect(reelInput.bundleUrl).toBeTruthy();
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("skips frames.tar when no frames were captured (TAR_EMPTY)", () => {
    const { layer, handles } = makeCFRuntimeTest({
      config: secrets,
      // No "tar -cf" entry: the archive-frames exec falls through to the
      // fake's default (exit 0, empty stdout) — no TAR_OK sentinel.
      sandboxProgram: { ".done": { exitCode: 0, stdout: "DONE:1" } },
    });
    return Effect.gen(function* () {
      yield* Effect.exit(
        productDemo.run({
          repo: "owner/app",
          sha: "deadbeef",
          deployedUrl: "https://staging.example.com",
          stories: [{ name: "landing", prose: "Visit the homepage." }],
        } as Parameters<typeof productDemo.run>[0]),
      );
      const names = handles.artifact.uploads.map((u) => u.name);
      expect(names).not.toContain("frames.tar");
      // The manifest still ships — it simply omits `framesArchive`.
      expect(names).toContain("manifest.json");
    }).pipe(Effect.provide(layer));
  });
});

describe("product-demo launch-retry resilience", () => {
  const secrets = {
    "product-demo.secret/CF_AI_GATEWAY_ID": "gw",
    "product-demo.secret/CLOUDFLARE_ACCOUNT_ID": "acct",
    "product-demo.secret/CLOUDFLARE_API_TOKEN": "tok",
    "product-demo.model.play": "claude-opus-4-7",
  };
  // A play that returns a PASSED verdict — the chapter would clearly pass if its
  // detached launch ever got to run.
  const passProgram = {
    ".done": { exitCode: 0, stdout: "DONE:0" },
    "play-0.out": {
      exitCode: 0,
      stdout: JSON.stringify({
        status: "passed",
        durationMs: 1,
        chapterStartMs: 0,
        chapterEndMs: 1,
        narrative: "completed the journey",
        keyScreenshotPath: "",
      }),
    },
  };

  // `it.live` (real clock) because the launch-retry's exponential backoff sleeps
  // — a TestClock would freeze those `Effect.sleep`s. Two flaked launches add
  // ~3s of real backoff, which is acceptable for one regression test.
  it.live(
    "retries a transient ContainerLaunchFailed launch so the chapter still passes",
    () => {
      const { layer } = makeCFRuntimeTest({
        config: secrets,
        sandboxProgram: passProgram,
        // The `play-0` detached launch is rejected with ContainerLaunchFailed
        // twice before it sticks. Pre-fix (`play` step `retries: 0`, no launch
        // retry) the first flake propagated out of `runAgent`, recorded the
        // chapter as an exit -3 "infra" failure → 0/1 passed → the run failed
        // the honest check. With the launch-retry the third attempt succeeds.
        sandboxLaunchFailures: { "play-0": 2 },
      });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(
          productDemo.run({
            ...baseInput,
            stories: [{ name: "checkout", prose: "Buy an item." }],
          } as Parameters<typeof productDemo.run>[0]),
        );
        // 1/1 chapters passed ⇒ the run completes (does not fail the honest
        // check). Without the retry this Exit would be a failure.
        expect(Exit.isSuccess(exit)).toBe(true);
      }).pipe(Effect.provide(layer));
    },
  );
});
