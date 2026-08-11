// Browser Rendering recording REST client tests — the live HTTP target is not
// reachable from `vitest` (Browser Rendering needs a real Browser session id),
// so we inject a `fetchImpl` to drive every branch deterministically.

import { describe, expect, it } from "vitest";
import { Effect, Exit } from "effect";
import { fetchRecording, configFromEnv } from "./recorder.js";

const baseConfig = {
  accountId: "acc-1",
  apiToken: "tok-1",
  apiBase: "https://api.test",
};

const stubFetch =
  (responder: (url: string) => Response): typeof fetch =>
  async (input) => {
    const url = typeof input === "string" ? input : input.toString();
    return responder(url);
  };

describe("fetchRecording", () => {
  it("returns the events array on 200", async () => {
    const fetchImpl = stubFetch(
      () =>
        new Response(
          JSON.stringify({
            success: true,
            result: { events: [{ type: 4 }, { type: 2 }] },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const events = await Effect.runPromise(
      fetchRecording("sess-abc", { ...baseConfig, fetchImpl }),
    );
    expect(events).toHaveLength(2);
  });

  it("accepts a bare `events` array as the body (mock-friendly)", async () => {
    const fetchImpl = stubFetch(
      () => new Response(JSON.stringify({ events: [{}, {}, {}] }), { status: 200 }),
    );
    const events = await Effect.runPromise(
      fetchRecording("sess-abc", { ...baseConfig, fetchImpl }),
    );
    expect(events).toHaveLength(3);
  });

  it("maps a 401 to RecordingFetchFailed { reason: 'auth-failed' }", async () => {
    const fetchImpl = stubFetch(
      () => new Response("nope", { status: 401 }),
    );
    const exit = await Effect.runPromiseExit(
      fetchRecording("sess-bad", { ...baseConfig, fetchImpl }),
    );
    const causeJson = Exit.match(exit, {
      onSuccess: () => "",
      onFailure: (c) => JSON.stringify(c),
    });
    expect(causeJson).toContain("auth-failed");
  });

  it("maps a malformed body to RecordingFetchFailed { reason: 'malformed' }", async () => {
    const fetchImpl = stubFetch(
      () => new Response("not json", { status: 200 }),
    );
    const exit = await Effect.runPromiseExit(
      fetchRecording("sess-x", { ...baseConfig, fetchImpl }),
    );
    const causeJson = Exit.match(exit, {
      onSuccess: () => "",
      onFailure: (c) => JSON.stringify(c),
    });
    expect(causeJson).toContain("malformed");
  });

  it("retries while the platform reports still-processing", async () => {
    let calls = 0;
    const fetchImpl = stubFetch(() => {
      calls += 1;
      if (calls < 3) return new Response("processing", { status: 425 });
      return new Response(
        JSON.stringify({ result: { events: [{}] } }),
        { status: 200 },
      );
    });
    const events = await Effect.runPromise(
      fetchRecording("sess-retry", { ...baseConfig, fetchImpl }),
    );
    expect(events).toHaveLength(1);
    expect(calls).toBe(3);
  });
});

describe("configFromEnv", () => {
  it("returns the config when both vars are set", async () => {
    const cfg = await Effect.runPromise(
      configFromEnv({
        CLOUDFLARE_ACCOUNT_ID: "acc-2",
        CLOUDFLARE_API_TOKEN: "tok-2",
      } as NodeJS.ProcessEnv),
    );
    expect(cfg.accountId).toBe("acc-2");
    expect(cfg.apiToken).toBe("tok-2");
  });

  it("fails with MissingEnv when CLOUDFLARE_ACCOUNT_ID is unset", async () => {
    const exit = await Effect.runPromiseExit(
      configFromEnv({
        CLOUDFLARE_API_TOKEN: "tok-2",
      } as NodeJS.ProcessEnv),
    );
    const causeJson = Exit.match(exit, {
      onSuccess: () => "",
      onFailure: (c) => JSON.stringify(c),
    });
    expect(causeJson).toContain("CLOUDFLARE_ACCOUNT_ID");
  });
});
