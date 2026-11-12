// The offline verifier against statements the control plane's own provenance code writes, countersigns and logs: one
// negative test for each verifier rejection of specs/provenance.md FD-PROV-053 to FD-PROV-061 (FD-PROV-072), and the
// `fd-verify` executable run as a process with every network path closed (FD-IFC-071).
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  verifyArtifact,
  type VerifyInput,
  type VerifyRejected,
} from "@fractalboxdev/flare-dispatch-fd/verify";
import {
  ARTIFACT,
  DAY,
  es256Key,
  makeVerifyFixture,
  T0,
  T1,
  witnessKey,
  type VerifyFixture,
} from "@fractalboxdev/flare-dispatch-fd/verify-test-support";
import type { DsseEnvelope } from "@fractalboxdev/flare-dispatch-cache";
import { Effect } from "effect";
import { beforeAll, describe, expect, it } from "vitest";

let f: VerifyFixture;
beforeAll(async () => {
  f = await makeVerifyFixture();
});

const rejection = (input: VerifyInput): Promise<VerifyRejected> =>
  Effect.runPromise(Effect.flip(verifyArtifact(input)));
const passed = (input: VerifyInput) => Effect.runPromise(verifyArtifact(input));

describe("policy signature", () => {
  it("[FD-PROV-053] rejects every statement checked against a policy the pinned root key did not sign", async () => {
    const bundle = await f.bundleOf(await f.deviceEnvelope());
    expect((await passed(await f.input(bundle))).tier).toBe("platform");
    const impostor = await es256Key("policy-root");
    const policy = await f.signPolicy(f.policyDoc(), impostor.key);
    const e = await rejection(await f.input(bundle, { policy }));
    expect(e.reason).toBe("policy-signature");
    const cloud = await f.bundleOf(await f.cloudEnvelope(), { deviceKey: null });
    expect((await rejection(await f.input(cloud, { policy }))).reason).toBe("policy-signature");
  });

  it("[FD-PROV-053] rejects a policy whose payload changed after the root key signed it", async () => {
    const signed = await f.signPolicy(f.policyDoc());
    const loosened = await f.signPolicy(
      f.policyDoc({
        required_tiers: { ...f.policyDoc().required_tiers, release: "device-signed" },
      }),
    );
    const policy = { ...signed, payload: loosened.payload };
    const bundle = await f.bundleOf(await f.deviceEnvelope());
    expect((await rejection(await f.input(bundle, { policy }))).reason).toBe("policy-signature");
  });
});

describe("inclusion proof", () => {
  it("[FD-PROV-054] rejects a statement the log does not hold", async () => {
    const logged = await f.deviceEnvelope();
    const bundle = await f.bundleOf(logged);
    const other = await f.deviceEnvelope();
    const unlogged = { ...bundle, statements: [{ ...bundle.statements[0]!, envelope: other }] };
    const e = await rejection(await f.input(unlogged));
    expect(e.reason).toBe("inclusion-proof");
  });

  it("[FD-PROV-054] rejects an inclusion proof that does not verify against the checkpoint", async () => {
    const [a, b] = [await f.deviceEnvelope(), await f.deviceEnvelope()];
    const [proofA] = await f.privateLog([a, b]);
    const bundle = {
      statements: [{ envelope: a, device_key: f.device.jwk, log_entry: { ...proofA!, index: 1 } }],
    };
    expect((await rejection(await f.input(bundle))).reason).toBe("inclusion-proof");
    const truncated = {
      statements: [
        { envelope: a, device_key: f.device.jwk, log_entry: { ...proofA!, inclusion_proof: [] } },
      ],
    };
    expect((await rejection(await f.input(truncated))).reason).toBe("inclusion-proof");
  });

  it("[FD-PROV-054] rejects a checkpoint no log key in the policy signs", async () => {
    const rogue = await es256Key("log-1");
    const bundle = await f.bundleOf(await f.deviceEnvelope());
    const [proof] = await f.privateLog([bundle.statements[0]!.envelope], { logKey: rogue.key });
    const forged = { statements: [{ ...bundle.statements[0]!, log_entry: proof! }] };
    const e = await rejection(await f.input(forged));
    expect(e.reason).toBe("inclusion-proof");
    expect(e.message).toContain("no private log key");
  });
});

