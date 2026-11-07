// The applier and the applier rate limit under mameko's `drainOnce` over the
// testkit's outbox store: what the coordinator does with each closed answer.
import { drainOnce } from "@fractalboxdev/mameko-coordinator";
import { newRow } from "@fractalboxdev/mameko-kernel";
import {
  AlarmPort,
  type ApplierRateLimit,
  type EffectApplier,
  type IntentRow,
  type StoredOutboxRow,
} from "@fractalboxdev/mameko-ports";
import { memoryOutboxStore } from "@fractalboxdev/mameko-testkit";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { CheckRunApplierLive, InstallationDirectory } from "./applier.ts";
import { GithubHttpError, GithubNetworkError } from "./client.ts";
import { fakeGithub, fakeLayers, row, type FakeGithub } from "./fake.test-support.ts";
import { githubApplicationLayer } from "./layer.ts";
import { ApplierRateLimitLive, installationQuotaLayer } from "./rate-limit.ts";

const NOW = 1_800_000_000_000;
const ref = { name: "flare-dispatch/check", head_sha: "abc123" };
const details = {
  class: "required",
  executor_kind: "cloudflare",
  placement_reason: "cloud entry won",
  queue_age_ms: 0,
  reserved_micro_usd: 0,
  settled_micro_usd: 0,
};

const stored = (
  id: string,
  intent: IntentRow,
  tier: StoredOutboxRow["tier"] = "effect",
): StoredOutboxRow => ({
  id,
  limitKey: "7",
  tier,
  priority: 0,
  classRank: 1,
  drawsReserve: true,
  intent,
  row: newRow({ effectClass: intent.effectClass, insertedAt: NOW }),
});

const pass = (
  application: Layer.Layer<EffectApplier | ApplierRateLimit>,
  outbox: ReturnType<typeof memoryOutboxStore>,
  now: number,
) =>
  Effect.runPromise(
    drainOnce({ now, token: (id) => `tok-${id}-${now}`, random: () => 0 }).pipe(
      Effect.provide(Layer.merge(outbox.layer, application)),
    ),
  );

const fakeApplication = (gh: FakeGithub) =>
  Layer.mergeAll(
    CheckRunApplierLive.pipe(Layer.provide(fakeLayers(gh))),
    ApplierRateLimitLive.pipe(Layer.provide(installationQuotaLayer())),
  );

const state = (outbox: ReturnType<typeof memoryOutboxStore>, id: string) =>
  outbox.rows.get(id)?.row;

describe("the applier under the drainer", () => {
  it("FD-GH-010 MAMEKO-OUT-018 a create GitHub made but answered 502 is found on the retry", async () => {
    const gh = fakeGithub();
    const outbox = memoryOutboxStore();
    await outbox.seed([stored("1", row("check.open", ref))]);
    gh.lostAnswers.push(
      new GithubHttpError({ status: 502, message: "bad gateway", rateLimited: false }),
    );
    const application = fakeApplication(gh);
    await pass(application, outbox, NOW);
    expect(state(outbox, "1")).toMatchObject({ state: "pending", attempts: 1 });
    await pass(application, outbox, NOW + 1);
    expect(state(outbox, "1")).toMatchObject({ state: "applied", externalRef: "1000" });
    expect(gh.runs).toHaveLength(1);
  });

  it("FD-GH-010 MAMEKO-OUT-022 MAMEKO-OUT-024 a lost acknowledgement is adopted by lookup", async () => {
    const gh = fakeGithub();
    const outbox = memoryOutboxStore();
    await outbox.seed([stored("1", row("check.open", ref))]);
    gh.lostAnswers.push(new GithubNetworkError({ sent: true, message: "reset" }));
    const application = fakeApplication(gh);
    await pass(application, outbox, NOW);
    expect(state(outbox, "1")?.state).toBe("ambiguous");
    await pass(application, outbox, NOW + 1);
    expect(state(outbox, "1")).toMatchObject({ state: "applied", externalRef: "1000" });
    expect(gh.calls.filter((c) => c === "create")).toHaveLength(1);
  });

  it("FD-GH-052 MAMEKO-OUT-042 the outcome row goes first; the later check.open adopts its check run", async () => {
    const gh = fakeGithub();
    const outbox = memoryOutboxStore();
    await outbox.seed([
      stored("1", row("check.open", ref)),
      stored("2", row("check.start", { ...ref, epoch: 1, executor_kind: "device", attempt: 1 })),
      stored(
        "3",
        row("check.conclude", { ...ref, verdict: { _tag: "success" }, attempt: 1, details }),
        "outcome",
      ),
    ]);
    await pass(fakeApplication(gh), outbox, NOW);
    expect(gh.runs).toMatchObject([{ status: "completed", conclusion: "success" }]);
    expect(state(outbox, "1")?.state).toBe("applied");
    expect(state(outbox, "2")?.state).toBe("refused");
    expect(state(outbox, "3")?.state).toBe("applied");
  });
});

describe("githubApplicationLayer", () => {
  const response = (body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status: 200, headers });
  const run = {
    id: 1000,
    name: ref.name,
    external_id: "exec-1",
    status: "queued",
    conclusion: null,
    output: { title: null, summary: null },
  };

  it("MAMEKO-OUT-040 headers the client observes stop the next permit; the waiting row stays pending", async () => {
    const calls: string[] = [];
    const application = githubApplicationLayer({
      fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
        calls.push(init?.method ?? "GET");
        return init?.method === "POST"
          ? response(run, {
              "x-ratelimit-limit": "100",
              "x-ratelimit-remaining": "0",
              "x-ratelimit-reset": String(NOW / 1000 + 3600),
            })
          : response({ check_runs: [] });
      }) as typeof globalThis.fetch,
      token: () => Effect.succeed("t"),
    }).pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(InstallationDirectory, { installationFor: () => Effect.succeed(7) }),
          Layer.succeed(AlarmPort, { deliver: () => Effect.void }),
        ),
      ),
    );
    const outbox = memoryOutboxStore();
    await outbox.seed([
      stored("1", row("check.open", ref)),
      stored("2", row("check.open", { ...ref, name: "flare-dispatch/other" })),
    ]);
    await pass(application, outbox, NOW);
    expect(state(outbox, "1")?.state).toBe("applied");
    expect(state(outbox, "2")).toMatchObject({ state: "pending", attempts: 0, sends: 0 });
    expect(calls.filter((c) => c === "POST")).toHaveLength(1);
  });
});
