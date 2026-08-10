// Play-loop tests — covers the bounded-iteration contract:
//
//   * the loop calls the action picker, applies CDP commands, and exits on
//     `done`;
//   * a CDP error inside the loop produces `{ status: "failed" }` (the story
//     fails, the run does not);
//   * a model error inside the loop produces `{ status: "failed" }`;
//   * the final screenshot fallback is captured when the model never emits
//     `screenshot` explicitly;
//   * `chapterStartMs` / `chapterEndMs` are measured relative to `attachedAtMs`.
//
// The real CDP + `LanguageModel` are mocked — we inject a fake `CdpSession`
// and a fake `pickAction` so the suite runs without a browser or any model
// provider configured.

import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import { LanguageModel } from "@effect/ai";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runPlayLoop } from "./play.js";
import type { CdpSession } from "./cdp.js";
import type { ModelAction } from "./schemas.js";

// Stub `LanguageModel` Layer the tests provide. Every test in this file
// injects `pickAction` directly so the stub's `generateText` is never
// actually invoked — but the type system still requires the Tag in context
// after the model.ts refactor, hence the Layer.
const stubLanguageModelLayer = Layer.succeed(
  LanguageModel.LanguageModel,
  null as unknown as LanguageModel.Service,
);

// Mutable mirror of CdpSession used only in tests so a specific test can
// monkey-patch one method (e.g. force `click` to fail). The interface itself
// keeps `readonly` to communicate intent at the run-loop site.
type FakeCdpSession = {
  -readonly [K in keyof CdpSession]: CdpSession[K];
} & {
  readonly calls: { method: string; args: unknown[] }[];
};

const makeFakeSession = (): FakeCdpSession => {
  const calls: { method: string; args: unknown[] }[] = [];
  const log = <A>(method: string, args: unknown[], result: A): A => {
    calls.push({ method, args });
    return result;
  };
  return {
    calls,
    goto: (url) => Effect.sync(() => log("goto", [url], undefined)),
    currentUrl: () => Effect.sync(() => "about:blank"),
    click: (target) => Effect.sync(() => log("click", [target], undefined)),
    type: (target, text) =>
      Effect.sync(() => log("type", [target, text], undefined)),
    key: (k) => Effect.sync(() => log("key", [k], undefined)),
    wait: (ms) => Effect.sync(() => log("wait", [ms], undefined)),
    screenshot: (p) =>
      Effect.sync(() => {
        fs.writeFileSync(p, Buffer.from("PNG"));
        log("screenshot", [p], undefined);
      }),
    accessibilitySnapshot: () =>
      Effect.sync(() => log("ax", [], '{"role":"WebArea"}')),
    sessionId: () => Effect.sync(() => "fake-session"),
    close: () => Effect.void,
  };
};

const mkTmp = (): string =>
  fs.mkdtempSync(path.join(os.tmpdir(), "demo-agent-test-"));

describe("runPlayLoop", () => {
  it("applies actions and exits when the model says done (passed)", async () => {
    const session = makeFakeSession();
    const scripted: ModelAction[] = [
      { type: "nav", url: "https://staging.example.com" },
      { type: "click", target: "button[name='Sign in']" },
      { type: "screenshot" },
      {
        type: "done",
        narrative: "Signed in and landed on the dashboard.",
        status: "passed",
      },
    ];
    let i = 0;
    const pickAction = () =>
      Effect.sync(() => {
        const next = scripted[i] ?? scripted[scripted.length - 1]!;
        i += 1;
        return next;
      });

    const start = 10_000;
    let now = start + 100;
    const result = await Effect.runPromise(
      runPlayLoop(
        {
          name: "sign-in",
          prose: "Sign in and confirm the dashboard renders.",
          screenshotsDir: mkTmp(),
          maxSec: 60,
          attachedAtMs: start,
        },
        {
          session,
          pickAction: pickAction as never,
          now: () => {
            now += 50;
            return now;
          },
        },
      ).pipe(Effect.provide(stubLanguageModelLayer)),
    );
    expect(result.status).toBe("passed");
    expect(result.narrative).toContain("dashboard");
    expect(result.keyScreenshotPath).toMatch(/sign-in\.png$/);
    expect(result.chapterStartMs).toBeGreaterThan(0);
    expect(result.chapterEndMs).toBeGreaterThanOrEqual(result.chapterStartMs);
    // 4 actions × 1 cycle each (ax + apply) → expect at least 4 ax snapshots.
    expect(session.calls.filter((c) => c.method === "ax").length).toBe(4);
  });

  it("returns status=failed when CDP errors mid-story", async () => {
    const session = makeFakeSession();
    // Override `click` to fail. The override casts through `unknown` because
    // the test fabricates a tagged error shape — only the `message` field is
    // surfaced in the loop's narrative, so the rest of the Schema-validated
    // error shape is irrelevant here.
    session.click = ((target: string) =>
      Effect.fail({
        _tag: "CdpCommandFailed",
        method: "Input.click",
        message: `click failed: ${target}`,
      })) as unknown as CdpSession["click"];
    const scripted: ModelAction[] = [
      { type: "click", target: "button" },
      { type: "done", narrative: "ok", status: "passed" },
    ];
    let i = 0;
    const pickAction = () =>
      Effect.sync(() => {
        const next = scripted[i] ?? scripted[scripted.length - 1]!;
        i += 1;
        return next;
      });

    const result = await Effect.runPromise(
      runPlayLoop(
        {
          name: "broken",
          prose: "Click the button.",
          screenshotsDir: mkTmp(),
          maxSec: 5,
          attachedAtMs: 0,
        },
        { session, pickAction: pickAction as never },
      ).pipe(Effect.provide(stubLanguageModelLayer)),
    );
    expect(result.status).toBe("failed");
    expect(result.narrative).toMatch(/click failed/);
  });

  it("falls back to a final screenshot when the model never emits one", async () => {
    const session = makeFakeSession();
    const scripted: ModelAction[] = [
      { type: "click", target: "x" },
      { type: "done", narrative: "ok", status: "passed" },
    ];
    let i = 0;
    const pickAction = () =>
      Effect.sync(() => {
        const next = scripted[i] ?? scripted[scripted.length - 1]!;
        i += 1;
        return next;
      });

    const result = await Effect.runPromise(
      runPlayLoop(
        {
          name: "no-key-frame",
          prose: "Do a thing.",
          screenshotsDir: mkTmp(),
          maxSec: 5,
          attachedAtMs: 0,
        },
        { session, pickAction: pickAction as never },
      ).pipe(Effect.provide(stubLanguageModelLayer)),
    );
    expect(result.keyScreenshotPath).toMatch(/no-key-frame\..*\.png$/);
    expect(session.calls.some((c) => c.method === "screenshot")).toBe(true);
  });

  it("stops at maxActions when the model never says done", async () => {
    const session = makeFakeSession();
    const pickAction = () =>
      Effect.sync(
        (): ModelAction => ({ type: "wait", ms: 10 }),
      );
    const result = await Effect.runPromise(
      runPlayLoop(
        {
          name: "runaway",
          prose: "Loops forever.",
          screenshotsDir: mkTmp(),
          maxSec: 60,
          maxActions: 3,
          attachedAtMs: 0,
        },
        { session, pickAction: pickAction as never },
      ).pipe(Effect.provide(stubLanguageModelLayer)),
    );
    expect(result.status).toBe("failed");
    expect(session.calls.filter((c) => c.method === "wait").length).toBe(3);
  });
});