describe("Rekor inclusion proof", () => {
  /** The device statement with only its countersignature: the device signature stripped. */
  const stripped = (envelope: DsseEnvelope): DsseEnvelope => ({
    ...envelope,
    signatures: envelope.signatures.filter((s) => s.keyid === "prov-1"),
  });

  it("[FD-PROV-054] accepts a statement whose Rekor entry body is the leaf, with no witness cosignature", async () => {
    const device = await passed(await f.input(await f.rekorBundleOf(await f.deviceEnvelope())));
    expect(device.tier).toBe("platform");
    expect(device.statements[0]).toMatchObject({ builder: "device", log: "rekor" });
    const cloud = await passed(
      await f.input(await f.rekorBundleOf(await f.cloudEnvelope(), { deviceKey: null })),
    );
    expect(cloud.statements[0]).toMatchObject({ builder: "cloud", log: "rekor" });
  });

  it("[FD-PROV-054] rejects a Rekor checkpoint whose signature leads with another key's hint", async () => {
    const bundle = await f.rekorBundleOf(await f.deviceEnvelope(), {
      keyHint: new Uint8Array([0, 1, 2, 3]),
    });
    const e = await rejection(await f.input(bundle));
    expect(e.reason).toBe("inclusion-proof");
    expect(e.message).toContain("no rekor log key");
    const rogue = await es256Key("rekor-1");
    const envelope = await f.deviceEnvelope();
    const [proof] = await f.rekorLog([await f.rekorBody(envelope)], { logKey: rogue.key });
    const forged = { statements: [{ envelope, device_key: f.device.jwk, log_entry: proof! }] };
    expect((await rejection(await f.input(forged))).reason).toBe("inclusion-proof");
  });

  it("[FD-PROV-054] rejects a Rekor entry body whose payload hash is not the envelope's", async () => {
    const envelope = await f.deviceEnvelope();
    const body = await f.rekorBody(envelope, { payloadHash: "d".repeat(64) });
    const e = await rejection(await f.input(await f.rekorBundleOf(envelope, { body })));
    expect(e.reason).toBe("inclusion-proof");
  });

  it("[FD-PROV-054] rejects a Rekor entry body that omits or adds a signature", async () => {
    const envelope = await f.deviceEnvelope();
    const sigs = envelope.signatures.map((s) => s.sig);
    const missing = await f.rekorBody(envelope, { signatures: sigs.slice(1) });
    expect(
      (await rejection(await f.input(await f.rekorBundleOf(envelope, { body: missing })))).reason,
    ).toBe("inclusion-proof");
    const other = (await f.deviceEnvelope()).signatures[0]!.sig;
    const added = await f.rekorBody(envelope, { signatures: [...sigs, other] });
    expect(
      (await rejection(await f.input(await f.rekorBundleOf(envelope, { body: added })))).reason,
    ).toBe("inclusion-proof");
  });

  it("[FD-PROV-054] rejects a Rekor-logged device statement with its device signature stripped", async () => {
    const envelope = await f.deviceEnvelope();
    const body = await f.rekorBody(envelope);
    const e = await rejection(
      await f.input(await f.rekorBundleOf(stripped(envelope), { body, deviceKey: null })),
    );
    expect(e.reason).toBe("inclusion-proof");
  });

  it("[FD-PROV-057] treats a stripped device statement logged on its own as the device's, never as a cloud builder's", async () => {
    // The countersignature alone verifies under a provenance key, and a public log accepts the stripped envelope as
    // its own entry; its signed payload still names the device that built it.
    const envelope = stripped(await f.deviceEnvelope());
    const bundle = await f.rekorBundleOf(envelope, { deviceKey: null });
    expect((await rejection(await f.input(bundle))).reason).toBe("device-key");
    const keyed = await f.rekorBundleOf(envelope);
    expect((await rejection(await f.input(keyed))).reason).toBe("device-key");
  });
});

