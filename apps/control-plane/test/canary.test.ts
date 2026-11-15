// The synthetic webhook canary on the composed control plane (FD-OPS-039): the canary push's signed webhook through
// intake's route and mameko's admission, the `control` pool's run catalogue running the leased run with no Container
// the way host-cloudflare's `ControlPool` runs it, then the terminal write and the drain that conclude its check.
import { lookupRun } from "@fractalboxdev/flare-dispatch-catalog";
import { canaryRun, controlRuns } from "@fractalboxdev/flare-dispatch-catalog/control-runs";
import {
  ActuatorRateLimitLive,
  CheckRunApplierLive,
  installationQuotaLayer,
} from "@fractalboxdev/flare-dispatch-github";
import { fakeGithub, fakeGithubLayers } from "@fractalboxdev/flare-dispatch-github/testing";
import {
  d1IntakeStore,
  handleIntake,
  IntakeConfig,
  IntakeStore,
  signBody,
  submission,
  submit,
} from "@fractalboxdev/flare-dispatch-intake";
import { migratedD1 } from "@fractalboxdev/flare-dispatch-intake/testing";
import { buildProfile } from "@fractalboxdev/flare-dispatch-profile";
import {
  drainOnce,
  ExecutionSteps,
  type ExecutionPayload,
} from "@fractalboxdev/mameko-coordinator";
import { d1OutboxStore, d1PlacementStore } from "@fractalboxdev/mameko-host-cloudflare/d1";
import { PlacementStore } from "@fractalboxdev/mameko-ports";
import { d1ExecutionSteps } from "@fractalboxdev/mameko-host-cloudflare/d1-execution";
import { memoryLocalContent, runDefinitionDigest } from "@fractalboxdev/mameko-run";
import { catalogRun, runProgram } from "@fractalboxdev/mameko-runner/program";
import { Effect, Layer, Match, type Context } from "effect";
import * as WorkflowEngine from "effect/workflow/WorkflowEngine";
import { describe, expect, it } from "vitest";
import { isolateServices } from "../src/composition.ts";
import { executionConfig } from "../src/config.ts";
import { concludeFactsLayer } from "../src/github.ts";
import { requestLeaseFields } from "../src/lease.ts";
import { envOf, type TestD1 } from "./conclude.test-support.ts";

const SECRET = "canary-webhook-secret";
const FIXTURE = "acme/fixture";
const SHA = "c".repeat(40);
const CANARY_REF = "refs/heads/flare-dispatch-canary";
/** The fixture installation the App maps the fixture repository to. */
const INSTALLATIONS = { [FIXTURE]: 7 };

/** A deploy whose operator overlay names the fixture repository, with an `ExecutionEngine` that records each start. */
const deploy = async () => {
  const db = await migratedD1();
  const starts: ExecutionPayload[] = [];
  const execution = {
    idFromName: (name: string) => name,
    get: () => ({
      start: async (payload: ExecutionPayload) => void starts.push(payload),
      cancel: async () => {},
    }),
  };
  const env = Object.assign(envOf(db, { WEBHOOK_SECRET: SECRET, GITHUB_FIXTURE_REPO: FIXTURE }), {
    EXECUTION: execution,
  });
  const services = (await isolateServices(env)) as Context.Context<never>;
  return { db, env, starts, services };
};

/** A signed `push` delivery of `ref` on `repo` at `SHA`. */
const push = async (repo: string, ref: string, delivery: string) => {
  const body = new TextEncoder().encode(
    JSON.stringify({
      ref,
      after: SHA,
      repository: { full_name: repo },
      installation: { id: 7 },
      head_commit: { id: SHA },
    }),
  );
  return new Request("https://control-plane.example.com/v1/webhooks/github", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "push",
      "x-github-delivery": delivery,
      "x-hub-signature-256": await Effect.runPromise(signBody(SECRET, body)),
    },
    body,
  });
};

