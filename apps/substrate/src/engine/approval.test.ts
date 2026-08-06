import { describe, expect, it } from "vitest";
import type { ApprovalAttestation } from "@fractalboxdev/flare-dispatch-substrate-contract";
import {
  attestationUseKey,
  checkApprovalFloor,
  commandRequiresApproval,
  decideAttestationUse,
  sha256Hex,
  type AttestationUse,
} from "./approval";

const attest = async (
  command: string,
  over: Partial<ApprovalAttestation> = {},
): Promise<ApprovalAttestation> => ({
  taskId: "7",
  ordinal: 3,
  commandSha256: await sha256Hex(command),
  approvedBy: "U0HUMAN",
  approvedAt: 1_700_000_000_000,
  ...over,
});

describe("commandRequiresApproval — the floor", () => {
  it("matches every command class the ADR names", () => {
    expect(commandRequiresApproval("git push origin main")).toBe("git push");
    expect(commandRequiresApproval("git -C /workspace push --force")).toBe("git push");
    expect(commandRequiresApproval("wrangler deploy --env prod")).toBe(
      "wrangler deploy/secret/d1",
    );
    expect(commandRequiresApproval("wrangler secret put TOKEN")).toBe(
      "wrangler deploy/secret/d1",
    );
    expect(commandRequiresApproval("terraform apply -auto-approve")).toBe("terraform apply");
    expect(commandRequiresApproval("kubectl delete pod x")).toBe("kubectl apply/delete");
    expect(commandRequiresApproval("npm publish --access public")).toBe("package publish");
    expect(commandRequiresApproval("cargo publish")).toBe("package publish");
    expect(commandRequiresApproval("gh release create v1.0.0")).toBe("gh release");
  });

  it("does not reach across a statement boundary", () => {
    // `git` in one statement must not combine with a verb in the next —
    // `git log && terraform plan` is two safe commands, not one dangerous one.
    expect(commandRequiresApproval("git log && echo push")).toBeUndefined();
    expect(commandRequiresApproval("git status; wrangler tail")).toBeUndefined();
  });

  it("leaves ordinary task work alone", () => {
    for (const safe of [
      "pnpm install",
      "pnpm test",
      "git clone https://github.com/acme/widget",
      "git commit -m 'wip'",
      "wrangler tail",
      "kubectl get pods",
      "cargo build",
    ])
      expect(commandRequiresApproval(safe)).toBeUndefined();
  });
});

describe("checkApprovalFloor — the gate at exec", () => {
  it("lets a non-floor command through with no attestation", async () => {
    expect(await checkApprovalFloor("pnpm test", undefined)).toBeUndefined();
  });

  it("refuses a floor command with no attestation, naming the rule", async () => {
    const refusal = await checkApprovalFloor("git push origin main", undefined);
    expect(refusal).toEqual({ kind: "approval-required", rule: "git push" });
  });

  it("admits a floor command whose attestation binds to the exact command", async () => {
    const command = "git push origin main";
    expect(await checkApprovalFloor(command, await attest(command))).toBeUndefined();
  });

  it("refuses an attestation issued for a different command — no replay", async () => {
    // An approval clicked for step 3's push cannot be replayed onto a
    // different push at step 7 (the (taskId, ordinal) scope is the consumer's
    // half; the command hash is the substrate's).
    const refusal = await checkApprovalFloor(
      "git push origin main --force",
      await attest("git push origin main"),
    );
    expect(refusal).toMatchObject({ kind: "attestation-rejected" });
  });

  it("refuses an attestation with no approver or a bogus ordinal", async () => {
    const command = "git push";
    expect(
      await checkApprovalFloor(command, await attest(command, { approvedBy: "" })),
    ).toMatchObject({ kind: "attestation-rejected" });
    expect(
      await checkApprovalFloor(command, await attest(command, { ordinal: -1 })),
    ).toMatchObject({ kind: "attestation-rejected" });
  });

  it("accepts an uppercase hash spelling — hex case is not a semantic", async () => {
    const command = "git push";
    const a = await attest(command);
    expect(
      await checkApprovalFloor(command, { ...a, commandSha256: a.commandSha256.toUpperCase() }),
    ).toBeUndefined();
  });
});

describe("decideAttestationUse — one approval, one step (ADR-0007)", () => {
  const NOW = 1_700_000_000_000;

  const used = (over: Partial<AttestationUse> = {}): AttestationUse => ({
    commandSha256: "a".repeat(64),
    idempotencyKey: "k1",
    usedAt: NOW - 1_000,
    ...over,
  });

  it("claims an unspent ordinal", async () => {
    const command = "git push origin main";
    const a = await attest(command);
    const decision = decideAttestationUse(a, "k1", undefined, NOW);
    expect(decision).toEqual({
      ok: true,
      claim: { commandSha256: a.commandSha256, idempotencyKey: "k1", usedAt: NOW },
    });
  });

  it("refuses the same approval under a fresh idempotency key", async () => {
    // The whole point: `git push origin main` hashes the same every time, so
    // the command binding alone would let one human decision authorise a
    // second push. The ordinal is the unit of authority.
    const command = "git push origin main";
    const a = await attest(command);
    expect(
      decideAttestationUse(a, "k2", used({ commandSha256: a.commandSha256 }), NOW),
    ).toEqual({
      ok: false,
      refusal: {
        kind: "attestation-rejected",
        reason: "approval for this step was already used",
      },
    });
  });

  it("lets the same durable step retry — at-least-once must not become at-most-once", async () => {
    const command = "git push origin main";
    const a = await attest(command);
    const recorded = used({ commandSha256: a.commandSha256, idempotencyKey: "k1" });
    // The claim returns the ORIGINAL record: a retry must not push `usedAt`
    // forward and quietly extend the life of an approval.
    expect(decideAttestationUse(a, "k1", recorded, NOW)).toEqual({ ok: true, claim: recorded });
  });

  it("refuses a retry that mutated the command under the same key", async () => {
    const a = await attest("git push origin main --force");
    expect(
      decideAttestationUse(a, "k1", used({ commandSha256: "b".repeat(64) }), NOW),
    ).toEqual({
      ok: false,
      refusal: {
        kind: "attestation-rejected",
        reason: "approval for this step was used for a different command",
      },
    });
  });

  it("compares hashes case-insensitively, as the floor check does", async () => {
    const command = "git push origin main";
    const a = await attest(command);
    const recorded = used({ commandSha256: a.commandSha256, idempotencyKey: "k1" });
    expect(
      decideAttestationUse(
        { ...a, commandSha256: a.commandSha256.toUpperCase() },
        "k1",
        recorded,
        NOW,
      ),
    ).toEqual({ ok: true, claim: recorded });
  });
});

describe("attestationUseKey — the pair cannot collide", () => {
  it("puts the integer ordinal first so a colon-bearing taskId stays whole", () => {
    // fractalbot's task ids are colon-joined. `{taskId: "a:1", ordinal: 2}` and
    // `{taskId: "a", ordinal: 12}` would share a key if the pair were the other
    // way round, and one task's approval would satisfy another's step.
    expect(attestationUseKey({ taskId: "a:1", ordinal: 2 })).toBe("2:a:1");
    expect(attestationUseKey({ taskId: "a", ordinal: 12 })).toBe("12:a");
    expect(attestationUseKey({ taskId: "a:1", ordinal: 2 })).not.toBe(
      attestationUseKey({ taskId: "a", ordinal: 12 }),
    );
  });
});
