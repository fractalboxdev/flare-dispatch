import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { runSubcommand } from "./main.ts";
import { Output } from "./outcome.ts";
import { ARTIFACT, makeVerifyFixture, type VerifyFixture } from "./verify.test-support.ts";
import {
  verifyArtifact,
  type VerifyInput,
  type VerifyPass,
  type VerifyRejected,
} from "./verify.ts";

let f: VerifyFixture;
beforeAll(async () => {
  f = await makeVerifyFixture();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/** The verifier's rejection; a pass fails the test. */
const rejection = (input: VerifyInput): Promise<VerifyRejected> =>
  Effect.runPromise(Effect.flip(verifyArtifact(input)));

const passed = (input: VerifyInput): Promise<VerifyPass> =>
  Effect.runPromise(verifyArtifact(input));

/** Runs `fd-verify` with `args` as its executable does, capturing stdout and stderr. */
const fdVerify = async (args: readonly string[]) => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exit = await Effect.runPromise(
    runSubcommand("verify", args).pipe(
      Effect.provide(
        Layer.merge(
          Layer.succeed(Output)({
            stdout: (t) => Effect.sync(() => void stdout.push(t)),
            stderr: (t) => Effect.sync(() => void stderr.push(t)),
          }),
          NodeServices.layer,
        ),
      ),
    ) as Effect.Effect<number>,
  );
  return { exit, stdout, stderr };
};

/** Writes the verifier's inputs to a temporary directory and answers the `fd verify` arguments naming them. */
const files = (input: VerifyInput, artifact: Uint8Array = ARTIFACT) => {
  const dir = mkdtempSync(join(tmpdir(), "fd-verify-"));
  const write = (name: string, value: unknown) => {
    const path = join(dir, name);
    writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
    return path;
  };
  const artifactPath = join(dir, "widget.tgz");
  writeFileSync(artifactPath, artifact);
  return [
    artifactPath,
    "--policy",
    write("policy.json", input.policy),
    "--bundle",
    write("bundle.json", input.bundle),
    "--root-key",
    write("root.json", input.rootKey),
    "--class",
    input.artifactClass,
  ];
};

describe("fd verify", () => {
  it("[FD-IFC-071] exits 0 for a passing artifact, with no network access", async () => {
    const network = vi.fn(() => {
      throw new Error("fd verify opened a network connection");
    });
    vi.stubGlobal("fetch", network);
    const input = await f.input(await f.bundleOf(await f.deviceEnvelope()));
    const result = await fdVerify([...files(input), "--json"]);
    expect(result.stderr).toEqual([]);
    expect(result.exit).toBe(0);
    expect(JSON.parse(result.stdout[0]!)).toMatchObject({
      artifact_digest: `sha256:${f.artifactHex}`,
      artifact_class: "package",
      tier: "platform",
      policy_version: "v1",
    });
    expect(network).not.toHaveBeenCalled();
  });

  it("[FD-IFC-071] exits non-zero when the verifier rejects the artifact", async () => {
    const input = await f.input(await f.bundleOf(await f.deviceEnvelope()));
    const result = await fdVerify([
      ...files(input, new TextEncoder().encode("other bytes")),
      "--json",
    ]);
    expect(result.exit).toBe(1);
    expect(JSON.parse(result.stdout[0]!)).toMatchObject({
      error: "rejected",
      reason: "subject-digest",
    });
  });

  it("[FD-IFC-071] exits non-zero, never 0, when an input is unreadable", async () => {
    const input = await f.input(await f.bundleOf(await f.deviceEnvelope()));
    const args = files(input);
    args[4] = join(tmpdir(), "no-such-bundle.json");
    const result = await fdVerify(args);
    expect(result.exit).toBe(2);
    expect(result.stderr.join("\n")).toContain("not a readable file");
  });
});

describe("subject digest", () => {
  it("[FD-PROV-058] rejects a statement whose subject digest differs from the artifact's digest", async () => {
    const bundle = await f.bundleOf(await f.deviceEnvelope({ subjectHex: "b".repeat(64) }));
    expect((await rejection(await f.input(bundle))).reason).toBe("subject-digest");
    // The same artifact, digested as named, passes.
    const named = await f.bundleOf(await f.deviceEnvelope());
    expect((await passed(await f.input(named))).tier).toBe("platform");
  });

  it("[FD-PROV-058] checks the digest of the artifact being verified, not the bundle's own claim", async () => {
    const bundle = await f.bundleOf(await f.deviceEnvelope());
    const e = await rejection(
      await f.input(bundle, { artifactDigest: `sha256:${"c".repeat(64)}` }),
    );
    expect(e.reason).toBe("subject-digest");
  });
});

describe("required tier", () => {
  it("[FD-PROV-059] rejects an artifact whose assigned tier is below the policy's required tier for its class", async () => {
    // A cloud `platform` statement meets `package` (platform) but not `release` (reproduced).
    const bundle = await f.bundleOf(await f.cloudEnvelope(), { deviceKey: null });
    expect((await passed(await f.input(bundle, { artifactClass: "package" }))).tier).toBe(
      "platform",
    );
    const e = await rejection(await f.input(bundle, { artifactClass: "release" }));
    expect(e.reason).toBe("tier");
    expect(e.message).toContain("release requires reproduced");
  });

  it("[FD-PROV-059] takes the required tier from the signed policy", async () => {
    const bundle = await f.bundleOf(await f.cloudEnvelope(), { deviceKey: null });
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
  it("[FD-PROV-060] assigns no tier above device-signed to a statement bound by a registration", async () => {
    const bundle = await f.bundleOf(await f.deviceEnvelope({ binding: "registration" }));
    const pass = await passed(await f.input(bundle, { artifactClass: "verdict" }));
    expect(pass.tier).toBe("device-signed");
    expect(pass.statements[0]!.tier).toBe("device-signed");
    // `platform` is out of reach, so a class that requires it rejects the artifact.
    const e = await rejection(await f.input(bundle, { artifactClass: "pr-artifact" }));
    expect(e.reason).toBe("tier");
    expect(e.message).toContain("pr-artifact requires platform; the bundle reaches device-signed");
  });

  it("[FD-PROV-060] keeps a registration-bound statement out of a reproduced pair", async () => {
    const bundle = await f.reproducedBundle({
      device: await f.deviceEnvelope({ binding: "registration" }),
    });
    const e = await rejection(await f.input(bundle, { artifactClass: "release" }));
    expect(e.reason).toBe("tier");
    expect(e.message).toContain("reproduced needs two platform statements");
  });
});