const deliver = async (d: Awaited<ReturnType<typeof deploy>>, request: Request) => {
  const r = await Effect.runPromise(
    handleIntake(request, "webhooks/github").pipe(
      Effect.provide(d.services),
    ) as Effect.Effect<Response | null>,
  );
  expect(r?.status).toBe(202);
  return ((await r!.json()) as { executions?: string[] }).executions ?? [];
};

const canaries = (db: TestD1) =>
  db.sqlite
    .prepare("select id, scope_id, run, class, ops_run from mameko_executions where run = 'canary'")
    .all();

/** Whether `executorId`'s claim of the queued execution wins its lease, as a pool or a device claims it. */
const claimedBy = (db: TestD1, executionId: string, executorId: string) =>
  Effect.runPromise(
    PlacementStore.use((p) =>
      Effect.gen(function* () {
        const placed = yield* p.get(executionId);
        const leased = yield* p.claim(executionId, {
          expectedEpoch: placed!.epoch,
          executorId,
          floor: 0,
        });
        return leased !== null;
      }),
    ).pipe(Effect.provide(d1PlacementStore(db))),
  );

/** The terminal write of `outcome`, as the `Execution` workflow's `applyOutbox` stage commits it. */
const terminalWrite = (db: TestD1, executionId: string) =>
  Effect.runPromise(
    ExecutionSteps.use((steps) =>
      steps.applyOutbox(executionId, { _tag: "Success", epoch: 1 }, null),
    ).pipe(
      Effect.provide(
        d1ExecutionSteps(db, {
          ...executionConfig(buildProfile("production")),
          meteredCost: () => Effect.succeed(0),
        }),
      ),
    ),
  );

/** One drain pass through the check-run applier. */
const drain = (
  db: TestD1,
  env: Awaited<ReturnType<typeof deploy>>["env"],
  gh: ReturnType<typeof fakeGithub>,
  now: number,
) =>
  Effect.runPromise(
    drainOnce({
      now,
      token: (id) => `tok-${id}-${now}`,
      random: () => 0,
      actuatorOf: { "check.open": "checkRun", "check.conclude": "checkRun" },
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          d1OutboxStore(db),
          CheckRunApplierLive.pipe(
            Layer.provide(
              Layer.merge(fakeGithubLayers(gh, INSTALLATIONS), concludeFactsLayer(env)),
            ),
          ),
          ActuatorRateLimitLive.pipe(
            Layer.provide(
              Layer.merge(installationQuotaLayer(), fakeGithubLayers(gh, INSTALLATIONS)),
            ),
          ),
        ),
      ),
    ),
  );

