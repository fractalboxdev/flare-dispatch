import {
  AlarmDeliveryFailed,
  AlarmPort,
  LeaseStore,
  ResultAcceptanceCheck,
  type Alarm,
} from "@fractalboxdev/mameko-ports";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { utf8 } from "../crypto.ts";
import {
  ACCEPTANCE_REASONS,
  DEFAULT_ATTESTATION_MAX_AGE_MS,
  PROVENANCE_QUARANTINE_ALARM,
  resultAcceptanceCheckLayer,
  StatementRecords,
  type AcceptanceReason,
  type DeviceKeyRecord,
  type IssuedExecution,
} from "./acceptance.ts";
import {
  DSSE_PAYLOAD_TYPE,
  dssePae,
  parseProvenanceKey,
  signPae,
  unsignedEnvelope,
  type DsseEnvelope,
  type ProvenanceKey,
} from "./dsse.ts";
import { statementOf, type StatementBody } from "./statement.ts";

const sha = (n: number) => `sha256:${n.toString(16).padStart(64, "0")}`;
const hex = (n: number) => n.toString(16).padStart(64, "0");
/** The test start; the check reads the live clock, which never runs behind it. */
const NOW = Date.now();
const EXECUTION = "01JDZ8Q6V3M2K9T4WXYZ5ABCDE";
const NONCE = "9f2c4e1a7b3d5f60a1b2c3d4e5f60718";
const CODE_HASH = sha(4);

const keyPair = async (kid: string) => {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const priv = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  const pub = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  return { private: parseProvenanceKey(JSON.stringify({ ...priv, kid }))!, public: pub };
};

const body = (
  kind: "build" | "gate",
  over: Partial<StatementBody["lease"]> = {},
): StatementBody => ({
  lease: {
    execution_id: EXECUTION,
    epoch: 3,
    nonce: NONCE,
    executor_id: "mac-1",
    executor_kind: "apple-container",
    binding_kind: "execution-lease",
    run: { name: "build-image", kind, definition_digest: sha(1), inputs_digest: sha(2) },
    repository: "o/r",
    ref: "refs/heads/main",
    commit_sha: "a".repeat(40),
    image_digest: sha(3),
    class: "required",
    policy_version: "p-7",
    confidentiality: "unclassified",
    ...over,
  },
  outcome: "success",
  commands: [{ name: "unit", exit_status: 0 }],
  lockfiles: [],
  fetches: [],
  locked_dependencies: [],
  restored_cache: [],
  egress_log_digest: sha(6),
  step_log_digest: sha(7),
  models: [{ id: "claude-x", tokens: 10 }],
});

const ARTIFACT = { name: "dist/app.tgz", digest: sha(10) };

/** A statement envelope signed by `key`, as the device executor submits it. */
const signed = async (key: ProvenanceKey, statementBody = body("build")): Promise<DsseEnvelope> => {
  const statement = statementOf(
    statementBody,
    [{ name: ARTIFACT.name, digest: { sha256: hex(10) } }],
    { code_hash: CODE_HASH },
  );
  const payload = utf8(JSON.stringify(statement));
  return {
    ...unsignedEnvelope(payload),
    signatures: [await signPae(key, dssePae(DSSE_PAYLOAD_TYPE, payload))],
  };
};

const submission = (over: Record<string, unknown> = {}) => ({
  execution_id: EXECUTION,
  epoch: 3,
  executor_id: "mac-1",
  artifacts: [ARTIFACT],
  ...over,
});

interface World {
  devices: Map<string, DeviceKeyRecord>;
  issued: IssuedExecution | null;
  nonce: string | null;
  consumed: boolean;
  models: string[];
  alarmFails: boolean;
}

/** The check over in-memory records, a recording executor registry and a recording alarm port. */
const harness = (world: World) => {
  const flags: Array<{ executorId: string; quarantine?: boolean }> = [];
  const alarms: Alarm[] = [];
  const records = Layer.succeed(StatementRecords, {
    deviceKey: (keyid) => Effect.succeed(world.devices.get(keyid) ?? null),
    issued: () => Effect.succeed(world.issued),
    issuedNonce: () => Effect.succeed(world.nonce),
    nonceConsumed: () => Effect.succeed(world.consumed),
    meteredModels: () => Effect.succeed(world.models),
  });
  const executors = Layer.succeed(LeaseStore, {
    register: () => Effect.void,
    get: () => Effect.succeed(null),
    list: () => Effect.succeed([]),
    heartbeat: () => Effect.succeed(true),
    progress: () => Effect.succeed(true),
    setFlags: (executorId, f) =>
      Effect.sync(() => {
        flags.push({ executorId, ...f });
        return true;
      }),
  });
  const alarmPort = Layer.succeed(AlarmPort, {
    deliver: (alarm) =>
      world.alarmFails
        ? Effect.fail(new AlarmDeliveryFailed({ reason: "sink unreachable" }))
        : Effect.sync(() => void alarms.push(alarm)),
  });
  const layer = resultAcceptanceCheckLayer().pipe(
    Layer.provide(Layer.mergeAll(records, executors, alarmPort)),
  );
  const check = (result: unknown, statement: unknown) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const port = yield* ResultAcceptanceCheck;
        return yield* port.check(result, statement);
      }).pipe(Effect.provide(layer)),
    );
  return { check, flags, alarms };
};

