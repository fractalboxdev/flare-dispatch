// The release publish gate over the deployed Worker (specs/provenance.md § Releases): a release's `release.publish`
// row reaches the drainer on the minute tick, and the `release` applier publishes the draft only when a logged
// `platform` statement from a cloud builder names each artifact's digest. The statement is the cloud builder's own:
// `writeCloudStatement` digests the artifact bytes the Worker's R2 bucket holds and signs with the `PROVENANCE_KEY`
// the Worker holds, its log-append intent goes into the Worker's D1, and the tick appends it to the private log. The
// fixture server answers GitHub's releases list, each asset with the digest of its bytes, and records each publish.
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  artifactPath,
  type Bucket,
  CacheBucket,
  d1LogAppendStore,
  enqueueLogAppend,
  LogAppendStore,
  parseProvenanceKey,
  publicJwkOf,
  RELEASE_STATEMENT_MISSING,
  RepositoryVisibility,
  writeCloudStatement,
} from "@fractalboxdev/flare-dispatch-cache";
import { insertOutboxRows } from "@fractalboxdev/mameko-host-cloudflare/d1";
import { newRow } from "@fractalboxdev/mameko-kernel";
import { Effect, Layer } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GithubState } from "./fixtures/github-server.ts";
import { startStack, type Stack } from "./stack.ts";

const STATE = JSON.parse(
  readFileSync(join(import.meta.dirname, "fixtures/intake-github.json"), "utf8"),
) as GithubState;

const WIDGETS = "acme/widgets";
const ASSET = "app.tar.gz";

/** A private ES256 JWK with its `kid`, as the `PROVENANCE_KEY` and `LOG_KEY` secrets hold it. */
const secretKey = (kid: string) =>
  JSON.stringify({
    ...generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ format: "jwk" }),
    kid,
  });

const PROVENANCE_KEY = secretKey("prov-e2e");

let stack: Stack;

beforeAll(async () => {
  stack = await startStack({
    github: STATE,
    secrets: { PROVENANCE_KEY, LOG_KEY: secretKey("log-e2e") },
  });
  // The Worker migrates its D1 on its first request; the minute tick migrates nothing.
  await (await fetch(`${stack.url}/v1/executions/none`)).arrayBuffer();
});

afterAll(async () => {
  await stack?.close();
});

/** The 15-minute probes push a canary; a tick outside their minute drains and runs the units only. */
const PROBE_INTERVAL_MS = 15 * 60_000;

/** One minute tick through the Worker's `scheduled` handler, at a time no earlier than any row's insertion. */
const tick = async () => {
  let at = Date.now() + 1_000;
  if (at % PROBE_INTERVAL_MS < 60_000) at += 60_000;
  const worker = await stack.mf.getWorker();
  await worker.scheduled({ cron: "* * * * *", scheduledTime: new Date(at) });
  const db = await stack.mf.getD1Database("DB");
  await expect
    .poll(
      async () => (await db.prepare("select at from fd_liveness where key = 'tick'").all()).results,
    )
    .toEqual([{ at }]);
};

const sha256 = async (bytes: Uint8Array) =>
  `sha256:${Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex")}`;

/** A release execution's artifact, stored where the control plane keeps an accepted result's artifacts. */
const storeArtifact = async (executionId: string, contents: string) => {
  const bytes = new TextEncoder().encode(contents);
  const bucket = await stack.mf.getR2Bucket("CACHE");
  await bucket.put(artifactPath(executionId, 1, ASSET), bytes);
  return { name: ASSET, digest: await sha256(bytes) };
};

/**
 * The cloud builder's statement of a release execution's accepted result: written over the artifact bytes in R2,
 * signed with the Worker's provenance key, and recorded as a log-append intent in the Worker's D1.
 */