describe("witness cosignature", () => {
  it("[FD-PROV-055] rejects every statement proved against a private-log checkpoint no policy witness cosigned", async () => {
    const [a, b] = [await f.deviceEnvelope(), await f.cloudEnvelope()];
    const proofs = await f.privateLog([a, b], { cosign: false });
    const one = { statements: [{ envelope: a, device_key: f.device.jwk, log_entry: proofs[0]! }] };
    const two = { statements: [{ envelope: b, log_entry: proofs[1]! }] };
    expect((await rejection(await f.input(one))).reason).toBe("witness-cosignature");
    expect((await rejection(await f.input(two))).reason).toBe("witness-cosignature");
  });

  it("[FD-PROV-055] rejects a cosignature by a witness the policy does not name", async () => {
    const envelope = await f.deviceEnvelope();
    const [proof] = await f.privateLog([envelope], { cosign: false });
    const stranger = await witnessKey(f.witness.name);
    const body = proof!.checkpoint.slice(0, proof!.checkpoint.indexOf("\n\n") + 1);
    const checkpoint = `${proof!.checkpoint}${await stranger.cosign(body, Math.floor((T0 + 2 * DAY) / 1000))}\n`;
    const bundle = {
      statements: [{ envelope, device_key: f.device.jwk, log_entry: { ...proof!, checkpoint } }],
    };
    expect((await rejection(await f.input(bundle))).reason).toBe("witness-cosignature");
  });
});

describe("provenance key window", () => {
  it("[FD-PROV-056] rejects a countersignature by a provenance key retired before the log time", async () => {
    // prov-1 retired at T1; a statement it countersigns, logged after T1, fails on the key's window.
    const bundle = await f.bundleOf(await f.deviceEnvelope(), { time: T1 + DAY });
    const e = await rejection(await f.input(bundle));
    expect(e.reason).toBe("key-window");
    expect(e.message).toContain("prov-1");
    // Countersigned by the active key, the same log time passes.
    const current = await f.bundleOf(await f.deviceEnvelope({ provenance: f.prov2.key }), {
      time: T1 + DAY,
    });
    expect((await passed(await f.input(current))).tier).toBe("platform");
  });

  it("[FD-PROV-056] rejects a cloud-builder signature by a provenance key not yet valid at the log time", async () => {
    const bundle = await f.bundleOf(await f.cloudEnvelope({ provenance: f.prov2.key }), {
      time: T1 - DAY,
      deviceKey: null,
    });
    expect((await rejection(await f.input(bundle))).reason).toBe("key-window");
  });
});

describe("device key window", () => {
  const compromisedStatement = (time: number) =>
    Effect.promise(async () => {
      const envelope = await f.deviceEnvelope({
        signer: { ...f.compromised.key, kid: f.compromisedThumbprint },
      });
      return f.bundleOf(envelope, { time, deviceKey: f.compromised.jwk });
    });

  it("[FD-PROV-057] rejects a statement logged before its device key's registered_at", async () => {
    // The device registered at T0 + 1 day.
    const bundle = await f.bundleOf(await f.deviceEnvelope(), { time: T0 + DAY - 1 });
    expect((await rejection(await f.input(bundle))).reason).toBe("device-window");
    const at = await f.bundleOf(await f.deviceEnvelope(), { time: T0 + DAY });
    expect((await passed(await f.input(at))).tier).toBe("platform");
  });

  it("[FD-PROV-057] checks the device window of a device signature filed under a provenance key's kid", async () => {
    // A statement is a cloud builder's only when every signature verifies under a provenance key, so a device
    // signature under a retired provenance kid still faces the device registry.
    const envelope = await f.deviceEnvelope({
      signer: { ...f.compromised.key, kid: "prov-1" },
      provenance: f.prov2.key,
    });
    const bundle = await f.bundleOf(envelope, {
      time: T1 + DAY,
      deviceKey: f.compromised.jwk,
    });
    expect((await rejection(await f.input(bundle))).reason).toBe("device-window");
  });

  it("[FD-PROV-057] rejects a statement logged at or after its device key's compromised_from", async () => {
    // mac-2's key is compromised from T0 + 10 days.
    const before = await Effect.runPromise(compromisedStatement(T0 + 10 * DAY - 1));
    expect((await passed(await f.input(before))).tier).toBe("platform");
    const at = await Effect.runPromise(compromisedStatement(T0 + 10 * DAY));
    expect((await rejection(await f.input(at))).reason).toBe("device-window");
    const after = await Effect.runPromise(compromisedStatement(T0 + 15 * DAY));
    expect((await rejection(await f.input(after))).reason).toBe("device-window");
  });
});

