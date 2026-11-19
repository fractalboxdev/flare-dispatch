// The control plane's half of `image-publish` and `stack-deploy` (specs/runs/gate.md § AWS builds and stack deploys):
// the OIDC exchange and signed AWS calls, the build ledger, the approval record and its route's store, and release
// asset staging.
import { generateKeyPairSync } from "node:crypto";
import {
  AwsBuilds,
  ExecutionLease,
  BuildLedger,
  StackApprovals,
} from "@fractalboxdev/flare-dispatch-catalog";
import { migratedD1 } from "@fractalboxdev/flare-dispatch-intake/testing";
import { StackApprovalDecisions } from "@fractalboxdev/flare-dispatch-ops";
import { Cause, Effect, Exit, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { awsBuildsLayer, rolloutsOf } from "../src/aws.ts";
import { awsRecordsLayer, stackApprovalDecisions } from "../src/aws-records.ts";
import { stageReleaseAsset, type AssetStore } from "../src/release-assets.ts";

const jwk = () => {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return JSON.stringify({ ...privateKey.export({ format: "jwk" }), kid: "k1", alg: "ES256" });
};

const lease = (scopeId = "o/r") =>
  Layer.succeed(ExecutionLease, {
    executionId: "01JEXEC",
    epoch: 1,
    run: "stack-deploy",
    input: {},
    scopeId,
  });

const decodeJwt = (jwt: string) =>
  JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString("utf8")) as Record<
    string,
    unknown
  >;

const STS_OK = `<AssumeRoleWithWebIdentityResponse><AssumeRoleWithWebIdentityResult><Credentials>
  <AccessKeyId>ASIAEXAMPLE</AccessKeyId><SecretAccessKey>secret-key</SecretAccessKey>
  <SessionToken>session-token</SessionToken><Expiration>2099-01-01T00:00:00Z</Expiration>
</Credentials></AssumeRoleWithWebIdentityResult></AssumeRoleWithWebIdentityResponse>`;

/** A fake AWS: STS answers `sts`, CodeBuild and ECS answer from `json` by target. */
const fakeAws = (answers: {
  sts?: () => Response;
  json?: (target: string, body: unknown) => Response;
}) => {
  const requests: { url: string; headers: Record<string, string>; body: string }[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const body = String(init?.body ?? "");
    requests.push({ url, headers, body });
    if (url.startsWith("https://sts.")) return answers.sts?.() ?? new Response(STS_OK);
    return (
      answers.json?.(headers["x-amz-target"] ?? "", JSON.parse(body)) ??
      Response.json({ build: { id: "app:1" } })
    );
  }) as typeof globalThis.fetch;
  return { fetch, requests };
};

const target = {
  region: "us-east-1",
  roleArn: "arn:aws:iam::111122223333:role/r",
  target: "stack:production",
};

const run = <A, E>(
  effect: Effect.Effect<A, E, AwsBuilds>,
  fetch: typeof globalThis.fetch,
  scope?: string,
) =>
  Effect.runPromiseExit(
    effect.pipe(
      Effect.provide(
        awsBuildsLayer(
          { PUBLIC_ORIGIN: "https://ci.example.com", OIDC_SIGNING_JWK: jwk() },
          { fetch },
        ).pipe(Layer.provide(lease(scope))),
      ),
    ),
  );

