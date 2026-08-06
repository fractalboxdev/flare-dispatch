// The two deploy probes, driven through the facade a consumer uses.
//
// Both ride `SubstrateFacade` rather than reaching into the DO directly, and
// that is the point rather than convenience: the canary then proves the gate
// holds on the *path consumer traffic takes* — admission, ticket mint, boot
// gate, fence — not merely that the DO class has the right fields. A canary
// that bypassed the facade could pass on a build whose facade was broken.
//
// Structural dependency on the contract type, so both run against a fake in
// run.test.ts and against the real entrypoint in production.
import type {
  ExecOutcome,
  SubstrateFacade,
  SubstrateRecipe,
  SubstrateRefusal,
} from "@fractalboxdev/flare-dispatch-substrate-contract";
import { canaryProbeScript, interpretCanary, type CanaryStatus, type CanaryVerdict } from "./probe";

/** What a probe needs from the facade — the consumer surface, nothing privileged. */
export type ProbeFacade = Pick<
  SubstrateFacade,
  "ensureSandbox" | "execUnderGrant" | "checkpoint" | "abort" | "denials"
>;

/**
 * A probe that never ran because the pool was full. Distinct from a verdict on
 * purpose: "the fleet is busy" is not evidence about the egress floor, so it is
 * neither recorded nor allowed to answer the health question. Callers retry.
 */
export type ProbeDeferred = { deferred: true; reason: string };

export type ProbeRun = ProbeDeferred | (CanaryVerdict & { deferred?: false });

export const isDeferred = (run: ProbeRun): run is ProbeDeferred => run.deferred === true;

/** The canary's sandbox key. Fixed, so concurrent probes serialize in one DO. */
export const CANARY_KEY = "canary";
/** The dogfood's sandbox key. Separate DO — a probe must not disturb the other. */
export const DOGFOOD_KEY = "dogfood";

/** A minute is generous for two curl calls and leaves room for a cold boot. */
const CANARY_TIMEOUT_MS = 60_000;
const DOGFOOD_TIMEOUT_MS = 120_000;

/** Enough for both PROBE lines plus a transport error; the rest stays in artifacts. */
const CANARY_TAIL_BYTES = 2_048;

/**
 * No `repo`, and that is the whole configuration: `runFence` derives no grant
 * for a repo-less recipe, so the container runs in exactly the deny-all posture
 * the class ships with. Probing under an applied grant would test the handler,
 * which the unit suite already covers — the canary exists for the state *below*
 * any grant.
 */
const CANARY_RECIPE: SubstrateRecipe = { version: 0 };

function refusalText(refusal: SubstrateRefusal): string {
  return refusal.kind === "admission-refused"
    ? `pool ${refusal.pool} is at ${refusal.poolBusy}/${refusal.cap}`
    : `${refusal.kind}: ${"reason" in refusal ? refusal.reason : JSON.stringify(refusal)}`;
}

const isAdmissionRefusal = (outcome: { ok: false; refusal: SubstrateRefusal }): boolean =>
  outcome.refusal.kind === "admission-refused";

/**
 * Run the SDK-pin canary (ADR-0011): one command in a live container, with no
 * grant, asserting an unlisted host comes back 520.
 *
 * The container is aborted in a `finally` rather than checkpointed — there is
 * no workspace worth snapshotting, and the slot must come back to the pool even
 * when the probe threw.
 */
export async function runCanary(
  facade: ProbeFacade,
  opts: { host: string; idempotencyKey: string },
): Promise<ProbeRun> {
  let outcome: ExecOutcome;
  try {
    outcome = await facade.execUnderGrant(CANARY_KEY, {
      recipe: CANARY_RECIPE,
      command: canaryProbeScript(opts.host),
      idempotencyKey: opts.idempotencyKey,
      logPath: "canary.log",
      timeoutMs: CANARY_TIMEOUT_MS,
      tailBytes: CANARY_TAIL_BYTES,
    });
  } finally {
    await facade.abort(CANARY_KEY).catch(() => undefined);
  }

  if (!outcome.ok) {
    if (isAdmissionRefusal(outcome))
      return { deferred: true, reason: refusalText(outcome.refusal) };
    // Every other refusal means the probe could not observe the invariant.
    // Reporting it as a failure would raise a breach alarm for a boot problem.
    return {
      status: "inconclusive",
      evidence: `canary could not run — ${refusalText(outcome.refusal)}`,
    };
  }

  const verdict = interpretCanary({
    exitCode: outcome.receipt.exitCode,
    output: outcome.receipt.tail,
  });
  return { ...verdict, evidence: `${verdict.evidence}; ${await captureNote(facade, opts.host)}` };
}

/**
 * Whether the 520 the probe saw also became a `sub_denials` row — the capture
 * path in `outbound-proxy.ts`, observed on real traffic rather than on a unit
 * fake. Before HTTPS interception was wired an unlisted HTTPS host died at the
 * network layer, so this row could not exist for the scheme every grant is
 * written in; that it does now is the other half of #72's acceptance.
 *
 * **Reported, never gating.** The write is fire-and-forget on `waitUntil`
 * (`SubstrateContainerProxy.fetch`), so its visibility here is a race the probe
 * does not control — turning it into a pass/fail would make a deploy gate flap
 * on write timing. The 520 itself is the load-bearing evidence: only
 * `ContainerProxy.fetch` produces one, so an HTTPS 520 already proves the proxy
 * saw the request. This line says whether the audit trail kept up.
 */