describe("the synthetic webhook canary", () => {
  it("[FD-OPS-039] the canary push admits one ops run of canary, class required; the control pool's catalogue runs it to success with no container, and its check concludes success", async () => {
    const d = await deploy();
    const [executionId, ...rest] = await deliver(d, await push(FIXTURE, CANARY_REF, "d-1"));
    expect(rest).toEqual([]);
    expect(canaries(d.db)).toEqual([
      { id: executionId, scope_id: FIXTURE, run: "canary", class: "required", ops_run: 1 },
    ]);
    // A redelivery answers the same execution.
    expect(await deliver(d, await push(FIXTURE, CANARY_REF, "d-1"))).toEqual([executionId]);
    expect(canaries(d.db)).toHaveLength(1);

    // The lease the control plane writes names the canary's run digest, which the control pool's catalogue holds.
    const record = await Effect.runPromise(
      IntakeStore.use((s) => s.get(executionId!)).pipe(Effect.provide(d1IntakeStore(d.db))),
    );
    const entry = Match.value(lookupRun("production", "canary")).pipe(
      Match.tag("Available", ({ entry }) => entry),
      Match.orElse(() => null),
    );
    expect(entry?.executors).toEqual(["control"]);
    const deadlineAt = Date.now() + 60_000;
    const lease = requestLeaseFields(entry, record!, {
      scope_id: FIXTURE,
      deadline_at: deadlineAt,
    });
    expect(lease.run_digest).toBe(await runDefinitionDigest(canaryRun.definition));
    const payload = {
      workflow_version: lease.workflow_version,
      execution_id: executionId!,
      run: "canary",
      run_digest: lease.run_digest,
      run_version: lease.run_version,
      scope_id: FIXTURE,
      request_context: lease.request_context,
      class: "required",
      epoch: 1,
      deadline_at: deadlineAt,
      attempt: 0,
      input: lease.inputs,
    };
    const run = await catalogRun(controlRuns, payload);
    expect(run?.spec.name).toBe("canary");
    // The control pool's object runs the program with `LocalContent` and `Intents` alone; the engine here holds its
    // journal in memory where the object holds it in its SQLite storage.
    const ended = await runProgram({
      run: run!,
      payload: payload as never,
      store: memoryLocalContent(),
      services: Layer.empty,
      engine: (programs) => programs.pipe(Layer.provideMerge(WorkflowEngine.layerMemory)),
    });
    expect(ended).toEqual({ result: { _tag: "success" }, intents: [] });

    // Admission pins the canary to the `control` pool as a run that requires no job sandbox, so a Container pool and a
    // device that serve `required` claim no lease of it, and the `control` pool does.
    expect(
      d.db.sqlite
        .prepare("select pinned_pool, sandbox from mameko_placements where execution_id = ?")
        .get(executionId!),
    ).toEqual({ pinned_pool: "control", sandbox: 0 });
    expect(await claimedBy(d.db, executionId!, "agent")).toBe(false);
    expect(await claimedBy(d.db, executionId!, "device-1")).toBe(false);
    expect(await claimedBy(d.db, executionId!, "control")).toBe(true);

    // Admission opened the check `flare-dispatch/canary` on the pushed commit.
    expect(
      d.db.sqlite
        .prepare("select kind, payload_json from mameko_outbox where execution_id = ?")
        .all(executionId!),
    ).toEqual([
      {
        kind: "check.open",
        payload_json: JSON.stringify({ name: "flare-dispatch/canary", head_sha: SHA }),
      },
    ]);
    await terminalWrite(d.db, executionId!);
    const gh = fakeGithub();
    await drain(d.db, d.env, gh, Date.now() + 1_000);
    expect(gh.runs).toMatchObject([
      {
        name: "flare-dispatch/canary",
        external_id: executionId,
        status: "completed",
        conclusion: "success",
      },
    ]);
  });

  it("[FD-OPS-039] the control pool claims no lease of a required run that requires a job sandbox, which a Container pool claims", async () => {
    const d = await deploy();
    const admitted = await Effect.runPromise(
      Effect.gen(function* () {
        const run = (yield* IntakeConfig).catalog("sandbox-image")!;
        return yield* submit(
          submission({
            run,
            trigger: "dispatch",
            repo: "acme/app",
            sha: SHA,
            ref: "refs/heads/main",
            inputs: { repo: "https://github.com/acme/app.git", sha: SHA, ref: "refs/heads/main" },
            forcedClass: "required",
          }),
        );
      }).pipe(Effect.provide(d.services)) as unknown as Effect.Effect<{ readonly executionId: string }>,
    );
    expect(
      d.db.sqlite
        .prepare(
          "select e.class, p.pinned_pool, p.sandbox from mameko_placements p join mameko_executions e on e.id = p.execution_id where p.execution_id = ?",
        )
        .get(admitted.executionId),
    ).toEqual({ class: "required", pinned_pool: null, sandbox: 1 });
    expect(await claimedBy(d.db, admitted.executionId, "control")).toBe(false);
    expect(await claimedBy(d.db, admitted.executionId, "agent")).toBe(true);
  });

  it("[FD-OPS-039] a push to another branch of the fixture repository, or to the canary branch of another repository, admits no canary", async () => {
    const d = await deploy();
    await deliver(d, await push(FIXTURE, "refs/heads/main", "d-2"));
    await deliver(d, await push("acme/app", CANARY_REF, "d-3"));
    expect(canaries(d.db)).toEqual([]);
    expect(d.starts).toEqual([]);
  });
});
