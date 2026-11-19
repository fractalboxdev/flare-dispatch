import { Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";
import {
  AssetFailed,
  AwsAssumeRoleFailed,
  AwsBuilds,
  AwsCallFailed,
  BuildLedger,
  Pause,
  ReleaseAssets,
  StackApprovals,
  type ApprovalDecision,
  type AwsTarget,
  type BuildState,
  type ServiceRollout,
  type StartBuildRequest,
} from "./aws.ts";
import { POLL_INTERVAL_MS, STOP_BEFORE_DEADLINE_MS } from "./aws-build.ts";
import { SmokeHttp } from "./deploy-smoke.ts";
import type { DispatchEvent } from "./dispatch-event.ts";
import { ExecutionLease } from "./execution-lease.ts";
import { fakeGithub, fakeIntents, OTHER_SHA, SHA } from "./gate.test-support.ts";
import { IMAGE_DIGESTS_VARIABLE, imageDigestsOf, runImagePublish } from "./image-publish.ts";
import type { ImagePublishInput, StackDeployInput } from "./inputs.ts";
import { lookupRun } from "./spec.ts";
import { rolloutState, runStackDeploy } from "./stack-deploy.ts";
import {
  imagePublishDecoder,
  stackDeployDecoder,
  stackDeployInputOf,
  stackDeploySerialGroup,
} from "./triggers.ts";

const DIGEST = `sha256:${"c".repeat(64)}`;
const REGISTRY = "111122223333.dkr.ecr.us-east-1.amazonaws.com/app";
const IMAGES = { api: `${REGISTRY}/api@${DIGEST}` };
const ASSET_SHA = "d".repeat(64);

const publishInput = (over: Partial<ImagePublishInput["entry"]> = {}): ImagePublishInput => ({
  scope: "o/r",
  sha: SHA,
  ref: "refs/heads/main",
  entry: {
    region: "us-east-1",
    roleArn: "arn:aws:iam::111122223333:role/fd-image-publish",
    project: "app-images",
    registries: [REGISTRY],
    ...over,
  },
});

const stackInput = (over: Partial<StackDeployInput["entry"]> = {}): StackDeployInput => ({
  scope: "o/r",
  sha: SHA,
  ref: "refs/heads/main",
  stack: "production",
  branch: "main",
  entry: {
    region: "us-east-1",
    roleArn: "arn:aws:iam::111122223333:role/fd-stack-production",
    project: "app-deploy-production",
    ...over,
  },
  images: IMAGES,
});

const build = (status: BuildState["status"], over: Partial<BuildState> = {}): BuildState => ({
  id: "app:1",
  status,
  phases: [
    { type: "INSTALL", status: "SUCCEEDED", durationSec: 3 },
    ...(status === "FAILED" ? [{ type: "BUILD", status: "FAILED", durationSec: 9 }] : []),
  ],
  logs: { group: "/aws/codebuild/app", stream: "1" },
  exported: { [IMAGE_DIGESTS_VARIABLE]: JSON.stringify(IMAGES) },
  ...over,
});

type Answer<A> = A | AwsCallFailed | AwsAssumeRoleFailed;
const answer = <A>(a: Answer<A>) =>
  a instanceof AwsCallFailed || a instanceof AwsAssumeRoleFailed
    ? Effect.fail(a)
    : Effect.succeed(a);

/** Scripted CodeBuild and ECS: each `get` and `services` call takes the next answer, the last one repeating. */
const fakeAws = (script: {
  start?: readonly Answer<string>[];
  get?: readonly Answer<BuildState>[];
  services?: readonly Answer<readonly ServiceRollout[]>[];
}) => {
  const calls: string[] = [];
  const starts: { target: AwsTarget; request: StartBuildRequest }[] = [];
  const next = <A>(list: readonly A[] | undefined, i: number, fallback: A) =>
    list === undefined || list.length === 0 ? fallback : list[Math.min(i, list.length - 1)]!;
  let s = 0;
  let g = 0;
  let v = 0;
  const layer = Layer.succeed(AwsBuilds, {
    start: (target, request) =>
      Effect.suspend(() => {
        calls.push("start");
        starts.push({ target, request });
        return answer(next(script.start, s++, "app:1"));
      }),
    get: () =>
      Effect.suspend(() => {
        calls.push("get");
        return answer(next(script.get, g++, build("SUCCEEDED")));
      }),
    stop: () => Effect.sync(() => void calls.push("stop")),
    services: () =>
      Effect.suspend(() => {
        calls.push("services");
        return answer(next(script.services, v++, [] as readonly ServiceRollout[]));
      }),
  });
  return { layer, calls, starts };
};

const memoryBuildLedger = (initial: Record<string, string> = {}) => {
  const rows = new Map(Object.entries(initial));
  return {
    rows,
    layer: Layer.succeed(BuildLedger, {
      recorded: (target) => Effect.sync(() => rows.get(target)),
      record: (target, id) => Effect.sync(() => void (rows.has(target) || rows.set(target, id))),
    }),
  };
};

const fakeApprovals = (decisions: readonly (ApprovalDecision | undefined)[]) => {
  const requests: string[] = [];
  let i = 0;
  return {
    requests,
    layer: Layer.succeed(StackApprovals, {
      request: (stack, sha) => Effect.sync(() => void requests.push(`${stack}@${sha}`)),
      decision: () => Effect.sync(() => decisions[Math.min(i++, decisions.length - 1)]),
    }),
  };
};

const fakeAssets = (fail?: AssetFailed["kind"]) =>
  Layer.succeed(ReleaseAssets, {
    stage: (asset) =>
      fail === undefined
        ? Effect.succeed({ url: `https://r2.example/cas/${asset.sha256}`, sha256: asset.sha256 })
        : Effect.fail(new AssetFailed({ key: asset.key, kind: fail })),
  });

const recordingPause = () => {
  const sleeps: string[] = [];
  return {
    sleeps,
    layer: Layer.succeed(Pause, { sleep: (name) => Effect.sync(() => void sleeps.push(name)) }),
  };
};

const lease = (deadlineAt?: number) =>
  Layer.succeed(ExecutionLease, {
    executionId: "01JEXECUTION",
    epoch: 1,
    run: "image-publish",
    input: {},
    scopeId: "o/r",
    ...(deadlineAt === undefined ? {} : { deadlineAt }),
  });

const okHttp = (status = 200) => {
  const requested: string[] = [];
  return {
    requested,
    layer: Layer.succeed(SmokeHttp, {
      fetch: async (url) => (requested.push(url), new Response(null, { status })),
    }),
  };
};

const publish = (
  input: ImagePublishInput,
  options: {
    aws?: ReturnType<typeof fakeAws>;
    ledger?: ReturnType<typeof memoryBuildLedger>;
    assets?: AssetFailed["kind"];
    deadlineAt?: number;
  } = {},
) => {
  const aws = options.aws ?? fakeAws({});
  const intents = fakeIntents();
  const pause = recordingPause();
  const ledger = options.ledger ?? memoryBuildLedger();
  return Effect.runPromise(
    runImagePublish(input).pipe(
      Effect.provide(
        Layer.mergeAll(
          aws.layer,
          ledger.layer,
          fakeAssets(options.assets),
          intents.layer,
          pause.layer,
          lease(options.deadlineAt),
        ),
      ),
    ),
  ).then((outcome) => ({ outcome, aws, intents, pause, ledger }));
};

const deployStack = (
  input: StackDeployInput,
  options: {
    aws?: ReturnType<typeof fakeAws>;
    approvals?: ReturnType<typeof fakeApprovals>;
    head?: string;
    http?: ReturnType<typeof okHttp>;
  } = {},
) => {
  const aws = options.aws ?? fakeAws({});
  const intents = fakeIntents();
  const pause = recordingPause();
  const approvals = options.approvals ?? fakeApprovals([undefined]);
  const http = options.http ?? okHttp();
  return Effect.runPromise(
    runStackDeploy(input).pipe(
      Effect.provide(
        Layer.mergeAll(
          aws.layer,
          memoryBuildLedger().layer,
          approvals.layer,
          intents.layer,
          pause.layer,
          lease(),
          http.layer,
          fakeGithub(options.head === undefined ? {} : { head: options.head }).layer,
        ),
      ),
    ),
  ).then((outcome) => ({ outcome, aws, intents, pause, approvals, http }));
};

const transient = (operation: string) =>
  new AwsCallFailed({ service: "codebuild", operation, transient: true, code: "HTTP503" });

describe("AWS builds", () => {
  it("[FD-GATE-116] runs image-publish and stack-deploy in the control pool with a container rate of 0", () => {
    for (const name of ["image-publish", "stack-deploy"]) {
      const found = lookupRun("production", name);
      if (found._tag !== "Available") throw new Error(name);
      expect(found.entry.executors).toEqual(["control"]);
      expect(found.entry.containerRateUsdPerHour).toBe(0);
      expect(found.entry.spec.constraints).toContain("control-pool");
      expect(found.entry.spec.requires).not.toContain("Exec");
    }
  });

  it("[FD-GATE-117] names the target the audience pins: image-publish, image-publish:<label> or stack:<stack>", async () => {
    const plain = await publish(publishInput());
    expect(plain.aws.starts[0]!.target).toEqual({
      region: "us-east-1",
      roleArn: "arn:aws:iam::111122223333:role/fd-image-publish",
      target: "image-publish",
    });
    const labelled = await publish(publishInput({ label: "arm" }));
    expect(labelled.aws.starts[0]!.target.target).toBe("image-publish:arm");
    const stack = await deployStack(stackInput());
    expect(stack.aws.starts[0]!.target.target).toBe("stack:production");
  });

  it("[FD-GATE-118] [FD-GATE-120] starts the build on the commit with FD_* overrides and no credential", async () => {
    const { aws } = await publish(publishInput());
    const request = aws.starts[0]!.request;
    expect(request.project).toBe("app-images");
    expect(request.sourceVersion).toBe(SHA);
    expect(request.env).toEqual({
      FD_REPO: "o/r",
      FD_SHA: SHA,
      FD_REF: "refs/heads/main",
      FD_EXECUTION_ID: "01JEXECUTION",
    });
    expect(JSON.stringify(Object.values(request.env))).not.toMatch(
      /token|secret|password|AKIA|ASIA/i,
    );
  });

  it("[FD-GATE-119] records aws: assume-role <code> and starts no build when STS refuses", async () => {
    const aws = fakeAws({ start: [new AwsAssumeRoleFailed({ code: "InvalidIdentityToken" })] });
    const { outcome } = await publish(publishInput(), { aws });
    expect(outcome).toEqual({ _tag: "failure", reason: "aws: assume-role InvalidIdentityToken" });
    expect(aws.calls).toEqual(["start"]);
  });

  it("[FD-GATE-121] polls the recorded build on a later epoch and never starts a second one", async () => {
    const ledger = memoryBuildLedger({ "image-publish": "app:7" });
    const { aws } = await publish(publishInput(), { ledger });
    expect(aws.calls).not.toContain("start");
    expect(aws.calls).toContain("get");
    const fresh = memoryBuildLedger();
    await publish(publishInput(), { ledger: fresh });
    expect(fresh.rows.get("image-publish")).toBe("app:1");
  });

  it("[FD-GATE-122] reads the status every 30 s with a durable sleep between reads", async () => {
    const aws = fakeAws({ get: [build("IN_PROGRESS"), build("IN_PROGRESS"), build("SUCCEEDED")] });
    const { pause, outcome } = await publish(publishInput(), { aws });
    expect(outcome).toEqual({ _tag: "success" });
    expect(aws.calls.filter((c) => c === "get")).toHaveLength(3);
    expect(pause.sleeps).toEqual(["image-publish:poll-0", "image-publish:poll-1"]);
    expect(POLL_INTERVAL_MS).toBe(30_000);
  });

  it("[FD-GATE-123] maps each build status to its verdict", async () => {
    const cases: [BuildState, unknown][] = [
      [build("FAILED"), { _tag: "failure", reason: "build: BUILD failed" }],
      [build("TIMED_OUT"), { _tag: "failure", reason: "timeout: build" }],
      [build("FAULT"), { _tag: "failure", reason: "infra: build fault" }],
      [build("STOPPED"), { _tag: "failure", reason: "build: stopped" }],
    ];
    for (const [state, expected] of cases) {
      const { outcome } = await publish(publishInput(), { aws: fakeAws({ get: [state] }) });
      expect(outcome).toEqual(expected);
    }
  });

  it("[FD-GATE-124] stops a build still running 60 s before deadline_at and records deadline", async () => {
    const aws = fakeAws({ get: [build("IN_PROGRESS")] });
    const { outcome } = await publish(publishInput(), {
      aws,
      deadlineAt: Date.now() + STOP_BEFORE_DEADLINE_MS - 1,
    });
    expect(outcome).toEqual({ _tag: "failure", reason: "deadline" });
    expect(aws.calls).toEqual(["start", "get", "stop"]);
  });

  it("[FD-GATE-125] retries a transient failure twice, then records infra; a 4xx records its code at once", async () => {
    const flaky = fakeAws({
      get: [transient("BatchGetBuilds"), transient("BatchGetBuilds"), build("SUCCEEDED")],
    });
    expect((await publish(publishInput(), { aws: flaky })).outcome).toEqual({ _tag: "success" });
    const down = fakeAws({ get: [transient("BatchGetBuilds")] });
    expect((await publish(publishInput(), { aws: down })).outcome).toEqual({
      _tag: "failure",
      reason: "infra: aws codebuild BatchGetBuilds",
    });
    expect(down.calls.filter((c) => c === "get")).toHaveLength(3);
    const denied = fakeAws({
      start: [
        new AwsCallFailed({
          service: "codebuild",
          operation: "StartBuild",
          transient: false,
          code: "AccessDeniedException",
        }),
      ],
    });
    expect((await publish(publishInput(), { aws: denied })).outcome).toEqual({
      _tag: "failure",
      reason: "aws: codebuild StartBuild AccessDeniedException",
    });
    expect(denied.calls).toEqual(["start"]);
  });

  it("[FD-GATE-126] summarizes the build id, phases and log location, and no log line", async () => {
    const { intents } = await publish(publishInput());
    const summary = intents.emitted.find((i) => i.kind === "check.summary")!;
    const markdown = (summary.payload as { markdown: string }).markdown;
    expect(markdown).toContain("app:1");
    expect(markdown).toContain("| INSTALL | SUCCEEDED | 3 |");
    expect(markdown).toContain("/aws/codebuild/app");
    expect((summary.payload as { name: string }).name).toBe("flare-dispatch/image-publish");
  });

  it("[FD-GATE-127] answers config: <field> for a bad region, role or project and calls no AWS API", async () => {
    for (const [over, field] of [
      [{ region: "moon" }, "region"],
      [{ roleArn: "arn:aws:iam::1:user/x" }, "roleArn"],
      [{ project: " " }, "project"],
    ] as const) {
      const { outcome, aws } = await publish(publishInput(over));
      expect(outcome).toEqual({ _tag: "failure", reason: `config: ${field}` });
      expect(aws.calls).toEqual([]);
    }
  });
});

describe("image-publish", () => {
  const push = (paths: readonly string[], ref = "refs/heads/main"): DispatchEvent =>
    ({
      _tag: "webhook",
      deliveryId: "d1",
      delivery: {
        event: "push",
        ref,
        after: SHA,
        changedPaths: paths,
        repository: {
          fullName: "o/r",
          cloneUrl: "https://github.com/o/r.git",
          defaultBranch: "main",
        },
      },
    }) as unknown as DispatchEvent;

  it("[FD-GATE-128] requests a publish on a push to the branch that changes a matching path, or a dispatch", () => {
    const entry = publishInput({ paths: ["images/**"] }).entry;
    const decode = imagePublishDecoder(entry);
    expect(Option.getOrUndefined(decode(push(["images/api/Dockerfile"])))).toEqual({
      scope: "o/r",
      sha: SHA,
      ref: "refs/heads/main",
      entry,
    });
    expect(Option.isNone(decode(push(["README.md"])))).toBe(true);
    expect(Option.isNone(decode(push(["images/x"], "refs/heads/feature")))).toBe(true);
    const dispatched = decode({
      _tag: "dispatch",
      run: "image-publish",
      repo: "o/r",
      ref: "refs/heads/main",
      sha: OTHER_SHA,
      inputs: { entry: { roleArn: "arn:aws:iam::999999999999:role/other" } },
      caller: "x",
    });
    // A dispatch's inputs supply nothing: the entry is the manifest's.
    expect(Option.getOrUndefined(dispatched)?.entry).toBe(entry);
  });

  it("[FD-GATE-129] passes each staged asset to the build as FD_ASSET_<key>_URL and FD_ASSET_<key>_SHA256", async () => {
    const asset = { key: "TOOL", repo: "o/tool", tag: "v1", name: "tool.tgz", sha256: ASSET_SHA };
    const { aws } = await publish(publishInput({ assets: [asset] }));
    expect(aws.starts[0]!.request.env).toMatchObject({
      FD_ASSET_TOOL_URL: `https://r2.example/cas/${ASSET_SHA}`,
      FD_ASSET_TOOL_SHA256: ASSET_SHA,
    });
  });

  it("[FD-GATE-130] records asset: <key> <kind> and starts no build when an asset cannot be staged", async () => {
    const asset = { key: "TOOL", repo: "o/tool", tag: "v1", name: "tool.tgz", sha256: ASSET_SHA };
    for (const kind of ["uninstalled", "not found", "too large", "digest mismatch"] as const) {
      const { outcome, aws } = await publish(publishInput({ assets: [asset] }), { assets: kind });
      expect(outcome).toEqual({ _tag: "failure", reason: `asset: TOOL ${kind}` });
      expect(aws.calls).toEqual([]);
    }
  });

  it("[FD-GATE-131] reads FD_IMAGE_DIGESTS and refuses an absent, empty or out-of-registry value", async () => {
    expect(
      imageDigestsOf({ [IMAGE_DIGESTS_VARIABLE]: JSON.stringify(IMAGES) }, [REGISTRY]),
    ).toEqual(IMAGES);
    expect(imageDigestsOf({}, [REGISTRY])).toBeUndefined();
    expect(imageDigestsOf({ [IMAGE_DIGESTS_VARIABLE]: "{}" }, [REGISTRY])).toBeUndefined();
    expect(
      imageDigestsOf(
        { [IMAGE_DIGESTS_VARIABLE]: JSON.stringify({ api: `${REGISTRY}/api:latest` }) },
        [REGISTRY],
      ),
    ).toBeUndefined();
    expect(
      imageDigestsOf(
        { [IMAGE_DIGESTS_VARIABLE]: JSON.stringify({ api: `evil.example/api@${DIGEST}` }) },
        [REGISTRY],
      ),
    ).toBeUndefined();
    const { outcome } = await publish(publishInput(), {
      aws: fakeAws({ get: [build("SUCCEEDED", { exported: {} })] }),
    });
    expect(outcome).toEqual({ _tag: "failure", reason: "image: digests" });
  });

  it("[FD-GATE-132] starts each stack in imagePublish.stacks with the digests, and none after a failure", async () => {
    const { intents } = await publish(publishInput({ stacks: ["staging", "production"] }));
    expect(intents.emitted.filter((i) => i.kind === "dispatch.followOn")).toEqual([
      {
        kind: "dispatch.followOn",
        key: "stack-deploy:staging:0",
        payload: { run: "stack-deploy", label: "staging", inputs: { images: IMAGES } },
      },
      {
        kind: "dispatch.followOn",
        key: "stack-deploy:production:0",
        payload: { run: "stack-deploy", label: "production", inputs: { images: IMAGES } },
      },
    ]);
    const failed = await publish(publishInput({ stacks: ["staging"] }), {
      aws: fakeAws({ get: [build("FAILED")] }),
    });
    expect(failed.intents.emitted.filter((i) => i.kind === "dispatch.followOn")).toEqual([]);
  });
});

describe("stack-deploy", () => {
  it("[FD-GATE-133] takes the entry from the manifest and only the images from the request", () => {
    const entry = stackInput().entry;
    const ctxOf = { scope: "o/r", sha: SHA, ref: "refs/heads/main" };
    expect(
      Option.getOrUndefined(stackDeployInputOf(entry, "production", ctxOf, { images: IMAGES })),
    ).toEqual(stackInput());
    expect(
      Option.isNone(
        stackDeployInputOf(entry, "production", ctxOf, {
          images: { api: `${REGISTRY}/api:latest` },
        }),
      ),
    ).toBe(true);
    const decoded = stackDeployDecoder(
      entry,
      "production",
    )({
      _tag: "dispatch",
      run: "stack-deploy",
      repo: "o/r",
      ref: "refs/heads/main",
      sha: SHA,
      inputs: { images: IMAGES, entry: { approval: "none" } },
      caller: "x",
    });
    expect(Option.getOrUndefined(decoded)?.entry).toBe(entry);
    expect(
      Option.isNone(
        stackDeployDecoder(
          entry,
          null,
        )({
          _tag: "dispatch",
          run: "stack-deploy",
          repo: "o/r",
          ref: "refs/heads/main",
          sha: SHA,
          inputs: { images: IMAGES },
          caller: "x",
        }),
      ),
    ).toBe(true);
  });

  it("[FD-GATE-134] serializes one repository and stack", () => {
    expect(stackDeploySerialGroup("o/r", "production")).toBe("stack-deploy:o/r@production");
    const found = lookupRun("production", "stack-deploy");
    if (found._tag !== "Available") throw new Error("stack-deploy");
    expect(found.entry.spec.serialize).toBe(true);
  });

  it("[FD-GATE-135] cancels as superseded and starts no build when the branch head moved", async () => {
    const { outcome, aws } = await deployStack(stackInput(), { head: OTHER_SHA });
    expect(outcome).toEqual({ _tag: "cancelled", cause: "superseded: branch head moved" });
    expect(aws.calls).toEqual([]);
    const pinned = await deployStack(stackInput({ requireHead: false }), { head: OTHER_SHA });
    expect(pinned.outcome).toEqual({ _tag: "success" });
  });

  it("[FD-GATE-136] waits for a recorded decision before the apply, polling with durable sleeps", async () => {
    const approvals = fakeApprovals([undefined, undefined, "approve"]);
    const { outcome, aws, pause, intents } = await deployStack(
      stackInput({ approval: "required" }),
      {
        approvals,
      },
    );
    expect(outcome).toEqual({ _tag: "success" });
    expect(approvals.requests).toEqual([`production@${SHA}`]);
    expect(pause.sleeps.slice(0, 2)).toEqual(["approval:poll-0", "approval:poll-1"]);
    expect(aws.calls[0]).toBe("start");
    const waiting = intents.emitted.find((i) => i.key === "approval:0")!;
    expect((waiting.payload as { markdown: string }).markdown).toContain("01JEXECUTION");
  });

  it("[FD-GATE-137] records approval: rejected, or approval: timeout once the window ends", async () => {
    const rejected = await deployStack(stackInput({ approval: "required" }), {
      approvals: fakeApprovals(["reject"]),
    });
    expect(rejected.outcome).toEqual({ _tag: "failure", reason: "approval: rejected" });
    expect(rejected.aws.calls).toEqual([]);
    const expired = await deployStack(
      stackInput({ approval: "required", approvalTimeoutSec: 60 }),
      {
        approvals: fakeApprovals([undefined]),
      },
    );
    expect(expired.outcome).toEqual({ _tag: "failure", reason: "approval: timeout" });
    expect(expired.pause.sleeps).toEqual(["approval:poll-0", "approval:poll-1"]);
    const bad = await deployStack(stackInput({ approval: "required", approvalTimeoutSec: 10 }));
    expect(bad.outcome).toEqual({ _tag: "failure", reason: "config: approvalTimeoutSec" });
  });

  it("[FD-GATE-138] adds FD_STACK and FD_IMAGES to the apply's overrides", async () => {
    const { aws } = await deployStack(stackInput());
    expect(aws.starts[0]!.request.env).toMatchObject({
      FD_STACK: "production",
      FD_IMAGES: JSON.stringify(IMAGES),
    });
  });

  const service = (
    name: string,
    rollout: string | undefined,
    running = 2,
    desired = 2,
  ): ServiceRollout => ({
    _tag: "Found",
    name,
    rolloutState: rollout,
    runningCount: running,
    desiredCount: desired,
  });

  it("[FD-GATE-139] waits until every PRIMARY deployment completed with its desired count running", async () => {
    expect(rolloutState([service("api", "COMPLETED")], ["api"])).toEqual({ _tag: "Done" });
    expect(rolloutState([service("api", "COMPLETED", 1, 2)], ["api"])).toEqual({ _tag: "Waiting" });
    expect(rolloutState([service("api", "IN_PROGRESS")], ["api"])).toEqual({ _tag: "Waiting" });
    const aws = fakeAws({
      services: [[service("api", "IN_PROGRESS")], [service("api", "COMPLETED")]],
    });
    const { outcome, pause } = await deployStack(
      stackInput({ rollout: { cluster: "c", services: ["api"] } }),
      { aws },
    );
    expect(outcome).toEqual({ _tag: "success" });
    expect(pause.sleeps).toContain("rollout:poll-0");
  });

  it("[FD-GATE-140] records rollout: <service> missing, failed or timeout", async () => {
    const rollout = { cluster: "c", services: ["api"], timeoutSec: 60 };
    const missing = await deployStack(stackInput({ rollout }), {
      aws: fakeAws({ services: [[{ _tag: "Missing", name: "api" }]] }),
    });
    expect(missing.outcome).toEqual({ _tag: "failure", reason: "rollout: api missing" });
    const failed = await deployStack(stackInput({ rollout }), {
      aws: fakeAws({ services: [[service("api", "FAILED")]] }),
    });
    expect(failed.outcome).toEqual({ _tag: "failure", reason: "rollout: api failed" });
    const slow = await deployStack(stackInput({ rollout }), {
      aws: fakeAws({ services: [[service("api", "IN_PROGRESS")]] }),
    });
    expect(slow.outcome).toEqual({ _tag: "failure", reason: "rollout: api timeout" });
  });

  it("[FD-GATE-141] probes each health URL over HTTPS and refuses another scheme", async () => {
    const ok = await deployStack(
      stackInput({ health: { urls: ["https://app.example.com/health"] } }),
    );
    expect(ok.outcome).toEqual({ _tag: "success" });
    expect(ok.http.requested).toEqual(["https://app.example.com/health"]);
    const down = await deployStack(
      stackInput({ health: { urls: ["https://app.example.com/health"] } }),
      {
        http: okHttp(503),
      },
    );
    expect(down.outcome).toEqual({
      _tag: "failure",
      reason: "health: https://app.example.com/health 503",
    });
    expect(down.http.requested).toHaveLength(3);
    const plain = await deployStack(stackInput({ health: { urls: ["http://app.example.com/"] } }));
    expect(plain.outcome).toEqual({ _tag: "failure", reason: "config: health.urls" });
  });
});
