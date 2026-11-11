import {
  actionsClaims,
  makeHarness,
  ORIGIN,
  record,
  type Harness,
} from "@fractalboxdev/flare-dispatch-api/test-support";
import { apiError } from "@fractalboxdev/flare-dispatch-api/errors";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { checkSignals, inputsFrom, runAction, type ActionInputs, type OidcRequest } from "./run.ts";

let h: Harness;
let jwt: string;
beforeAll(async () => {
  h = await makeHarness();
  jwt = await h.actions.sign(actionsClaims("acme/widgets"));
});
beforeEach(() => {
  h.doubles.intake = () =>
    Effect.succeed({ _tag: "Admitted", executionId: "01JACT", class: "batch" });
});

const TOKEN_ENDPOINT = "https://token.actions.example/request?api-version=2";
const oidc: OidcRequest = { url: TOKEN_ENDPOINT, token: "runtime-request-token" };

const base: ActionInputs = {
  url: ORIGIN,
  audience: "https://dispatcher.example.com",
  run: "check",
  repository: "acme/widgets",
  sha: "a".repeat(40),
  inputs: "{}",
  class: undefined,
  signals: "",
  wait: false,
  waitTimeoutS: 3600,
};

interface Seen {
  readonly tokenRequests: URL[];
  readonly dispatches: Request[];
}

/** The token endpoint and the control plane behind one `fetch`; `dispatchStatus` answers the next dispatches. */
const fetchWith = (seen: Seen, dispatchStatus: number[] = []) =>
  (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin === new URL(TOKEN_ENDPOINT).origin) {
      seen.tokenRequests.push(url);
      expect(request.headers.get("authorization")).toBe("bearer runtime-request-token");
      return Response.json({ value: jwt });
    }
    if (url.pathname.startsWith("/v1/dispatch/")) {
      seen.dispatches.push(request.clone());
      const status = dispatchStatus.shift();
      if (status !== undefined)
        return Response.json(
          { error: status === 500 ? "internal" : "unavailable", message: "down", request_id: "r" },
          { status },
        );
    }
    return h.asFetch()(request);
  }) as typeof globalThis.fetch;

const fresh = (): Seen => ({ tokenRequests: [], dispatches: [] });

