import { buildProfile } from "@fractalboxdev/flare-dispatch-profile";
import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";
import { answerLine, type ExtensionState } from "./extension.ts";
import {
  buildEnvelope,
  buildStatement,
  disallowedContent,
  DSSE_PAYLOAD_TYPE,
  dssePae,
  SLSA_PROVENANCE_V1,
  STATEMENT_SIGNING_PURPOSE,
  STATEMENT_TYPE,
  TEST_RESULT_V0_1,
  type Statement,
} from "./statement.ts";

const d = (n: number) => `sha256:${n.toString(16).padStart(64, "0")}`;
const hex = (n: number) => n.toString(16).padStart(64, "0");
const COMMIT = "a".repeat(40);

const input = (kind: "build" | "gate", over: Record<string, unknown> = {}) => ({
  lease: {
    execution_id: "01JDZ8Q6V3M2K9T4WXYZ5ABCDE",
    epoch: 3,
    nonce: "9f2c4e1a7b3d5f60a1b2c3d4e5f60718",
    executor_id: "mac-1",
    executor_kind: "apple-container",
    binding_kind: "execution-lease",
    run: {
      name: kind === "build" ? "build-image" : "test",
      kind,
      definition_digest: d(1),
      inputs_digest: d(2),
    },
    repository: "o/r",
    ref: "refs/heads/main",
    commit_sha: COMMIT,
    image_digest: d(3),
    class: "required",
    policy_version: "p-7",
    confidentiality: "unclassified",
  },
  code_hash: d(4),
  outcome: "success",
  commands: [
    { name: "lint", exit_status: 0 },
    { name: "unit", exit_status: 0 },
  ],
  outputs: [
    { name: "dist/app.tgz", digest: d(10) },
    { name: "image.oci", digest: d(11) },
  ],
  lockfiles: [{ path: "pnpm-lock.yaml", digest: d(5) }],
  fetches: [
    {
      host: "registry.npmjs.org",
      method: "GET",
      path: "/effect/-/effect-4.0.6.tgz",
      response_digest: d(20),
    },
    { host: "github.com", method: "GET", path: "/o/dep.tar.gz", response_digest: null },
  ],
  locked_dependencies: [
    { uri: "https://github.com/o/dep.tar.gz", digest: d(21) },
    { uri: "https://registry.npmjs.org/effect/-/effect-4.0.6.tgz", digest: d(22) },
  ],
  restored_cache: [
    { namespace: "protected/o/r/device", key: hex(30), digest: d(31) },
    { namespace: "pr/o/r/7", key: hex(32), digest: d(33) },
  ],
  egress_log_digest: d(6),
  step_log_digest: d(7),
  models: [{ id: "claude-sonnet", tokens: 1200 }],
  ...over,
});

const build = (raw: unknown) => Effect.runPromise(buildStatement(raw));
const fails = (raw: unknown) => Exit.isFailure(Effect.runSyncExit(buildStatement(raw)));

type Descriptor = {
  name?: string;
  uri?: string;
  digest?: Record<string, string>;
  annotations?: Record<string, unknown>;
};
const slsa = (s: Statement) =>
  s.predicate as {
    buildDefinition: {
      externalParameters: Record<string, unknown>;
      internalParameters: { lease: Record<string, unknown> } & Record<string, unknown>;
      resolvedDependencies: Descriptor[];
    };
    runDetails: {
      builder: { id: string };
      metadata: Record<string, unknown>;
      byproducts: Descriptor[];
    };
  };
const testResult = (s: Statement) =>
  s.predicate as {
    result: string;
    configuration: Descriptor[];
    passedTests: string[];
    failedTests: string[];
  };
const named = (list: Descriptor[], name: string) => list.find((x) => x.name === name);

