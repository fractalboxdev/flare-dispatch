import { describe, expect, it } from "vitest";
import {
  CONTRACT_VERSION,
  isRefusalKind,
  repoSlug,
  type AdmissionRefused,
  type CredentialDescriptor,
  type ExecOutcome,
  type SubstrateFacade,
  type SubstrateRefusal,
} from "./index";

describe("contract runtime surface", () => {
  it("carries version 1 until a breaking change ships", () => {
    expect(CONTRACT_VERSION).toBe(1);
  });

  it("repoSlug renders owner/name — the form path rules assert against", () => {
    expect(repoSlug({ owner: "fractalboxdev", name: "flare-dispatch" })).toBe(
      "fractalboxdev/flare-dispatch",
    );
  });

  it("isRefusalKind narrows the union", () => {
    const refusal: SubstrateRefusal = {
      kind: "admission-refused",
      pool: "task",
      poolBusy: 4,
      cap: 4,
      retryAfterMs: 20_000,
    };
    expect(isRefusalKind(refusal, "admission-refused")).toBe(true);
    expect(isRefusalKind(refusal, "budget-stop")).toBe(false);
    if (isRefusalKind(refusal, "admission-refused")) {
      const narrowed: AdmissionRefused = refusal;
      expect(narrowed.pool).toBe("task");
    }
  });
});

describe("contract shapes stay structured-clone-safe", () => {
  // Every value crossing the facade must survive Workers RPC structured clone:
  // plain data, no methods, no class instances. structuredClone is the same
  // algorithm, so a shape that round-trips here round-trips the binding.
  it("an ExecOutcome round-trips structuredClone", () => {
    const outcome: ExecOutcome = {
      ok: true,
      receipt: { exitCode: 0, durationMs: 1200, deduped: false, tail: "ok\n", truncated: false },
      ensured: { generation: 3, rebuilt: true },
      granted: ["github.com", "codeload.github.com"],
      killed: 0,
    };
    expect(structuredClone(outcome)).toEqual(outcome);
  });

  it("a refusal round-trips structuredClone", () => {
    const refusal: SubstrateRefusal = {
      kind: "budget-stop",
      scope: "consumer",
      meter: { spentUsd: 12.5, capUsd: 10 },
    };
    expect(structuredClone(refusal)).toEqual(refusal);
  });

  it("a credential descriptor names a secret and never carries one", () => {
    // The shape is exported so a consumer can read what a profile attaches —
    // never to author one (ADR-0006). Three fields, all metadata.
    const descriptor: CredentialDescriptor = {
      secretName: "CLOUDFLARE_API_TOKEN",
      host: "api.cloudflare.com",
      headerTemplate: "authorization: Bearer {{secret}}",
    };
    expect(structuredClone(descriptor)).toEqual(descriptor);
    expect(Object.keys(descriptor)).toEqual(["secretName", "host", "headerTemplate"]);
  });
});

// Compile-time: a facade fake must satisfy the interface consumers program
// against. This is the check that catches a facade drifting from the contract.
const facadeFake: SubstrateFacade = {
  ensureSandbox: async () => ({ ok: true, generation: 1, rebuilt: true }),
  execUnderGrant: async () => ({
    ok: false,
    refusal: { kind: "ticket-rejected", reason: "no admitted ticket" },
  }),
  checkpoint: async () => ({ ok: true }),
  abort: async () => ({ ok: true, killed: 0 }),
  admissionEnqueue: async () => ({ pool: "lean", position: 0, poolBusy: 0, cap: 6 }),
  admissionAttempt: async (_key, _recipe) => ({ admitted: true, expiresAt: 0 }),
  admissionRelease: async () => {},
  denials: async () => [],
  poolStatus: async () => ({ pools: [] }),
};

describe("facade fake satisfies the contract", () => {
  it("compiles and answers", async () => {
    const ensured = await facadeFake.ensureSandbox("k", { version: 1 }, { mode: "refuse" });
    expect(ensured.ok).toBe(true);
  });
});
