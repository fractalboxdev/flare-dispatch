// The actuators: the agentic `pr.propose` and `pr.close` appliers over the GitHub package's actuator.
import {
  GitData,
  GitDataError,
  LOCAL_STORE_MIGRATIONS,
  ReuseInputs,
  StagedWriteReadFailed,
  SuppressionLedger,
  suppressionLedgerD1,
  WritebackRecords,
} from "@fractalboxdev/flare-dispatch-agentic";
import { lookupRun } from "@fractalboxdev/flare-dispatch-catalog";
import { GithubHttpError, GithubRead } from "@fractalboxdev/flare-dispatch-github";
import {
  d1IntakeStore,
  IntakeConfig,
  IntakeStore,
  manifestSourceLayer,
  type IntakeRecord,
  type ManifestRead,
} from "@fractalboxdev/flare-dispatch-intake";
import { migratedD1 } from "@fractalboxdev/flare-dispatch-intake/testing";
import {
  Actuators,
  actuatorRegistry,
  type IntentRow,
  LocalRegistration,
} from "@fractalboxdev/mameko-ports";
import { generateKeyPairSync } from "node:crypto";
import { type Context, Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import {
  guardLease,
  issuedCredentials,
  migrateLocalStore,
  repoReusePolicy,
  reuseInputsLayer,
  writebackApplier,
  writeCredentialIn,
} from "../src/agentic.ts";
import { leaseCacheAt } from "../src/cache-execution.ts";
import { isolateServices, type IsolateServices } from "../src/composition.ts";
import type { ControlPlaneEnv } from "../src/config.ts";
import { envOf } from "./conclude.test-support.ts";

const row = (kind: string, payload: unknown): IntentRow =>
  ({
    executionId: "01EXEC",
    epoch: 1,
    intentKey: kind,
    kind,
    scopeId: "acme/widgets",
    limitKey: "installation:1",
    payload,
  }) as unknown as IntentRow;

/** The profile's binding for each kind these tests apply. */
const BINDING: Readonly<Record<string, string>> = {
  "pr.propose": "pullRequest",
  "pr.close": "pullRequest",
  "check.conclude": "checkRun",
};

const base = (seen: string[]) => {
  const actuator = {
    apply: (r: IntentRow) =>
      Effect.sync(() => (seen.push(r.kind), { _tag: "applied" as const, externalRef: "base" })),
    lookup: () => Effect.succeed({ _tag: "absent" as const }),
    reconcile: () => Effect.succeed({ _tag: "absent" as const }),
  };
  return Layer.succeed(Actuators, actuatorRegistry({ checkRun: actuator, pullRequest: actuator }));
};

/** Git data whose every call fails as GitHub refusing it, so a routed row answers the agentic applier's refusal. */
const refusingGit = Layer.succeed(
  GitData,
  new Proxy({} as GitData["Service"], {
    get: (_target, call) => () =>
      Effect.fail(new GitDataError({ call: String(call), status: 403, detail: "refused" })),
  }),
);

/** Records whose every read fails; no routed row in these tests reaches them. */
const unreadRecords = Layer.succeed(WritebackRecords, {
  blobs: () => Effect.fail(new StagedWriteReadFailed({ source: "artifacts", detail: "unread" })),
  modelCalls: () => Effect.fail(new StagedWriteReadFailed({ source: "gateway", detail: "unread" })),
  issuedCredentials: () =>
    Effect.fail(new StagedWriteReadFailed({ source: "credentials", detail: "unread" })),
});

const applierWith = (seen: string[]) =>
  writebackApplier("flare-dispatch[bot]").pipe(
    Layer.provide(Layer.mergeAll(base(seen), refusingGit, unreadRecords)),
  );

const apply = (seen: string[], r: IntentRow) =>
  Effect.runPromise(
    Effect.flatMap(Actuators, (a) => a.get(BINDING[r.kind]!)!.apply(r)).pipe(
      Effect.provide(applierWith(seen)),
    ),
  );

describe("the writeback appliers inside every actuator", () => {
  it("[FD-AGT-009] routes pr.close to the agentic applier, which checks its branch before any GitHub call", async () => {
    const seen: string[] = [];
    const answer = await apply(
      seen,
      row("pr.close", { repo: { owner: "acme", name: "widgets" }, branch: "main", base: "main" }),
    );
    expect(seen).toEqual([]);
    expect(answer).toMatchObject({ _tag: "refused", reason: "writeback: branch-invalid" });
  });

  it("[FD-AGT-009] refuses a pr.propose whose payload does not decode, without the GitHub applier", async () => {
    const seen: string[] = [];
    expect(await apply(seen, row("pr.propose", {}))).toMatchObject({
      _tag: "refused",
      reason: "writeback: payload-invalid",
    });
    expect(seen).toEqual([]);
  });

  it("[FD-GH-001] leaves every other kind to the GitHub package's applier", async () => {
    const seen: string[] = [];
    expect(await apply(seen, row("check.conclude", {}))).toMatchObject({ externalRef: "base" });
    expect(seen).toEqual(["check.conclude"]);
  });

  it("[FD-AGT-001] lists each agentic recipe with a body in the catalogue, on a cloud executor", () => {
    for (const name of [
      "pr-review",
      "improve-pr",
      "spec-drift-pr",
      "ci-triage-pr",
      "release-notes",
    ]) {
      const found = lookupRun("production", name);
      expect(found._tag).toBe("Available");
      if (found._tag !== "Available") continue;
      expect(found.entry.executors).toEqual(["cloud"]);
      expect(found.entry.agentic?.declaration.needsModel).toBeDefined();
    }
    expect(lookupRun("production", "finops-audit")._tag).toBe("NotInCatalogue");
  });
});

const intakeRecord: IntakeRecord = {
  executionId: "x1",
  trigger: "webhook",
  run: "spec-drift-pr",
  label: null,
  repo: "acme/widgets",
  sha: "a".repeat(40),
  ref: "refs/pull/7/head",
  inputs: {},
  className: "batch",
  labels: [],
  attempt: 1,
  familyRoot: "x1",
  installation: null,
  caller: null,
  notBefore: null,
  spendLine: null,
  placementConstraint: null,
  cacheTrigger: { _tag: "PullRequest", number: 7 },
  eligibleKinds: null,
  repositoryPublic: null,
  inputAssociations: [],
  createdAt: 0,
};

describe("the issued-credential read", () => {
  const leased = async () => {
    const db = await migratedD1();
    await Effect.runPromise(
      Effect.flatMap(IntakeStore, (s) => s.put(intakeRecord)).pipe(
        Effect.provide(d1IntakeStore(db)),
      ),
    );
    for (const sql of [
      "insert into executions (id, scope_id, run, status, enqueued_at, deadline_at) values ('x1', 'acme/widgets', 'spec-drift-pr', 'success', 0, 1900000000000)",
      `insert into executors (executor_id, kind, posture_tier, labels_json, slots_json)
         values ('c1', 'cloudflare', 'unmanaged', '[]', '{}')`,
      "insert into placements (execution_id, state, epoch, executor_id, accepted_epoch) values ('x1', 'accepted', 2, 'c1', 2)",
      `insert into lease_records (execution_id, epoch, class, executor_id, executor_kind, "end", ended_at)
         values ('x1', 1, 'batch', 'd1', 'device', 'reclaimed', 5)`,
    ])
      await db.prepare(sql).run();
    return db;
  };

  it("answers the compile-cache token of every lease the execution held, recomputed from intake's record", async () => {
    const env = {
      DB: await leased(),
      PUBLIC_ORIGIN: "https://cp.example",
      COMPILE_CACHE_SECRET: "secret",
    } as unknown as ControlPlaneEnv;
    const tokens = await Effect.runPromise(issuedCredentials(env)("x1"));
    const expected = await Promise.all(
      [
        { epoch: 1, kind: "device" },
        { epoch: 2, kind: "cloudflare" },
      ].map(
        async (lease) =>
          (await leaseCacheAt(env, intakeRecord, lease, 1_900_000_000_000)).upload_grant
            .compile_cache?.token,
      ),
    );
    expect(expected.every((t) => typeof t === "string" && t.startsWith("cc3."))).toBe(true);
    expect([...tokens].sort()).toEqual([...expected].sort());
  });

  it("fails, never answers empty, when intake holds no record of the execution", async () => {
    const env = {
      DB: await leased(),
      COMPILE_CACHE_SECRET: "secret",
    } as unknown as ControlPlaneEnv;
    const failure = await Effect.runPromise(Effect.flip(issuedCredentials(env)("x2")));
    expect(failure).toMatchObject({ _tag: "StagedWriteReadFailed", source: "credentials" });
  });
});

describe("the lease credential guard", () => {
  const APP_KEY = "-----BEGIN RSA PRIVATE KEY-----\nMIIEapp\n-----END RSA PRIVATE KEY-----";
  const env = { GITHUB_APP_PRIVATE_KEY: APP_KEY } as unknown as ControlPlaneEnv;
  const lease = (inputs: unknown) => ({
    run: "pr-review",
    scope_id: "acme/widgets",
    inputs,
    credentials: {},
    upload_grant: { compile_cache: { token: "cc3.abc.def" } },
  });

  it("[FD-AGT-008] passes a lease payload that carries no write credential unchanged", async () => {
    const clean = lease({
      sha: "a".repeat(40),
      steps: [{ label: "test", command: "pnpm test" }],
    });
    expect(await Effect.runPromise(guardLease(env, clean))).toBe(clean);
  });

  it("[FD-AGT-008] fails the grant of a lease payload that carries the App private key or an installation token", async () => {
    const withKey = lease({
      steps: [
        {
          label: "x",
          command: `echo '${APP_KEY.split("\n")[0]}...'`,
          env: { K: APP_KEY },
        },
      ],
    });
    expect(await Effect.runPromise(Effect.flip(guardLease(env, withKey)))).toMatchObject({
      _tag: "CredentialInPayload",
      field: "inputs.steps[0].command",
    });
    const withToken = {
      ...lease({}),
      credentials: { github: `ghs_${"t".repeat(36)}` },
    };
    expect(await Effect.runPromise(Effect.flip(guardLease(env, withToken)))).toMatchObject({
      _tag: "CredentialInPayload",
      field: "credentials.github",
    });
  });

  it("[FD-AGT-008] fails a lease payload that carries the deploy's App key even without its PEM armour", async () => {
    const bare = {
      GITHUB_APP_PRIVATE_KEY: "app-key-material-0123456789",
    } as unknown as ControlPlaneEnv;
    expect(
      await Effect.runPromise(
        Effect.flip(guardLease(bare, lease({ key: "app-key-material-0123456789" }))),
      ),
    ).toMatchObject({ _tag: "CredentialInPayload", field: "inputs.key" });
  });

  it("[FD-AGT-008] names the field of a request's inputs that carries a write credential, for intake to refuse", () => {
    const inputsGuard = writeCredentialIn(env);
    expect(inputsGuard({ steps: [{ label: "test", command: "pnpm test" }] })).toBeNull();
    expect(inputsGuard({ steps: [{ label: "k", command: APP_KEY }] })).toBe("steps[0].command");
    expect(inputsGuard({ token: `ghs_${"t".repeat(36)}` })).toBe("token");
  });
});

describe("the mounted local registration port", () => {
  /** The intake tables and the local-work tables (FD-LOCAL-018), on a database of this test's own. */
  const localDb = async () => {
    const db = await migratedD1();
    for (const m of LOCAL_STORE_MIGRATIONS) for (const sql of m.sql) db.sqlite.exec(sql);
    return db;
  };
  const SHA = "c".repeat(40);
  const rehearsal = {
    treeHash: "tree-1",
    baseCommit: SHA,
    runDigest: "sha256:run",
    imageDigest: "sha256:img",
    platform: "darwin-arm64",
    inputsDigest: "sha256:in",
    reuseKey: "rk1",
    scopeId: "acme/widgets",
    executorId: "dev-1",
    repository: "acme/widgets",
    ref: "refs/heads/feature",
    inputs: {
      repo: "https://github.com/acme/widgets",
      sha: SHA,
      ref: "refs/heads/feature",
      steps: [{ label: "test", command: "pnpm test" }],
    },
    environmentNames: ["CI"],
    wants: { reuse: true, writeback: false },
  };

  // `check` executes on the host, so only a development deployment's catalogue serves it.
  const DEVELOPMENT = { DEPLOYMENT: "development" };
  const deploys = {
    "without the GitHub App": () => DEVELOPMENT,
    "with the GitHub App": () => {
      const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
      return {
        ...DEVELOPMENT,
        GITHUB_APP_ID: "4242",
        GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      };
    },
  };

  for (const [deploy, app] of Object.entries(deploys))
    it(`[FD-INT-061] a deploy ${deploy} admits an accepted local.register as trigger local under local-only, with no check run`, async () => {
      const db = await localDb();
      const services = (await isolateServices(envOf(db, app()))) as Context.Context<
        IsolateServices | LocalRegistration
      >;
      const answer = await Effect.runPromise(
        LocalRegistration.use((port) =>
          port.register({ leaseId: "L1", epoch: 1 }, "check", rehearsal),
        ).pipe(Effect.provide(services)),
      );
      expect(answer).toMatchObject({
        _tag: "accepted",
        nonce: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
      const { executionId } = answer as { executionId: string };
      const rows = (sql: string) => db.sqlite.prepare(sql).all(executionId);
      expect(rows("select * from intake_records where execution_id = ?")).toMatchObject([
        {
          trigger: "local",
          class: "batch",
          placement_constraint: "local-only",
          labels_json: '["local-only"]',
        },
      ]);
      // Admission places it under `local-only` and reserves no cloud spend for it.
      expect(
        rows("select constraints, estimated_cost_micro_usd from executions where id = ?"),
      ).toEqual([{ constraints: '["local-only"]', estimated_cost_micro_usd: 0 }]);
      expect(rows("select intent_key from outbox where execution_id = ?")).toEqual([]);
      expect(rows("select tree_hash from fd_local_registrations where execution_id = ?")).toEqual([
        { tree_hash: "tree-1" },
      ]);
    });

  it("[FD-INT-061] a registration intake refuses is rejected and admits nothing", async () => {
    const db = await localDb();
    const services = (await isolateServices(envOf(db, DEVELOPMENT))) as Context.Context<
      IsolateServices | LocalRegistration
    >;
    const register = (run: string, registration: unknown) =>
      Effect.runPromise(
        LocalRegistration.use((port) =>
          port.register({ leaseId: "L1", epoch: 1 }, run, registration),
        ).pipe(Effect.provide(services)),
      );
    expect(await register("no-such-run", rehearsal)).toEqual({ _tag: "rejected" });
    expect(await register("check", { ...rehearsal, inputs: { sha: SHA } })).toEqual({
      _tag: "rejected",
    });
    expect(db.sqlite.prepare("select * from intake_records").all()).toEqual([]);
    expect(db.sqlite.prepare("select * from fd_local_registrations").all()).toEqual([]);
  });
});

describe("the reuse policy's repository read", () => {
  const BASE_COMMIT = "b".repeat(40);
  const OTHER_COMMIT = "c".repeat(40);

  /** GitHub serving one manifest per commit; every other read is outside these tests. */
  const reuseReads = (manifests: Readonly<Record<string, unknown>>, fail = false) => {
    const files: string[] = [];
    const github = Layer.succeed(
      GithubRead,
      new Proxy({} as GithubRead["Service"], {
        get: (_target, call) =>
          call === "file"
            ? (repo: string, path: string, ref: string) =>
                Effect.suspend(() => {
                  files.push(`${repo} ${path}@${ref}`);
                  if (fail)
                    return Effect.fail(
                      new GithubHttpError({
                        status: 502,
                        message: "bad gateway",
                        rateLimited: false,
                      }),
                    );
                  const m = manifests[ref];
                  const text = m === undefined ? null : JSON.stringify(m);
                  return Effect.succeed(text === null ? null : { text, size: text.length });
                })
            : call === "requiredChecks"
              ? () => Effect.succeed([])
              : () => Effect.die(`GithubRead.${String(call)} is outside these tests`),
      }),
    );
    const config = Layer.succeed(IntakeConfig, { catalog: () => undefined } as never);
    const layer = reuseInputsLayer.pipe(
      Layer.provide(manifestSourceLayer.pipe(Layer.provideMerge(Layer.merge(github, config)))),
    );
    const policy = (baseCommit: string) =>
      Effect.runPromise(
        Effect.flatMap(ReuseInputs, (inputs) => inputs.repoPolicy("acme/widgets", baseCommit)).pipe(
          Effect.match({ onFailure: (e) => `failed: ${e.source}`, onSuccess: (p) => p }),
          Effect.provide(layer),
        ),
      );
    return { policy, files };
  };

  const OFF = { reuse: false, equivalentPlatforms: [] };

  it("[FD-LOCAL-077] turns reuse on only where the manifest at the run's base commit has an enabled reuse block", async () => {
    const h = reuseReads({
      [BASE_COMMIT]: { version: 1, runs: [], reuse: { enabled: true } },
      [OTHER_COMMIT]: { version: 1, runs: [] },
    });
    expect(await h.policy(BASE_COMMIT)).toEqual({ reuse: true, equivalentPlatforms: [] });
    expect(await h.policy(OTHER_COMMIT)).toEqual(OFF);
    expect(h.files).toEqual([
      `acme/widgets .github/flare-dispatch.json@${BASE_COMMIT}`,
      `acme/widgets .github/flare-dispatch.json@${OTHER_COMMIT}`,
    ]);
  });

  it("[FD-LOCAL-077] leaves reuse off for a disabled block and a repository with no manifest", async () => {
    const h = reuseReads({
      [BASE_COMMIT]: {
        version: 1,
        runs: [],
        reuse: { enabled: false, equivalentPlatforms: [["darwin-arm64", "linux-arm64"]] },
      },
    });
    expect(await h.policy(BASE_COMMIT)).toEqual(OFF);
    expect(await h.policy(OTHER_COMMIT)).toEqual(OFF);
  });

  it("[FD-LOCAL-084] answers the platform groups the manifest's reuse block names as equivalent", async () => {
    const groups = [["darwin-arm64", "linux-arm64"], ["linux-x64"]];
    const h = reuseReads({
      [BASE_COMMIT]: {
        version: 1,
        runs: [],
        reuse: { enabled: true, equivalentPlatforms: groups },
      },
    });
    expect(await h.policy(BASE_COMMIT)).toEqual({ reuse: true, equivalentPlatforms: groups });
  });

  it("[FD-LOCAL-077] fails the read, never answers a policy, for an invalid or unreadable manifest", async () => {
    const invalid = reuseReads({
      [BASE_COMMIT]: { version: 1, runs: [], reuse: { enabled: "yes" } },
    });
    expect(await invalid.policy(BASE_COMMIT)).toBe("failed: manifest");
    expect(await reuseReads({}, true).policy(BASE_COMMIT)).toBe("failed: manifest");
  });

  it("maps each manifest read to a policy or a failed read", async () => {
    const run = (read: ManifestRead) =>
      Effect.runPromise(
        repoReusePolicy("acme/widgets", read).pipe(
          Effect.match({ onFailure: (e) => e.detail, onSuccess: (p) => p }),
        ),
      );
    expect(await run({ _tag: "Absent" })).toEqual(OFF);
    expect(await run({ _tag: "Unreadable", reason: "timeout after 10 s" })).toBe(
      "acme/widgets: timeout after 10 s",
    );
    expect(await run({ _tag: "Invalid", errors: ["runs[0].recipe: no recipe named x"] })).toBe(
      "acme/widgets: invalid manifest: runs[0].recipe: no recipe named x",
    );
  });
});

describe("the control plane's local-store migration", () => {
  it("[FD-AGT-043] creates the suppression ledger's table, so a lookup of a key with no row answers null", async () => {
    const db = await migratedD1();
    await migrateLocalStore(db);
    expect(
      db.sqlite
        .prepare("select name from sqlite_master where type = 'table' and name = 'fd_suppressions'")
        .all(),
    ).toEqual([{ name: "fd_suppressions" }]);
    const entry = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* SuppressionLedger).lookup("acme/widgets:flare-dispatch/spec-drift");
      }).pipe(Effect.provide(suppressionLedgerD1(db))),
    );
    expect(entry).toBeNull();
  });
});