describe("dispatch action", () => {
  it("[FD-IFC-055]: the bearer token comes from the Actions token endpoint with the configured audience", async () => {
    const seen = fresh();
    await Effect.runPromise(runAction(base, oidc, fetchWith(seen)));
    expect(seen.tokenRequests[0]!.searchParams.get("audience")).toBe(
      "https://dispatcher.example.com",
    );
    expect(seen.dispatches[0]!.headers.get("authorization")).toBe(`Bearer ${jwt}`);
  });

  it("[FD-IFC-055]: the action reads no shared secret: its inputs name none, and no token endpoint fails the step", async () => {
    const keys = Object.keys(inputsFrom({}));
    expect(keys.some((k) => /secret|hmac|token/i.test(k))).toBe(false);
    const result = await Effect.runPromise(
      Effect.flip(runAction(base, { url: undefined, token: undefined }, fetchWith(fresh()))),
    );
    expect(result.code).toBe("oidc_unavailable");
  });

  it("[FD-IFC-056]: a dispatch carries no Idempotency-Key", async () => {
    const seen = fresh();
    await Effect.runPromise(runAction(base, oidc, fetchWith(seen)));
    expect(seen.dispatches[0]!.headers.has("idempotency-key")).toBe(false);
  });

  it("[FD-IFC-057]: a 5xx is retried up to 3 attempts with a backoff of attempt × 5 s", async () => {
    const seen = fresh();
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(runAction(base, oidc, fetchWith(seen, [503, 500])));
        yield* TestClock.adjust("4999 millis");
        expect(seen.dispatches).toHaveLength(1);
        yield* TestClock.adjust("1 millis");
        yield* TestClock.adjust("9999 millis");
        expect(seen.dispatches).toHaveLength(2);
        yield* TestClock.adjust("1 millis");
        return yield* Fiber.join(fiber);
      }).pipe(Effect.provide(TestClock.layer())),
    );
    expect(seen.dispatches).toHaveLength(3);
    expect(result.outputs["execution-id"]).toBe("01JACT");
  });

  it("[FD-IFC-057]: three 5xx answers fail the step", async () => {
    const seen = fresh();
    const failure = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          Effect.flip(runAction(base, oidc, fetchWith(seen, [500, 500, 500]))),
        );
        yield* TestClock.adjust("15 seconds");
        return yield* Fiber.join(fiber);
      }).pipe(Effect.provide(TestClock.layer())),
    );
    expect(seen.dispatches).toHaveLength(3);
    expect(failure.code).toBe("internal");
  });

  it("[FD-IFC-058]: any 4xx fails the step at once with the error code", async () => {
    const seen = fresh();
    h.doubles.intake = () => Effect.fail(apiError("installation_not_found", "no installation"));
    const failure = await Effect.runPromise(Effect.flip(runAction(base, oidc, fetchWith(seen))));
    expect(failure.code).toBe("installation_not_found");
    expect(seen.dispatches).toHaveLength(1);
  });

  it("[FD-IFC-060]: the action outputs execution-id, details-url and logs-url", async () => {
    const { outputs } = await Effect.runPromise(runAction(base, oidc, fetchWith(fresh())));
    expect(Object.keys(outputs).sort()).toEqual(["details-url", "execution-id", "logs-url"]);
    expect(outputs["details-url"]).toContain("/executions/01JACT");
  });

  it("[FD-IFC-059], [FD-IFC-060]: with wait, the step polls to the verdict, outputs it and fails unless success", async () => {
    h.doubles.executions.set(
      "01JACT",
      record({ execution_id: "01JACT", verdict: "success", conclusion: "success" }),
    );
    const ok = await Effect.runPromise(
      runAction({ ...base, wait: true }, oidc, fetchWith(fresh())),
    );
    expect(ok.outputs["verdict"]).toBe("success");
    h.doubles.executions.set("01JACT", record({ execution_id: "01JACT", verdict: "failure" }));
    const failed = await Effect.runPromise(
      Effect.flip(runAction({ ...base, wait: true }, oidc, fetchWith(fresh()))),
    );
    expect(failed.code).toBe("failure");
    expect(failed.outputs?.["verdict"]).toBe("failure");
    expect(failed.outputs?.["execution-id"]).toBe("01JACT");
  });

  it("[FD-IFC-059]: the wait ends at wait-timeout", async () => {
    h.doubles.executions.set(
      "01JACT",
      record({ execution_id: "01JACT", status: "running", verdict: null }),
    );
    const failed = await Effect.runPromise(
      Effect.flip(runAction({ ...base, wait: true, waitTimeoutS: 1 }, oidc, fetchWith(fresh()))),
    );
    expect(failed.code).toBe("wait_ended");
  });

  it("[FD-IFC-061]: signals over the signals/v1 caps fail the step naming the field before anything is sent", async () => {
    const seen = fresh();
    const signals = JSON.stringify([{ source: "s", title: "t".repeat(201), detail: "d" }]);
    const failure = await Effect.runPromise(
      Effect.flip(runAction({ ...base, signals }, oidc, fetchWith(seen))),
    );
    expect(failure.code).toBe("invalid_signals");
    expect(failure.message).toContain("signals.0.title");
    expect(seen.tokenRequests).toHaveLength(0);
    expect(seen.dispatches).toHaveLength(0);
    const ok = await Effect.runPromise(
      checkSignals(JSON.stringify([{ source: "s", title: "t", detail: "d" }])),
    );
    expect(ok).toHaveLength(1);
  });

  it("[FD-IFC-002]: the action's requests go through the client derived from the declaration", async () => {
    const seen = fresh();
    await Effect.runPromise(runAction({ ...base, class: "batch" }, oidc, fetchWith(seen)));
    const body = (await seen.dispatches[0]!.json()) as Record<string, unknown>;
    expect(body).toEqual({
      repository: "acme/widgets",
      sha: "a".repeat(40),
      inputs: {},
      class: "batch",
    });
  });
});
