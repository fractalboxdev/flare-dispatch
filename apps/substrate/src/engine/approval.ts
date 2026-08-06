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
//
// The floor check binds an approval to one command *text*; single-use
// bookkeeping (`decideAttestationUse` below) binds it to one *step*. Both are
// needed: the hash stops an approval clicked for `pnpm test` being replayed onto
// `git push`, and the (taskId, ordinal) record stops the approval for step 3's
// `git push` being replayed as step 3 again under a fresh idempotency key.
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

// ---------------------------------------------------------------------------
// Single-use bookkeeping (ADR-0007)
// ---------------------------------------------------------------------------

/** One recorded consumption of an approval, keyed by its (taskId, ordinal). */
export type AttestationUse = {
  /** Lowercase hex SHA-256 of the command the approval was spent on. */
  commandSha256: string;
  /** The durable step that spent it. A retry of THAT step may spend it again. */
  idempotencyKey: string;
  usedAt: number;
};

/**
 * Unambiguous identifier for one (taskId, ordinal) pair — the caller namespaces
 * it into its own storage.
 *
 * The ordinal comes first and is a validated non-negative integer, so the
 * segment after it is the whole taskId however many colons a consumer's task id
 * happens to contain (fractalbot's keys are colon-joined). Ordering the pair the
 * other way round would let `{taskId: "a:1", ordinal: 2}` and
 * `{taskId: "a", ordinal: 12}` collide on one key.
 */
export function attestationUseKey(
  attestation: Pick<ApprovalAttestation, "taskId" | "ordinal">,
): string {
  return `${attestation.ordinal}:${attestation.taskId}`;
}

export type AttestationUseDecision =
  | { ok: true; claim: AttestationUse }
  | { ok: false; refusal: AttestationRejected };

/**
 * Decide whether an approval may be spent, given what this execution
 * environment has already recorded against its (taskId, ordinal).
 *
 * An approval authorises one irreversible step, not a command string that may
 * be run again — so the first use claims the pair, and a second use is refused
 * even though the command hash still matches. The one exception is the retry
 * that ADR-0003 requires to work: a durable step is at-least-once, so the same
 * `idempotencyKey` spending the same command is the *same* use arriving twice
 * and is allowed through to the receipt dedupe below it. Anything else — a new
 * idempotency key, or the same key carrying a mutated command — is a replay.
 *
 * Scope is the DO that holds the record, i.e. one (consumer, sandbox key)
 * execution environment. That is the scope an approval is issued for; a
 * consumer that re-keys its sandbox mints a new approval flow with it, and the
 * container never reaches this path at all (ADR-0003).
 *
 * Pure — the caller supplies the recorded row and persists the claim.
 */
export function decideAttestationUse(
  attestation: ApprovalAttestation,
  idempotencyKey: string,
  recorded: AttestationUse | undefined,
  now: number,
): AttestationUseDecision {
  const commandSha256 = attestation.commandSha256.toLowerCase();
  if (recorded === undefined)
    return { ok: true, claim: { commandSha256, idempotencyKey, usedAt: now } };

  if (recorded.idempotencyKey !== idempotencyKey)
    return {
      ok: false,
      refusal: {
        kind: "attestation-rejected",
        reason: "approval for this step was already used",
      },
    };

  if (recorded.commandSha256 !== commandSha256)
    return {
      ok: false,
      refusal: {
        kind: "attestation-rejected",
        reason: "approval for this step was used for a different command",
      },
    };

  // The same step arriving again. Re-record nothing: `usedAt` marks the first
  // spend, and a retry must not extend the life of an approval.
  return { ok: true, claim: recorded };
}
