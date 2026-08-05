// The irreversible-command floor, enforced at the exec surface
// (specs/adr/0007-approval-attestation-at-exec.md).
//
// A floor-matching command without an approval attestation is refused — on
// every exec path, for every consumer. Who may assert differs by consumer:
// fractalbot passes an attestation after a human approval lands (its Block Kit
// flow); dispatcher runs pre-assert in their code-reviewed definitions
// (`approvedBy: "run-definition"`) — never from dispatch inputs.
//
// Honesty clause, restated from the ADR: a regex floor is an ordinary-path
// control, trivially evaded by hostile code (base64 the command, write it to a
// script, alias git). Containment remains deny-all egress plus credential-free
// containers. The attestation exists to stop a well-behaved loop doing an
// irreversible thing without a human or a reviewed definition behind it — so
// false positives fail toward asking, which is the safe direction.
//
// The list is versioned with the substrate, never configurable per consumer.
import type {
  ApprovalAttestation,
  ApprovalRequired,
  AttestationRejected,
} from "@fractalboxdev/flare-dispatch-substrate-contract";

/**
 * `[^\n;|&]*` keeps a rule inside one shell statement — `git log && rm x`
 * must not let `git` reach across `&&` to match a later verb — while still
 * catching flag-separated spellings (`git -C repo push`, `wrangler deploy
 * --env prod`).
 */
export const APPROVAL_FLOOR: readonly { rule: string; pattern: RegExp }[] = [
  { rule: "git push", pattern: /\bgit\b[^\n;|&]*\bpush\b/ },
  { rule: "wrangler deploy/secret/d1", pattern: /\bwrangler\b[^\n;|&]*\b(deploy|secret|d1)\b/ },
  { rule: "terraform apply", pattern: /\bterraform\b[^\n;|&]*\bapply\b/ },
  { rule: "kubectl apply/delete", pattern: /\bkubectl\b[^\n;|&]*\b(apply|delete)\b/ },
  { rule: "package publish", pattern: /\b(npm|pnpm|yarn|cargo)\b[^\n;|&]*\bpublish\b/ },
  { rule: "gh release", pattern: /\bgh\b[^\n;|&]*\brelease\b/ },
];

/** The floor rule a command matches, or undefined when none does. */
export function commandRequiresApproval(command: string): string | undefined {
  return APPROVAL_FLOOR.find((f) => f.pattern.test(command))?.rule;
}

/** Lowercase hex SHA-256 — the binding between an attestation and its command. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Gate one command against the floor. Returns undefined when the command may
 * run; a typed refusal otherwise. The attestation binds to the exact command
 * text via `commandSha256` — an approval clicked for one command cannot be
 * replayed onto another, and the (taskId, ordinal) pair scopes it to one step.
 */
export async function checkApprovalFloor(
  command: string,
  attestation: ApprovalAttestation | undefined,
): Promise<ApprovalRequired | AttestationRejected | undefined> {
  const rule = commandRequiresApproval(command);
  if (rule === undefined) return undefined;
  if (attestation === undefined) return { kind: "approval-required", rule };

  if (!attestation.approvedBy)
    return { kind: "attestation-rejected", reason: "attestation names no approver" };
  if (!Number.isInteger(attestation.ordinal) || attestation.ordinal < 0)
    return { kind: "attestation-rejected", reason: "attestation ordinal is not a step ordinal" };

  const expected = await sha256Hex(command);
  if (attestation.commandSha256?.toLowerCase() !== expected)
    return {
      kind: "attestation-rejected",
      reason: "attestation was issued for a different command",
    };

  return undefined;
}