async function captureNote(facade: ProbeFacade, host: string): Promise<string> {
  let rows: readonly { host: string; reason: string }[];
  try {
    rows = await facade.denials(CANARY_KEY);
  } catch (err) {
    return `denial capture unread (${err instanceof Error ? err.message : "read failed"})`;
  }
  const captured = rows.find((row) => row.host === host);
  return captured
    ? `denial captured for ${host} ("${captured.reason}")`
    : `no denial row for ${host} yet — the capture path recorded nothing, or the waitUntil write had not landed`;
}

export type DogfoodStep = { step: string; ok: boolean; detail: string };

export type DogfoodRun =
  | ProbeDeferred
  | (CanaryVerdict & { deferred?: false; steps: DogfoodStep[] });

/** Printed last by the dogfood command; its absence means the clone or the shell failed. */
export const DOGFOOD_MARKER = "DOGFOOD-OK";

/**
 * Reads the tree the clone produced and says so. `git rev-parse` proves the
 * checkout is a real repository rather than an empty directory the wipe left
 * behind — which is the failure a bare `ls` would report as success.
 */
export const DOGFOOD_COMMAND = `set -e
git rev-parse HEAD
ls -1 | head -5
echo ${DOGFOOD_MARKER}
`;

/**
 * The scratch-consumer round trip: ensure → exec → exec again (same
 * idempotency key) → checkpoint → abort, against a real container and a real
 * public clone.
 *
 * The repeated exec is not padding. At-least-once delivery is the correctness
 * backbone the whole facade rests on (ADR-0003), and `deduped: true` on the
 * second call is the only end-to-end evidence that a retried durable step joins
 * the first run instead of running the command twice.
 */
export async function runDogfood(
  facade: ProbeFacade,
  opts: { recipe: SubstrateRecipe; idempotencyKey: string },
): Promise<DogfoodRun> {
  const steps: DogfoodStep[] = [];
  const push = (step: string, ok: boolean, detail: string): void => {
    steps.push({ step, ok, detail });
  };

  try {
    const ensured = await facade.ensureSandbox(DOGFOOD_KEY, opts.recipe, { mode: "refuse" });
    if (!ensured.ok) {
      if (isAdmissionRefusal(ensured))
        return { deferred: true, reason: refusalText(ensured.refusal) };
      push("ensure", false, refusalText(ensured.refusal));
      return verdictFor(steps);
    }
    push("ensure", true, `generation=${ensured.generation} rebuilt=${ensured.rebuilt}`);

    const first = await facade.execUnderGrant(DOGFOOD_KEY, {
      recipe: opts.recipe,
      command: DOGFOOD_COMMAND,
      idempotencyKey: opts.idempotencyKey,
      logPath: "dogfood.log",
      timeoutMs: DOGFOOD_TIMEOUT_MS,
    });
    if (!first.ok) {
      if (isAdmissionRefusal(first)) return { deferred: true, reason: refusalText(first.refusal) };
      push("exec", false, refusalText(first.refusal));
      return verdictFor(steps);
    }
    const cloned = first.receipt.tail.includes(DOGFOOD_MARKER);
    push(
      "exec",
      first.receipt.exitCode === 0 && cloned,
      `exit=${first.receipt.exitCode} granted=[${first.granted.join(" ")}] killed=${first.killed}` +
        (cloned ? "" : ` — output never printed ${DOGFOOD_MARKER}`),
    );

    // Same key, second call: the receipt must be replayed, not re-earned.
    const replay = await facade.execUnderGrant(DOGFOOD_KEY, {
      recipe: opts.recipe,
      command: DOGFOOD_COMMAND,
      idempotencyKey: opts.idempotencyKey,
      logPath: "dogfood.log",
      timeoutMs: DOGFOOD_TIMEOUT_MS,
    });
    push(
      "exec-dedupe",
      replay.ok && replay.receipt.deduped,
      replay.ok
        ? `deduped=${replay.receipt.deduped} rebuilt=${replay.ensured.rebuilt}`
        : refusalText(replay.refusal),
    );

    const checkpointed = await facade.checkpoint(DOGFOOD_KEY, "final");
    push(
      "checkpoint",
      checkpointed.ok,
      checkpointed.ok ? "snapshot taken, slot released" : refusalText(checkpointed.refusal),
    );

    return verdictFor(steps);
  } finally {
    // The off-switch is idempotent and never refuses, so it runs even after a
    // checkpoint already stopped the container — that idempotence is itself
    // part of what the round trip claims.
    await facade.abort(DOGFOOD_KEY).catch(() => undefined);
  }
}

function verdictFor(steps: DogfoodStep[]): CanaryVerdict & { steps: DogfoodStep[] } {
  const broken = steps.filter((s) => !s.ok);
  const status: CanaryStatus = broken.length === 0 ? "passed" : "failed";
  const evidence =
    broken.length === 0
      ? `facade round trip clean: ${steps.map((s) => s.step).join(" → ")}`
      : broken.map((s) => `${s.step}: ${s.detail}`).join("; ");
  return { status, evidence, steps };
}
