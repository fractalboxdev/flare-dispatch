import {
  LocalRegistration,
  PostureSource,
  ReusePolicy,
  WritebackGate,
} from "@fractalboxdev/mameko-ports";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { localPortsLayer } from "./integration.ts";
import { memoryD1 } from "./local/d1.test-support.ts";
import { LocalSubmit } from "./local/registration.ts";
import { ReuseInputs } from "./local/reuse.ts";
import { localStoreD1, LocalStore } from "./local/store.ts";
import { CapacityUsage } from "./local/writeback-gate.ts";
import { WritebackRecords } from "./writeback/applier.ts";
import { fakeGitLayer, fakeRepo } from "./writeback/fake-git.test-support.ts";

describe("local ports as the control plane mounts them", () => {
  it("[FD-LOCAL-072] [FD-LOCAL-078] [FD-LOCAL-087] a rehearsal registers, reports, stands in for a check and writes back a review", async () => {
    const db = memoryD1();
    const inputs = Layer.mergeAll(
      Layer.succeed(ReuseInputs, {
        repoPolicy: () => Effect.succeed({ reuse: true, equivalentPlatforms: [] }),
        readRequiredSet: () => Effect.succeed([]),
        epochIssued: () => Effect.succeed(true),
      }),
      Layer.succeed(PostureSource, {
        posture: () => Effect.succeed("attested-dedicated" as const),
      }),
      fakeGitLayer(fakeRepo()),
      Layer.succeed(WritebackRecords, {
        blobs: () => Effect.succeed([]),
        modelCalls: () => Effect.succeed(false),
        issuedCredentials: () => Effect.succeed([]),
      }),
      Layer.succeed(CapacityUsage, { modelCalls: () => Effect.succeed(false) }),
      Layer.succeed(LocalSubmit, {
        submit: (_lease, run) =>
          Effect.succeed(
            run === "pr-review"
              ? ({ _tag: "admitted", executionId: "01EXECLOCAL" } as const)
              : ({ _tag: "rejected" } as const),
          ),
      }),
    );
    const ports = localPortsLayer({ db }).pipe(Layer.provide(inputs));
    const provenance = {
      treeHash: "t",
      baseCommit: "b".repeat(40),
      runDigest: "sha256:r",
      imageDigest: "sha256:i",
      platform: "darwin-arm64",
      inputsDigest: "sha256:n",
    };
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const registration = yield* LocalRegistration;
        const answer = yield* registration.register({ leaseId: "L1", epoch: 1 }, "pr-review", {
          ...provenance,
          reuseKey: "rk",
          scopeId: "scope",
          executorId: "dev-1",
          repository: "o/r",
          ref: "refs/heads/feature",
          inputs: {},
          environmentNames: [],
          wants: { reuse: true, writeback: true },
        });
        if (answer._tag !== "accepted") return { answer };
        const store = yield* LocalStore;
        yield* store.recordStart(answer.executionId, Date.now() + 1);
        yield* store.recordOutcome(answer.executionId, "success");
        yield* store.recordStatement(answer.executionId, "stmt", true);
        const reuse = yield* ReusePolicy;
        const named = yield* reuse.reuse(
          {
            ...provenance,
            scopeId: "scope",
            repository: "o/r",
            baseBranch: "main",
            checkName: "flare-dispatch/pr-review",
            run: "pr-review",
            placementRule: "local-first",
            intentKinds: ["check.summary"],
            environmentNames: [],
          },
          "rk",
        );
        const gate = yield* WritebackGate;
        const accepted = yield* gate.decide(answer.executionId, [
          { intent_key: "run:review:0", kind: "review", payload: { body: "ok" } },
        ]);
        return { answer, named, accepted };
      }).pipe(Effect.provide(Layer.merge(ports, localStoreD1(db)))),
    );
    expect(result.answer._tag).toBe("accepted");
    expect(result).toMatchObject({
      named: (result.answer as { executionId: string }).executionId,
      accepted: true,
    });
  });
});