describe("subject digest", () => {
  it("[FD-PROV-058] rejects a statement whose subject digest differs from the digest of the artifact being verified", async () => {
    const other = await f.bundleOf(await f.deviceEnvelope({ subjectHex: "b".repeat(64) }));
    expect((await rejection(await f.input(other))).reason).toBe("subject-digest");
    const bundle = await f.bundleOf(await f.deviceEnvelope());
    expect((await passed(await f.input(bundle))).tier).toBe("platform");
    // The verifier digests the artifact it holds; the bundle's own claim does not stand in for it.
    const e = await rejection(
      await f.input(bundle, { artifactDigest: `sha256:${"c".repeat(64)}` }),
    );
    expect(e.reason).toBe("subject-digest");
  });
});

describe("required tier", () => {
  it("[FD-PROV-059] rejects an artifact whose assigned tier is below the signed policy's required tier for its class", async () => {
    // A cloud `platform` statement meets `package` (platform) but not `release` (reproduced).
    const bundle = await f.bundleOf(await f.cloudEnvelope(), { deviceKey: null });
    expect((await passed(await f.input(bundle, { artifactClass: "package" }))).tier).toBe(
      "platform",
    );
    expect((await rejection(await f.input(bundle, { artifactClass: "release" }))).reason).toBe(
      "tier",
    );
    // Raising the class's requirement in the signed policy rejects the same bundle.
    const doc = f.policyDoc();
    const policy = await f.signPolicy({
      ...doc,
      required_tiers: { ...doc.required_tiers, package: "reproduced" },
    });
    const e = await rejection(await f.input(bundle, { policy, artifactClass: "package" }));
    expect(e.reason).toBe("tier");
    expect(e.message).toContain("package requires reproduced");
  });
});

describe("registration binding", () => {
  it("[FD-PROV-060] assigns a registration-bound statement no tier above device-signed", async () => {
    const bundle = await f.bundleOf(await f.deviceEnvelope({ binding: "registration" }));
    const pass = await passed(await f.input(bundle, { artifactClass: "verdict" }));
    expect(pass.tier).toBe("device-signed");
    expect(pass.statements[0]!.tier).toBe("device-signed");
    // `platform` is out of reach, so a class that requires it rejects the artifact.
    const e = await rejection(await f.input(bundle, { artifactClass: "pr-artifact" }));
    expect(e.reason).toBe("tier");
    expect(e.message).toContain("pr-artifact requires platform; the bundle reaches device-signed");
    // Nor does it make a `reproduced` pair with a cloud statement.
    const pair = await f.reproducedBundle({
      device: await f.deviceEnvelope({ binding: "registration" }),
    });
    const r = await rejection(await f.input(pair, { artifactClass: "release" }));
    expect(r.reason).toBe("tier");
    expect(r.message).toContain("reproduced needs two platform statements");
  });
});

describe("reproduced tier", () => {
  it("[FD-PROV-061] assigns reproduced to a cloud and a device statement with a logged reproduction record", async () => {
    const pass = await passed(
      await f.input(await f.reproducedBundle(), { artifactClass: "release" }),
    );
    expect(pass.tier).toBe("reproduced");
    expect(pass.statements.map((s) => s.builder).sort()).toEqual(["cloud", "device"]);
  });

  it("[FD-PROV-061] does not assign reproduced when no statement is signed by a provenance key as a cloud builder", async () => {
    const bundle = await f.reproducedBundle({ cloud: await f.deviceEnvelope() });
    const input = await f.input(
      { ...bundle, statements: bundle.statements.map((s) => ({ ...s, device_key: f.device.jwk })) },
      { artifactClass: "release" },
    );
    const e = await rejection(input);
    expect(e.reason).toBe("tier");
    expect(e.message).toContain(
      "neither statement is signed by a provenance key as a cloud builder",
    );
  });

  it("[FD-PROV-061] does not assign reproduced without a reproduction record countersigned over both envelopes", async () => {
    const stranger = await es256Key("prov-1");
    const forged = await f.reproducedBundle({
      record: (d) => f.reproductionRecord(d, stranger.key),
    });
    expect((await rejection(await f.input(forged, { artifactClass: "release" }))).reason).toBe(
      "tier",
    );
    const partial = await f.reproducedBundle({
      record: (d) => f.reproductionRecord([d[0]!, d[0]!]),
    });
    const e = await rejection(await f.input(partial, { artifactClass: "release" }));
    expect(e.message).toContain("does not name both envelope digests");
  });
});