describe("statement builder", () => {
  it("[FD-PROV-001] takes every subject digest from the output digests passed and no field the job sandbox reports but its exit status", async () => {
    const forged = d(99);
    const raw = {
      ...input("gate", {
        commands: [
          { name: "lint", exit_status: 0, stdout: "SANDBOX-MARK" },
          { name: "unit", exit_status: 1, reported_digest: forged },
        ],
        outputs: [{ name: "dist/app.tgz", digest: d(10), sandbox_digest: forged }],
      }),
      subject: [{ name: "evil", digest: { sha256: hex(99) } }],
      sandbox: { outputs: [{ name: "evil", digest: forged }], verdict: "PASSED" },
    };
    const s = await build(raw);
    expect(s.subject).toEqual([{ name: "dist/app.tgz", digest: { sha256: hex(10) } }]);
    const text = JSON.stringify(s);
    expect(text).not.toContain(hex(99));
    expect(text).not.toContain("SANDBOX-MARK");
    expect(text).not.toContain("evil");
    // The exit status alone carries over: the failing command fails the verdict whatever the sandbox claims.
    expect(testResult(s)).toMatchObject({
      result: "FAILED",
      passedTests: ["lint"],
      failedTests: ["unit"],
    });

    const b = await build(input("build"));
    expect(b.subject.map((x) => x.digest)).toEqual([{ sha256: hex(10) }, { sha256: hex(11) }]);
  });

  it("[FD-PROV-004] produces each statement as the payload of a DSSE envelope with payload type application/vnd.in-toto+json, signed under the statement purpose", async () => {
    const envelope = await Effect.runPromise(buildEnvelope(input("build")));
    expect(envelope.payloadType).toBe("application/vnd.in-toto+json");
    expect(envelope.signatures).toEqual([]);
    const payload = Buffer.from(envelope.payload, "base64");
    expect(JSON.parse(payload.toString("utf8"))).toEqual(await build(input("build")));
    expect(JSON.parse(payload.toString("utf8"))._type).toBe(STATEMENT_TYPE);

    // The bytes the key helper signs are DSSE's pre-authentication encoding of that payload.
    const pae = Buffer.from(dssePae(DSSE_PAYLOAD_TYPE, payload)).toString("utf8");
    expect(pae).toBe(
      `DSSEv1 28 application/vnd.in-toto+json ${payload.byteLength} ${payload.toString("utf8")}`,
    );
    expect(buildProfile("production").signing_purposes).toContain(STATEMENT_SIGNING_PURPOSE);

    // A signature over the encoding verifies; one over the bare payload does not stand in for it.
    const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const alg = { name: "ECDSA", hash: "SHA-256" };
    const sig = await crypto.subtle.sign(alg, pair.privateKey, dssePae(DSSE_PAYLOAD_TYPE, payload));
    expect(
      await crypto.subtle.verify(alg, pair.publicKey, sig, dssePae(DSSE_PAYLOAD_TYPE, payload)),
    ).toBe(true);
    expect(await crypto.subtle.verify(alg, pair.publicKey, sig, payload)).toBe(false);
  });

  it("[FD-PROV-004] the device extension serves the statement operation with the envelope's bytes", async () => {
    const state: ExtensionState = {
      planeId: "plane-1",
      l1: {} as ExtensionState["l1"],
      content: new Map(),
      readable: new Set(),
      writable: new Set(),
    };
    const reply = (await Effect.runPromise(
      answerLine(state, JSON.stringify({ type: "statement", id: "s1", input: input("gate") })),
    )) as unknown as { type: string; ref: string; bytes: string };
    expect(reply).toMatchObject({ type: "statement.ok", ref: "s1" });
    const envelope = JSON.parse(Buffer.from(reply.bytes, "base64").toString("utf8"));
    expect(envelope).toEqual(await Effect.runPromise(buildEnvelope(input("gate"))));
    expect(envelope.payloadType).toBe(DSSE_PAYLOAD_TYPE);
  });

  it("[FD-PROV-005] includes the lease binding, run-definition digest, commit SHA, image digest, lockfile digest, every restored cache entry and both log digests", async () => {
    const binding = {
      execution_id: "01JDZ8Q6V3M2K9T4WXYZ5ABCDE",
      epoch: 3,
      nonce: "9f2c4e1a7b3d5f60a1b2c3d4e5f60718",
      executor_id: "mac-1",
      binding_kind: "execution-lease",
    };
    const p = slsa(await build(input("build")));
    expect(p.buildDefinition.internalParameters.lease).toEqual(binding);
    expect(p.buildDefinition.externalParameters).toMatchObject({
      run_definition_digest: d(1),
      commit_sha: COMMIT,
    });
    const deps = p.buildDefinition.resolvedDependencies;
    expect(named(deps, "commit")?.digest).toEqual({ gitCommit: COMMIT });
    expect(named(deps, "image")?.digest).toEqual({ sha256: hex(3) });
    expect(named(deps, "lockfile:pnpm-lock.yaml")?.digest).toEqual({ sha256: hex(5) });
    expect(named(deps, `cache:protected/o/r/device/${hex(30)}`)?.digest).toEqual({
      sha256: hex(31),
    });
    expect(named(deps, `cache:pr/o/r/7/${hex(32)}`)?.digest).toEqual({ sha256: hex(33) });
    expect(named(p.runDetails.byproducts, "egress-proxy-log")?.digest).toEqual({ sha256: hex(6) });
    expect(named(p.runDetails.byproducts, "step-log")?.digest).toEqual({ sha256: hex(7) });
    expect(p.runDetails.metadata).toEqual({ invocationId: binding.execution_id });
    expect(p.runDetails.builder.id).toBe("apple-container:mac-1");

    const c = testResult(await build(input("gate"))).configuration;
    expect(named(c, "lease")?.annotations).toEqual(binding);
    expect(named(c, "run-definition")?.digest).toEqual({ sha256: hex(1) });
    expect(named(c, "commit")?.digest).toEqual({ gitCommit: COMMIT });
    expect(named(c, "image")?.digest).toEqual({ sha256: hex(3) });
    expect(named(c, "lockfile:pnpm-lock.yaml")?.digest).toEqual({ sha256: hex(5) });
    expect(named(c, `cache:protected/o/r/device/${hex(30)}`)?.digest).toEqual({ sha256: hex(31) });
    expect(named(c, `cache:pr/o/r/7/${hex(32)}`)?.digest).toEqual({ sha256: hex(33) });
    expect(named(c, "egress-proxy-log")?.digest).toEqual({ sha256: hex(6) });
    expect(named(c, "step-log")?.digest).toEqual({ sha256: hex(7) });

    // A statement cannot be written without any of them.
    for (const field of ["egress_log_digest", "step_log_digest", "restored_cache", "lockfiles"]) {
      const { [field]: _, ...rest } = input("build") as Record<string, unknown>;
      expect(fails(rest)).toBe(true);
    }
    const { nonce: _, ...lease } = input("build").lease;
    expect(fails({ ...input("build"), lease })).toBe(true);
  });

  it("[FD-PROV-006] marks each resolved dependency proxy where the egress proxy hashed the bytes and lockfile otherwise", async () => {
    const deps = slsa(await build(input("build"))).buildDefinition.resolvedDependencies.filter(
      (x) => x.uri?.startsWith("https://"),
    );
    expect(deps).toEqual([
      {
        uri: "https://registry.npmjs.org/effect/-/effect-4.0.6.tgz",
        digest: { sha256: hex(20) },
        annotations: { digest_source: "proxy" },
      },
      {
        uri: "https://github.com/o/dep.tar.gz",
        digest: { sha256: hex(21) },
        annotations: { digest_source: "lockfile" },
      },
    ]);
    const gate = testResult(await build(input("gate"))).configuration.filter((x) =>
      x.uri?.startsWith("https://"),
    );
    expect(gate.map((x) => x.annotations?.digest_source)).toEqual(["proxy", "lockfile"]);
  });

  it("[FD-PROV-007] uses the SLSA provenance v1 predicate for build recipes and the in-toto test-result predicate for gate recipes", async () => {
    const b = await build(input("build"));
    expect(b.predicateType).toBe("https://slsa.dev/provenance/v1");
    expect(b.predicateType).toBe(SLSA_PROVENANCE_V1);
    expect(slsa(b).buildDefinition.externalParameters).toMatchObject({
      run: "build-image",
      repository: "o/r",
    });

    const g = await build(input("gate"));
    expect(g.predicateType).toBe("https://in-toto.io/attestation/test-result/v0.1");
    expect(g.predicateType).toBe(TEST_RESULT_V0_1);
    expect(testResult(g)).toMatchObject({
      result: "PASSED",
      passedTests: ["lint", "unit"],
      failedTests: [],
    });
    expect(testResult(await build(input("gate", { outcome: "failure" }))).result).toBe("FAILED");
  });

  it("[FD-PROV-043] writes only digests, ids, names, timestamps and verdicts, never source, file contents, diffs, logs, prompts or completions", async () => {
    for (const kind of ["build", "gate"] as const)
      expect(disallowedContent(await build(input(kind)))).toBeNull();

    const log = "npm ERR! code ELIFECYCLE\nnpm ERR! errno 1";
    const diff = "--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n-const a = 1;\n+const a = 2;";
    const prompt = "Review this pull request and list every bug";
    expect(fails(input("build", { outputs: [{ name: log, digest: d(10) }] }))).toBe(true);
    expect(fails(input("gate", { commands: [{ name: diff, exit_status: 0 }] }))).toBe(true);
    expect(fails(input("build", { models: [{ id: prompt, tokens: 1 }] }))).toBe(true);
    expect(fails(input("build", { outputs: [{ name: "x", digest: "contents of x" }] }))).toBe(true);
    expect(fails(input("build", { outcome: "the tests passed except one" }))).toBe(true);

    expect(disallowedContent({ a: [{ b: "sha256:00" }, { c: "line one\nline two" }] })).toBe(
      "$.a[1].c",
    );
    expect(disallowedContent({ completion: prompt })).toBe("$.completion");
  });
});
