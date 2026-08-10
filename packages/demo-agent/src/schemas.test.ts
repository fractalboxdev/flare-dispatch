// Pure schema tests — every JSON contract the `product-demo` run parses
// MUST round-trip through Schema.decode without loss. Locks the wire format
// so a careless refactor cannot drift the CLI from the run.

import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import {
  ModelAction,
  PlayOutput,
  RecordStopOutput,
  StoriesJson,
  VIEWPORTS,
} from "./schemas.js";

describe("RecordStopOutput", () => {
  it("decodes the shape the run parses from `record stop` stdout", () => {
    const decoded = Schema.decodeUnknownSync(RecordStopOutput)({
      sessionId: "sess-abc123",
      eventCount: 12345,
    });
    expect(decoded.sessionId).toBe("sess-abc123");
    expect(decoded.eventCount).toBe(12345);
  });

  it("rejects a missing sessionId", () => {
    expect(() =>
      Schema.decodeUnknownSync(RecordStopOutput)({ eventCount: 1 }),
    ).toThrow();
  });
});

describe("PlayOutput", () => {
  it("decodes the shape the run parses from `play` stdout", () => {
    const decoded = Schema.decodeUnknownSync(PlayOutput)({
      status: "passed",
      durationMs: 8123,
      chapterStartMs: 0,
      chapterEndMs: 8123,
      narrative: "Signed in and landed on the dashboard.",
      keyScreenshotPath: "/tmp/demo/screenshots/sign-in.png",
    });
    expect(decoded.status).toBe("passed");
    expect(decoded.narrative).toContain("Signed in");
  });

  it("rejects an unknown status value", () => {
    expect(() =>
      Schema.decodeUnknownSync(PlayOutput)({
        status: "errored",
        durationMs: 1,
        chapterStartMs: 0,
        chapterEndMs: 1,
        narrative: "",
        keyScreenshotPath: "",
      }),
    ).toThrow();
  });
});

describe("ModelAction", () => {
  it("accepts every action variant the model can emit", () => {
    const cases: unknown[] = [
      { type: "click", target: "button[name='Sign in']" },
      { type: "type", target: "input#email", text: "demo@example.com" },
      { type: "nav", url: "https://staging.example.com/login" },
      { type: "key", key: "Enter" },
      { type: "wait", ms: 500 },
      { type: "screenshot" },
      { type: "done", narrative: "Signed in.", status: "passed" },
    ];
    for (const c of cases) {
      expect(() => Schema.decodeUnknownSync(ModelAction)(c)).not.toThrow();
    }
  });

  it("rejects an unknown action type", () => {
    expect(() =>
      Schema.decodeUnknownSync(ModelAction)({ type: "scroll", target: "x" }),
    ).toThrow();
  });
});

describe("StoriesJson", () => {
  it("decodes a multi-story manifest", () => {
    const decoded = Schema.decodeUnknownSync(StoriesJson)({
      stories: [
        {
          name: "sign-in",
          status: "passed",
          durationMs: 7000,
          chapterStartMs: 0,
          chapterEndMs: 7000,
          narrative: "Signed in.",
          keyScreenshotUri: "https://r2.example/sign-in.png",
        },
      ],
      replayUri: "https://docs.example/replay/sess-abc",
      replayJsonUri: "https://r2.example/replay.json",
    });
    expect(decoded.stories).toHaveLength(1);
    expect(decoded.replayUri).toMatch(/^https:/);
  });
});

describe("VIEWPORTS", () => {
  it("maps desktop and mobile to distinct dims", () => {
    expect(VIEWPORTS.desktop.width).toBeGreaterThan(VIEWPORTS.mobile.width);
    expect(VIEWPORTS.mobile.mobile).toBe(true);
    expect(VIEWPORTS.desktop.mobile).toBe(false);
  });
});