const recordCloudStatement = async (executionId: string, tag: string) => {
  const key = parseProvenanceKey(PROVENANCE_KEY)!;
  const bucket = await stack.mf.getR2Bucket("CACHE");
  const db = await stack.mf.getD1Database("DB");
  const sha = (c: string) => `sha256:${c.repeat(64)}`;
  const { envelope } = await Effect.runPromise(
    writeCloudStatement(
      {
        lease: {
          execution_id: executionId,
          epoch: 1,
          nonce: "n-0123456789abcdef",
          executor_id: "cf-7",
          executor_kind: "cloudflare",
          run: { name: "release", kind: "build", definition_digest: sha("a"), inputs_digest: sha("b") },
          repository: WIDGETS,
          ref: `refs/tags/${tag}`,
          commit_sha: "c".repeat(40),
          image_digest: sha("d"),
          class: "release",
          policy_version: "1",
          confidentiality: "unclassified",
        },
        outcome: "success",
        commands: [{ name: "build", exit_status: 0 }],
        artifacts: [{ name: ASSET }],
        lockfiles: [{ path: "pnpm-lock.yaml", digest: sha("e") }],
        fetches: [],
        locked_dependencies: [],
        restored_cache: [],
        egress_log_digest: sha("f"),
        step_log_digest: sha("1"),
        models: [],
      },
      key,
    ).pipe(Effect.provide(Layer.succeed(CacheBucket, bucket as unknown as Bucket))),
  );
  const { digest } = await Effect.runPromise(
    enqueueLogAppend(
      { envelope, executionId, repository: WIDGETS, verifiers: [publicJwkOf(key)] },
      Date.now(),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(LogAppendStore, d1LogAppendStore(db as unknown as D1Database)),
          Layer.succeed(RepositoryVisibility, { of: () => Effect.succeed("private") }),
        ),
      ),
    ),
  );
  return digest;
};

/** The execution's `release.publish` row as the release recipe's success inserts it, with its artifacts. */
const insertPublish = async (
  executionId: string,
  tag: string,
  artifacts: readonly { readonly name: string; readonly digest: string }[],
) => {
  const db = await stack.mf.getD1Database("DB");
  const payload = { tag, artifacts };
  const now = Date.now();
  await insertOutboxRows(db, [
    {
      id: `${executionId}:run:release-publish:0`,
      limitKey: WIDGETS,
      tier: "effect",
      priority: 2,
      classRank: 0,
      drawsReserve: false,
      intent: {
        executionId,
        scopeId: WIDGETS,
        intentKey: "run:release-publish:0",
        kind: "release.publish",
        payload,
        payloadDigest: (await sha256(new TextEncoder().encode(JSON.stringify(payload)))).slice(7),
        effectClass: "adoptable",
        attempts: 0,
      },
      row: newRow({ effectClass: "adoptable", insertedAt: now }),
    },
  ]);
};

const outboxRowOf = async (executionId: string) => {
  const db = await stack.mf.getD1Database("DB");
  return db
    .prepare("select state, last_error from outbox where execution_id = ? and kind = 'release.publish'")
    .bind(executionId)
    .first();
};

const publishesOf = (release: number) =>
  stack.github.writes.filter(
    (w) => w.method === "PATCH" && w.path === `/repos/${WIDGETS}/releases/${release}`,
  );

describe("the release publish gate", () => {
  it("[FD-PROV-062] the drain publishes a release whose artifact digest a logged cloud-builder statement names, and refuses one with no such statement with `provenance: release statement missing`, leaving it a draft", async () => {
    // The attested release: its execution's cloud-builder statement is logged before its publish row is drained.
    const attested = "exec-release-attested";
    const attestedArtifact = await storeArtifact(attested, "attested tarball");
    const envelopeDigest = await recordCloudStatement(attested, "v1.0.0");
    const db = await stack.mf.getD1Database("DB");
    await tick();
    await expect
      .poll(async () =>
        db
          .prepare("select integrated_time is not null as logged from provenance_log_appends where envelope_digest = ?")
          .bind(envelopeDigest)
          .first(),
      )
      .toEqual({ logged: 1 });

    // The unattested release: its artifact is stored, but no cloud builder signed a statement for its execution.
    const unattested = "exec-release-unattested";
    const unattestedArtifact = await storeArtifact(unattested, "unattested tarball");

    const attestedRelease = stack.github.draftRelease(WIDGETS, "v1.0.0", [attestedArtifact]);
    const unattestedRelease = stack.github.draftRelease(WIDGETS, "v1.0.1", [unattestedArtifact]);
    await insertPublish(attested, "v1.0.0", [attestedArtifact]);
    await insertPublish(unattested, "v1.0.1", [unattestedArtifact]);
    await tick();

    await expect.poll(() => outboxRowOf(attested)).toMatchObject({ state: "applied" });
    expect(publishesOf(attestedRelease).map((w) => w.body)).toEqual([{ draft: false }]);
    await expect
      .poll(() => outboxRowOf(unattested))
      .toEqual({ state: "refused", last_error: RELEASE_STATEMENT_MISSING });
    expect(publishesOf(unattestedRelease)).toEqual([]);
    expect(stack.github.releases(WIDGETS).map((r) => [r.tag_name, r.draft])).toEqual([
      ["v1.0.0", false],
      ["v1.0.1", true],
    ]);
  });
});
