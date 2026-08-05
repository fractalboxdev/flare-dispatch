// Integration tests for R2ArtifactLive — the live `artifact` capability.
//
// Drives the real R2 binding via Miniflare. Asserts that `upload` promotes a
// source log object to the stable `artifacts/<execId>/<name>` key and returns
// a `/v1/artifacts/...`-shaped URL.

import { Effect, Exit } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Artifact } from "@fractalboxdev/flare-dispatch-core";
import { makeR2ArtifactLive } from "./artifact-r2";
import { makeTestBindings, type TestBindings } from "./test-support";

const EXECUTION_ID = "01TEST00000000000000000002";

describe("R2ArtifactLive", () => {
  let bindings: TestBindings;

  beforeEach(async () => {
    bindings = await makeTestBindings();
  });
  afterEach(async () => {
    await bindings.dispose();
  });

  it("promotes a source log object to the stable artifact key", async () => {
    // Seed the source object the exec step would have streamed to R2.
    const logKey = `logs/${EXECUTION_ID}/exec.ndjson`;
    const logBody = '{"stream":"stdout","line":"all tests passed"}\n';
    await bindings.bucket.put(logKey, logBody);

    const layer = makeR2ArtifactLive(bindings.bucket, EXECUTION_ID);

    const url = await Effect.runPromise(
      Effect.gen(function* () {
        const artifact = yield* Artifact;
        return yield* artifact.upload({ name: "step.log", path: logKey });
      }).pipe(Effect.provide(layer)),
    );

    // The returned URL is the stable, PR5-signable artifact path.
    expect(url).toBe(`/v1/artifacts/${EXECUTION_ID}/step.log`);

    // The artifact object exists at the expected key with the source content.
    const artifactObj = await bindings.bucket.get(`artifacts/${EXECUTION_ID}/step.log`);
    expect(artifactObj).not.toBeNull();
    expect(await artifactObj?.text()).toBe(logBody);
  });

  // NB: the >16 MiB multipart path can't be exercised here — the Node
  // forks-pool's Miniflare R2 binding doesn't implement `createMultipartUpload`
  // — so `putStream`'s chunking logic is unit-tested directly against a fake
  // bucket in `r2-put-stream.test.ts`, and the real R2 multipart behavior is a
  // `wrangler dev` smoke (same gate as the container-tar path).

  it("returns an absolute URL when a public origin is wired in", async () => {
    const logKey = `logs/${EXECUTION_ID}/exec.ndjson`;
    await bindings.bucket.put(logKey, "log");

    // Trailing slash on the origin must not produce a `//v1/...` double-slash.
    const layer = makeR2ArtifactLive(
      bindings.bucket,
      EXECUTION_ID,
      undefined,
      "https://dispatcher.example.com/",
    );

    const { url, listed } = await Effect.runPromise(
      Effect.gen(function* () {
        const artifact = yield* Artifact;
        const url = yield* artifact.upload({ name: "step.log", path: logKey });
        const listed = yield* artifact.list({ executionId: EXECUTION_ID });
        return { url, listed };
      }).pipe(Effect.provide(layer)),
    );

    expect(url).toBe(`https://dispatcher.example.com/v1/artifacts/${EXECUTION_ID}/step.log`);
    expect(listed[0]?.url).toBe(
      `https://dispatcher.example.com/v1/artifacts/${EXECUTION_ID}/step.log`,
    );
  });

  it("lists uploaded artifacts for an execution", async () => {
    await bindings.bucket.put(`logs/${EXECUTION_ID}/exec.ndjson`, "log");
    const layer = makeR2ArtifactLive(bindings.bucket, EXECUTION_ID);

    const listed = await Effect.runPromise(
      Effect.gen(function* () {
        const artifact = yield* Artifact;
        yield* artifact.upload({
          name: "step.log",
          path: `logs/${EXECUTION_ID}/exec.ndjson`,
        });
        return yield* artifact.list({ executionId: EXECUTION_ID });
      }).pipe(Effect.provide(layer)),
    );

    expect(listed.map((a) => a.name)).toEqual(["step.log"]);
    expect(listed[0]?.url).toBe(`/v1/artifacts/${EXECUTION_ID}/step.log`);
  });

  it("fails ArtifactUploadFailed when the source object is missing", async () => {
    const layer = makeR2ArtifactLive(bindings.bucket, EXECUTION_ID);

    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const artifact = yield* Artifact;
        return yield* artifact.upload({
          name: "step.log",
          path: "logs/missing/nope.ndjson",
        });
      }).pipe(Effect.provide(layer)),
    );

    expect(Exit.isFailure(exit)).toBe(true);
  });
});