describe("AWS federation", () => {
  it("[FD-GATE-117] exchanges a token whose aud names the lease's repository and target and whose sub is <run>:<execution_id>", async () => {
    const aws = fakeAws({});
    const exit = await run(
      Effect.flatMap(AwsBuilds, (b) =>
        b.start(target, {
          project: "p",
          sourceVersion: "a".repeat(40),
          env: {},
          idempotencyToken: "t",
        }),
      ),
      aws.fetch,
      "o/r",
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    const sts = aws.requests.find((r) => r.url.startsWith("https://sts.us-east-1."))!;
    const form = new URLSearchParams(sts.body);
    expect(form.get("Action")).toBe("AssumeRoleWithWebIdentity");
    expect(form.get("RoleArn")).toBe(target.roleArn);
    const claims = decodeJwt(form.get("WebIdentityToken")!);
    expect(claims["aud"]).toBe("flare-dispatch:o/r:stack:production");
    expect(claims["sub"]).toBe("stack-deploy:01JEXEC");
    expect(claims["iss"]).toBe("https://ci.example.com");
    // STS is called unsigned: the token is the only credential it receives.
    expect(sts.headers["authorization"]).toBeUndefined();
  });

  it("[FD-GATE-118] signs CodeBuild calls with the role's credentials and sends none in the request body", async () => {
    const aws = fakeAws({});
    await run(
      Effect.flatMap(AwsBuilds, (b) =>
        b.start(target, {
          project: "p",
          sourceVersion: "a".repeat(40),
          env: { FD_SHA: "a".repeat(40) },
          idempotencyToken: "t",
        }),
      ),
      aws.fetch,
    );
    const start = aws.requests.find((r) => r.url === "https://codebuild.us-east-1.amazonaws.com/")!;
    expect(start.headers["x-amz-target"]).toBe("CodeBuild_20161006.StartBuild");
    expect(start.headers["authorization"]).toMatch(/^AWS4-HMAC-SHA256 Credential=ASIAEXAMPLE\//);
    expect(start.headers["x-amz-security-token"]).toBe("session-token");
    expect(start.body).not.toMatch(/ASIAEXAMPLE|secret-key|session-token/);
    expect(JSON.parse(start.body)).toEqual({
      projectName: "p",
      sourceVersion: "a".repeat(40),
      idempotencyToken: "t",
      environmentVariablesOverride: [{ name: "FD_SHA", value: "a".repeat(40), type: "PLAINTEXT" }],
    });
  });

  it("[FD-GATE-119] fails with STS's error code when the exchange is refused", async () => {
    const aws = fakeAws({
      sts: () =>
        new Response(
          "<ErrorResponse><Error><Code>InvalidIdentityToken</Code></Error></ErrorResponse>",
          {
            status: 400,
          },
        ),
    });
    const exit = await run(
      Effect.flatMap(AwsBuilds, (b) => b.get(target, "app:1")),
      aws.fetch,
    );
    expect(Exit.isFailure(exit) && JSON.stringify(exit.cause)).toContain("InvalidIdentityToken");
    expect(aws.requests.some((r) => r.url.startsWith("https://codebuild."))).toBe(false);
  });

  it("[FD-GATE-125] marks a 5xx transient and a 4xx with its error code", async () => {
    for (const [status, transient, code] of [
      [503, true, "ServiceUnavailable"],
      [400, false, "AccessDeniedException"],
    ] as const) {
      const aws = fakeAws({
        json: () => Response.json({ __type: `com.amazonaws#${code}`, message: "no" }, { status }),
      });
      const exit = await run(
        Effect.flatMap(AwsBuilds, (b) => b.get(target, "app:1")),
        aws.fetch,
      );
      const text = JSON.stringify(exit);
      expect(text).toContain(`"transient":${transient}`);
      expect(text).toContain(code);
    }
  });

  it("[FD-GATE-139] reads each named service's PRIMARY rollout and marks an absent one missing", () => {
    expect(
      rolloutsOf(
        {
          services: [
            {
              serviceName: "api",
              desiredCount: 2,
              runningCount: 2,
              deployments: [
                { status: "ACTIVE", rolloutState: "COMPLETED" },
                { status: "PRIMARY", rolloutState: "IN_PROGRESS" },
              ],
            },
          ],
        },
        ["api", "worker"],
      ),
    ).toEqual([
      { _tag: "Found", name: "api", rolloutState: "IN_PROGRESS", runningCount: 2, desiredCount: 2 },
      { _tag: "Missing", name: "worker" },
    ]);
  });
});

describe("AWS records", () => {
  const records = (db: Awaited<ReturnType<typeof migratedD1>>) =>
    awsRecordsLayer(db, () => 1000).pipe(Layer.provide(lease()));

  it("[FD-GATE-121] keeps the first build recorded for an execution and target", async () => {
    const db = await migratedD1();
    const recorded = await Effect.runPromise(
      Effect.gen(function* () {
        const ledger = yield* BuildLedger;
        const before = yield* ledger.recorded("stack:production");
        yield* ledger.record("stack:production", "app:1");
        yield* ledger.record("stack:production", "app:2");
        return [before, yield* ledger.recorded("stack:production")];
      }).pipe(Effect.provide(records(db))),
    );
    expect(recorded).toEqual([undefined, "app:1"]);
  });

  const execution = async (db: Awaited<ReturnType<typeof migratedD1>>, status: string) =>
    db
      .prepare(
        `insert into mameko_executions (id, scope_id, run, class, status, enqueued_at)
         values ('01JEXEC', 'o/r', 'stack-deploy', 'release', ?, 0)`,
      )
      .bind(status)
      .run();

  const decide = (
    db: Awaited<ReturnType<typeof migratedD1>>,
    requestId: string,
    decision: "approve" | "reject" = "approve",
  ) =>
    Effect.runPromiseExit(
      Effect.flatMap(StackApprovalDecisions, (d) =>
        d.decide({
          executionId: "01JEXEC",
          decision,
          identity: "op@example.com",
          reason: "ship",
          requestId,
        }),
      ).pipe(Effect.provide(stackApprovalDecisions(db, () => 2000))),
    );

  const codeOf = async (pending: ReturnType<typeof decide>) => {
    const exit = await pending;
    if (Exit.isSuccess(exit)) return "ok";
    const error = Cause.findErrorOption(exit.cause);
    return error._tag === "Some" ? (error.value as { error?: string }).error : "?";
  };

  it("[FD-GATE-136] [FD-IFC-104] records an operator's decision on the waiting execution, which the run then reads", async () => {
    const db = await migratedD1();
    await execution(db, "running");
    await Effect.runPromise(
      Effect.flatMap(StackApprovals, (a) => a.request("production", "a".repeat(40))).pipe(
        Effect.provide(records(db)),
      ),
    );
    const exit = await decide(db, "req-1");
    expect(Exit.isSuccess(exit) && exit.value).toEqual({
      execution_id: "01JEXEC",
      sha: "a".repeat(40),
      stack: "production",
      decision: "approve",
      decided_by: "op@example.com",
      reason: "ship",
      request_id: "req-1",
      decided_at: 2000,
    });
    const read = await Effect.runPromise(
      Effect.flatMap(StackApprovals, (a) => a.decision()).pipe(Effect.provide(records(db))),
    );
    expect(read).toBe("approve");
  });

  it("[FD-IFC-105] answers execution_not_found, or not_awaiting_approval for an execution that waits for none or ended", async () => {
    const empty = await migratedD1();
    expect(await codeOf(decide(empty, "r"))).toBe("execution_not_found");
    const waitsForNone = await migratedD1();
    await execution(waitsForNone, "running");
    expect(await codeOf(decide(waitsForNone, "r"))).toBe("not_awaiting_approval");
    const ended = await migratedD1();
    await execution(ended, "success");
    expect(await codeOf(decide(ended, "r"))).toBe("not_awaiting_approval");
  });

  it("[FD-IFC-106] keeps the first decision and answers conflict to a second", async () => {
    const db = await migratedD1();
    await execution(db, "running");
    await Effect.runPromise(
      Effect.flatMap(StackApprovals, (a) => a.request("production", "a".repeat(40))).pipe(
        Effect.provide(records(db)),
      ),
    );
    expect(await codeOf(decide(db, "req-1", "reject"))).toBe("ok");
    expect(await codeOf(decide(db, "req-2", "approve"))).toBe("conflict");
    const read = await Effect.runPromise(
      Effect.flatMap(StackApprovals, (a) => a.decision()).pipe(Effect.provide(records(db))),
    );
    expect(read).toBe("reject");
  });
});

describe("release assets", () => {
  const SHA = (bytes: Uint8Array) =>
    crypto.subtle.digest("SHA-256", bytes).then((d) => Buffer.from(d).toString("hex"));

  const memoryStore = () => {
    const objects = new Map<string, Uint8Array>();
    const store: AssetStore = {
      exists: async (key) => objects.has(key),
      put: async (key, body) =>
        void objects.set(key, new Uint8Array(await new Response(body).arrayBuffer())),
      remove: async (key) => void objects.delete(key),
    };
    return { objects, store };
  };

  const github = (bytes: Uint8Array, size = bytes.length) => {
    const requests: { url: string; auth: string | null }[] = [];
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, auth: new Headers(init?.headers).get("authorization") });
      if (url.endsWith("/releases/tags/v1"))
        return Response.json({ assets: [{ id: 9, name: "tool.tgz", size }] });
      if (url.endsWith("/releases/assets/9"))
        return new Response(null, {
          status: 302,
          headers: { location: "https://objects.example/tool" },
        });
      if (url === "https://objects.example/tool") return new Response(bytes);
      return new Response(null, { status: 404 });
    }) as typeof globalThis.fetch;
    return { fetch, requests };
  };

  const presigner = {
    presign: (r: { key: string; expiresAt: number }) =>
      Effect.succeed({
        url: `https://r2.example/${r.key}?exp=${r.expiresAt}`,
        expiresAt: r.expiresAt,
      }),
  };

  const stage = async (
    bytes: Uint8Array,
    sha256: string,
    options: { token?: string | null; size?: number; name?: string } = {},
  ) => {
    const gh = github(bytes, options.size);
    const mem = memoryStore();
    const exit = await Effect.runPromiseExit(
      stageReleaseAsset({
        tokenFor: () => Effect.succeed(options.token === undefined ? "inst-token" : options.token),
        fetch: gh.fetch,
        apiBase: "https://api.github.com",
        store: mem.store,
        presigner,
        deadlineAt: undefined,
        now: () => 0,
      })({ key: "TOOL", repo: "o/tool", tag: "v1", name: options.name ?? "tool.tgz", sha256 }),
    );
    return { exit, gh, mem };
  };

  it("[FD-GATE-129] stores the asset at cas/<sha256> and answers a presigned GET, following the redirect without the token", async () => {
    const bytes = new TextEncoder().encode("tool bytes");
    const sha = await SHA(bytes);
    const { exit, gh, mem } = await stage(bytes, sha);
    expect(Exit.isSuccess(exit) && exit.value).toEqual({
      url: `https://r2.example/cas/${sha}?exp=${15 * 60 * 1000}`,
      sha256: sha,
    });
    expect(mem.objects.has(`cas/${sha}`)).toBe(true);
    expect(gh.requests.find((r) => r.url.includes("/releases/tags/"))!.auth).toBe(
      "Bearer inst-token",
    );
    expect(gh.requests.find((r) => r.url === "https://objects.example/tool")!.auth).toBeNull();
  });

  it("[FD-GATE-130] fails uninstalled, not found, too large or digest mismatch, and keeps no mismatched object", async () => {
    const bytes = new TextEncoder().encode("tool bytes");
    const sha = await SHA(bytes);
    const kindOf = (exit: Exit.Exit<unknown, unknown>) =>
      JSON.stringify(exit).match(/"kind":"([a-z ]+)"/)?.[1];
    expect(kindOf((await stage(bytes, sha, { token: null })).exit)).toBe("uninstalled");
    expect(kindOf((await stage(bytes, sha, { name: "other.tgz" })).exit)).toBe("not found");
    expect(kindOf((await stage(bytes, sha, { size: 513 * 1024 * 1024 })).exit)).toBe("too large");
    const wrong = await stage(bytes, "e".repeat(64));
    expect(kindOf(wrong.exit)).toBe("digest mismatch");
    expect(wrong.mem.objects.size).toBe(0);
  });
});