// Each case spawns a Node process that strips types on load; under a loaded full-suite run six of them in sequence
// outlast the default 5 s test timeout.
describe("fd-verify executable", { timeout: 120_000 }, () => {
  /** Closes every network path in the child before `fd-verify` runs: `fetch`, and every socket connect. */
  const NO_NETWORK = `data:text/javascript,${encodeURIComponent(
    [
      'import net from "node:net";',
      'globalThis.fetch = () => { throw new Error("network access"); };',
      'net.Socket.prototype.connect = function () { throw new Error("network access"); };',
    ].join("\n"),
  )}`;
  const BIN = join(import.meta.dirname, "../../fd/bin/fd-verify.mjs");

  const runBin = (input: VerifyInput, artifact: Uint8Array = ARTIFACT) => {
    const dir = mkdtempSync(join(tmpdir(), "fd-verify-conf-"));
    const write = (name: string, value: unknown) => {
      const path = join(dir, name);
      writeFileSync(path, JSON.stringify(value));
      return path;
    };
    const artifactPath = join(dir, "widget.tgz");
    writeFileSync(artifactPath, artifact);
    // An async spawn keeps the test worker's event loop free while the process runs; a blocking spawn starves its
    // RPC to the runner under a loaded full-suite run.
    const child = spawn(
      process.execPath,
      [
        "--experimental-strip-types",
        "--no-warnings",
        "--import",
        NO_NETWORK,
        BIN,
        artifactPath,
        "--policy",
        write("policy.json", input.policy),
        "--bundle",
        write("bundle.json", input.bundle),
        "--root-key",
        write("root.json", input.rootKey),
        "--class",
        input.artifactClass,
        "--json",
      ],
      { timeout: 60_000 },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    return new Promise<{ status: number | null; stdout: string; stderr: string }>(
      (resolve, reject) => {
        child.on("error", reject);
        child.on("close", (status) => resolve({ status, stdout, stderr }));
      },
    );
  };

  it("[FD-IFC-071] runs the verifier procedure with no network access and exits 0 when the artifact passes", async () => {
    const result = await runBin(
      await f.input(await f.reproducedBundle(), { artifactClass: "release" }),
    );
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      tier: "reproduced",
      artifact_class: "release",
    });
  });

  it("[FD-IFC-071] exits non-zero for each verifier rejection", async () => {
    const impostor = await es256Key("policy-root");
    const bundle = await f.bundleOf(await f.deviceEnvelope());
    const cases: ReadonlyArray<readonly [string, VerifyInput, Uint8Array?]> = [
      [
        "policy-signature",
        await f.input(bundle, { policy: await f.signPolicy(f.policyDoc(), impostor.key) }),
      ],
      [
        "witness-cosignature",
        await f.input(await f.bundleOf(await f.deviceEnvelope(), { cosign: false })),
      ],
      ["key-window", await f.input(await f.bundleOf(await f.deviceEnvelope(), { time: T1 + DAY }))],
      ["device-window", await f.input(await f.bundleOf(await f.deviceEnvelope(), { time: T0 }))],
      ["subject-digest", await f.input(bundle), new TextEncoder().encode("tampered")],
      ["tier", await f.input(bundle, { artifactClass: "release" })],
    ];
    for (const [reason, input, artifact] of cases) {
      const result = await runBin(input, artifact);
      expect(result.status, reason).toBe(1);
      expect(JSON.parse(result.stdout), reason).toMatchObject({ error: "rejected", reason });
    }
  });
});