/** A world in which the statement `signed(device)` passes every check. */
const world = async () => {
  const device = await keyPair("device-mac-1");
  const other = await keyPair("device-mac-2");
  const state: World = {
    devices: new Map([
      [
        "device-mac-1",
        {
          executorId: "mac-1",
          publicKey: device.public,
          codeHash: CODE_HASH,
          attestedAt: NOW - 3_600_000,
          revokedAt: null,
        },
      ],
      [
        "device-mac-2",
        {
          executorId: "mac-2",
          publicKey: other.public,
          codeHash: CODE_HASH,
          attestedAt: NOW - 3_600_000,
          revokedAt: null,
        },
      ],
    ]),
    issued: { executorId: "mac-1", epoch: 3 },
    nonce: NONCE,
    consumed: false,
    models: ["claude-x"],
    alarmFails: false,
  };
  return { device, other, state };
};

const rejected = (reason: AcceptanceReason) => ({
  _tag: "rejected",
  reasonKind: `provenance: ${reason}`,
});

describe("result-acceptance check", () => {
  it("[FD-PROV-027] a bad-signature, revoked-key, wrong-executor or code-hash-mismatch rejection quarantines the signing executor and raises a page alarm", async () => {
    const cases: Array<{
      reason: AcceptanceReason;
      arrange: (
        w: Awaited<ReturnType<typeof world>>,
      ) => Promise<{ result: unknown; envelope: DsseEnvelope }>;
      signer: string;
    }> = [
      {
        // A signature that does not verify names no signer the registry can vouch for: the executor that submitted
        // the result is the one quarantined, never the executor whose key the signature names.
        reason: "bad-signature",
        arrange: async ({ device }) => {
          const envelope = await signed(device.private);
          const forged = await signed(device.private, body("build", { epoch: 4 }));
          return {
            result: submission({ executor_id: "mac-2" }),
            envelope: { ...envelope, signatures: forged.signatures },
          };
        },
        signer: "mac-2",
      },
      {
        reason: "revoked-key",
        arrange: async ({ device, state }) => {
          state.devices.set("device-mac-1", {
            ...state.devices.get("device-mac-1")!,
            revokedAt: NOW - 1,
          });
          return { result: submission(), envelope: await signed(device.private) };
        },
        signer: "mac-1",
      },
      {
        // mac-1's key signed a statement for an execution leased to mac-2: mac-1 is quarantined, not mac-2.
        reason: "wrong-executor",
        arrange: async ({ device, state }) => {
          state.issued = { executorId: "mac-2", epoch: 3 };
          return { result: submission(), envelope: await signed(device.private) };
        },
        signer: "mac-1",
      },
      {
        reason: "code-hash-mismatch",
        arrange: async ({ device, state }) => {
          state.devices.set("device-mac-1", {
            ...state.devices.get("device-mac-1")!,
            codeHash: sha(99),
          });
          return { result: submission(), envelope: await signed(device.private) };
        },
        signer: "mac-1",
      },
    ];
    for (const c of cases) {
      const w = await world();
      const { result, envelope } = await c.arrange(w);
      const h = harness(w.state);
      expect(await h.check(result, envelope), c.reason).toEqual(rejected(c.reason));
      expect(h.flags, c.reason).toEqual([{ executorId: c.signer, quarantine: true }]);
      expect(h.alarms, c.reason).toEqual([
        {
          name: PROVENANCE_QUARANTINE_ALARM,
          severity: "page",
          dedupeKey: `${PROVENANCE_QUARANTINE_ALARM}:${c.signer}`,
          state: "raised",
          detail: {
            executor_id: c.signer,
            execution_id: EXECUTION,
            reason: `provenance: ${c.reason}`,
            quarantined: true,
          },
        },
      ]);
    }
  });

  it("every other rejection, and an accepted statement, quarantines no executor and raises no alarm", async () => {
    const cases: Array<{
      expected: AcceptanceReason | "accepted";
      arrange: (
        w: Awaited<ReturnType<typeof world>>,
      ) => Promise<{ result: unknown; envelope: DsseEnvelope }>;
    }> = [
      {
        expected: "accepted",
        arrange: async ({ device }) => ({
          result: submission(),
          envelope: await signed(device.private),
        }),
      },
      {
        expected: "unknown-key",
        arrange: async () => ({
          result: submission(),
          envelope: await signed((await keyPair("stray")).private),
        }),
      },
      {
        expected: "attestation-expired",
        arrange: async ({ device, state }) => {
          state.devices.set("device-mac-1", {
            ...state.devices.get("device-mac-1")!,
            attestedAt: NOW - DEFAULT_ATTESTATION_MAX_AGE_MS - 1,
          });
          return { result: submission(), envelope: await signed(device.private) };
        },
      },
      {
        expected: "unissued-lease",
        arrange: async ({ device, state }) => {
          state.issued = null;
          return { result: submission(), envelope: await signed(device.private) };
        },
      },
      {
        expected: "stale-epoch",
        arrange: async ({ device, state }) => {
          state.issued = { executorId: "mac-1", epoch: 4 };
          return { result: submission(), envelope: await signed(device.private) };
        },
      },
      {
        expected: "nonce-mismatch",
        arrange: async ({ device, state }) => {
          state.nonce = "0".repeat(32);
          return { result: submission(), envelope: await signed(device.private) };
        },
      },
      {
        expected: "nonce-reused",
        arrange: async ({ device, state }) => {
          state.consumed = true;
          return { result: submission(), envelope: await signed(device.private) };
        },
      },
      {
        expected: "digest-mismatch",
        arrange: async ({ device }) => ({
          result: submission({ artifacts: [{ name: ARTIFACT.name, digest: sha(11) }] }),
          envelope: await signed(device.private),
        }),
      },
      {
        expected: "model-mismatch",
        arrange: async ({ device, state }) => {
          state.models = ["claude-x", "claude-y"];
          return { result: submission(), envelope: await signed(device.private) };
        },
      },
    ];
    // Together with the four quarantining reasons above, every reason of the acceptance table is exercised.
    expect(
      new Set([
        ...cases.map((c) => c.expected),
        "bad-signature",
        "revoked-key",
        "wrong-executor",
        "code-hash-mismatch",
      ]),
    ).toEqual(new Set([...ACCEPTANCE_REASONS, "accepted"]));
    for (const c of cases) {
      const w = await world();
      const { result, envelope } = await c.arrange(w);
      const h = harness(w.state);
      expect(await h.check(result, envelope), c.expected).toEqual(
        c.expected === "accepted" ? { _tag: "accepted" } : rejected(c.expected),
      );
      expect(h.flags, c.expected).toEqual([]);
      expect(h.alarms, c.expected).toEqual([]);
    }
  });

  it("[FD-PROV-027] a page alarm the port cannot deliver leaves the quarantine and the rejection in place", async () => {
    const w = await world();
    w.state.alarmFails = true;
    w.state.devices.set("device-mac-1", {
      ...w.state.devices.get("device-mac-1")!,
      revokedAt: NOW - 1,
    });
    const h = harness(w.state);
    expect(await h.check(submission(), await signed(w.device.private))).toEqual(
      rejected("revoked-key"),
    );
    expect(h.flags).toEqual([{ executorId: "mac-1", quarantine: true }]);
    expect(h.alarms).toEqual([]);
  });

  it("runs the checks in table order and stops at the first that fails", async () => {
    // Revoked, stale and with a foreign code hash: the revocation, check 3, is the reason.
    const w = await world();
    w.state.devices.set("device-mac-1", {
      ...w.state.devices.get("device-mac-1")!,
      revokedAt: NOW - 1,
      codeHash: sha(99),
    });
    w.state.issued = { executorId: "mac-1", epoch: 9 };
    const h = harness(w.state);
    expect(await h.check(submission(), await signed(w.device.private))).toEqual(
      rejected("revoked-key"),
    );
  });

  it("reads a gate statement's code hash from its builder descriptor, and rejects an undecodable submission", async () => {
    const w = await world();
    const h = harness(w.state);
    const gate = await signed(w.device.private, body("gate"));
    expect(await h.check(submission(), gate)).toEqual({ _tag: "accepted" });
    expect(await h.check({ execution_id: EXECUTION }, gate)).toEqual(rejected("unissued-lease"));
    expect(h.flags).toEqual([]);
  });
});
