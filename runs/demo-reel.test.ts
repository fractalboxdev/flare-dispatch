// Unit tests for the `demo-reel` run.
//
// The run is orchestration over canned container execs (fetch bundle → clone
// autopresenter → import → render), so the fake sandbox program drives every
// branch: the deck-only path (no ffmpeg in the image), the full video path,
// the fatal fetch failure, and the missing-JSON-tail tolerance. The real
// autopresenter CLI + ffmpeg pipeline is exercised end-to-end on the
// Dispatcher, not here.

import { it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { describe, expect } from "vitest";
import { makeCFRuntimeTest } from "@fractalbox/flare-dispatch-core/testing";
import { demoReel } from "./demo-reel";

const baseInput = {
  repo: "owner/app",
  sha: "deadbeef",
  bundleUrl: "/v1/artifacts/exec-1/manifest.json",
} as const;

const run = (input: Record<string, unknown>) =>
  demoReel.run(input as Parameters<typeof demoReel.run>[0]);

// The happy-path canned program: every stage prints its sentinel; `import
// demo` ends with the JSON tail the run parses (its CLI contract).
const happyProgram = {
  "echo BUNDLE_OK": { exitCode: 0, stdout: "fetched 4 files\nBUNDLE_OK" },
  "autopresenter.git": { exitCode: 0, stdout: "CLONE_OK" },
  "import demo": {
    exitCode: 0,
    stdout: 'imported 2 stories\n{"scenes": 2, "deck": "/tmp/reel/comp/deck.md"}',
  },
  "--target slides": { exitCode: 0, stdout: "deck written" },
  "--target video": { exitCode: 0, stdout: "video written" },
};

describe("demo-reel", () => {
  it.effect("renders + uploads the deck, skipping video on a lean image", () => {
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: {
        ...happyProgram,
        "command -v ffmpeg": { exitCode: 0, stdout: "TOOLS_MISSING" },
      },
    });
    return Effect.gen(function* () {
      const output = yield* run({ ...baseInput });
      expect(output.scenes).toBe(2);
      expect(output.deckUri).toBeTruthy();
      expect(output.videoUri).toBeUndefined();
      expect(output.videoSkipped).toContain("ffmpeg");
      const names = handles.artifact.uploads.map((u) => u.name);
      expect(names).toContain("demo-deck.html");
      expect(names).not.toContain("demo-reel.mp4");
    }).pipe(Effect.provide(layer));
  });

  it.effect("renders + uploads the MP4 reel when the image carries the tools", () => {
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: {
        ...happyProgram,
        "command -v ffmpeg": { exitCode: 0, stdout: "TOOLS_OK" },
      },
    });
    return Effect.gen(function* () {
      const output = yield* run({ ...baseInput });
      expect(output.videoUri).toBeTruthy();
      expect(output.videoSkipped).toBeUndefined();
      const uploads = handles.artifact.uploads;
      expect(uploads.map((u) => u.name)).toContain("demo-reel.mp4");
      expect(uploads.find((u) => u.name === "demo-reel.mp4")?.contentType).toBe(
        "video/mp4",
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails the run when the bundle fetch fails (nothing to render)", () => {
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: {
        ...happyProgram,
        // curl died: no BUNDLE_OK sentinel, non-zero exit.
        "echo BUNDLE_OK": { exitCode: 22, stdout: "", stderr: "curl: (22) 404" },
      },
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(run({ ...baseInput }));
      expect(Exit.isFailure(exit)).toBe(true);
      expect(handles.artifact.uploads).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("tolerates an import with no JSON tail (scenes unknown, deck still ships)", () => {
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: {
        ...happyProgram,
        "import demo": { exitCode: 0, stdout: "imported, no machine tail" },
        "command -v ffmpeg": { exitCode: 0, stdout: "TOOLS_MISSING" },
      },
    });
    return Effect.gen(function* () {
      const output = yield* run({ ...baseInput });
      expect(output.scenes).toBe(0);
      expect(output.deckUri).toBeTruthy();
      expect(handles.artifact.uploads.map((u) => u.name)).toContain(
        "demo-deck.html",
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("downgrades a failed video render to deck-only (best-effort)", () => {
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: {
        ...happyProgram,
        "command -v ffmpeg": { exitCode: 0, stdout: "TOOLS_OK" },
        "--target video": { exitCode: 1, stdout: "", stderr: "tts unreachable" },
      },
    });
    return Effect.gen(function* () {
      const output = yield* run({ ...baseInput });
      expect(output.deckUri).toBeTruthy();
      expect(output.videoUri).toBeUndefined();
      expect(output.videoSkipped).toBeTruthy();
      expect(handles.artifact.uploads.map((u) => u.name)).not.toContain(
        "demo-reel.mp4",
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("posts a PR comment linking the deck when `pr` is present", () => {
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: {
        ...happyProgram,
        "command -v ffmpeg": { exitCode: 0, stdout: "TOOLS_MISSING" },
      },
    });
    return Effect.gen(function* () {
      yield* run({ ...baseInput, pr: 42 });
      expect(handles.github.pullReviewCalls).toHaveLength(1);
      const review = handles.github.pullReviewCalls[0]!;
      expect(review.pr).toBe(42);
      expect(review.body).toContain("Demo reel");
      expect(review.body).toContain("Open the deck");
    }).pipe(Effect.provide(layer));
  });
});
