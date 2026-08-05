import { describe, expect, it } from "vitest";
import type { ApprovalAttestation } from "@fractalboxdev/flare-dispatch-substrate-contract";
import {
  checkApprovalFloor,
  commandRequiresApproval,
  sha256Hex,
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
