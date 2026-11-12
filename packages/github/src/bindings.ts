// The profile bindings and control-plane rules this package owns: `installationOf`,
// the check label, the ops intents of the probes and the conclusions of a fan-out
// parent's children. The `neutral` invariant lives beside the conclusion mapping.
import type { D1Like } from "@fractalboxdev/mameko-host-cloudflare/d1";
import { insertOutboxRows } from "@fractalboxdev/mameko-host-cloudflare/d1";
import { newRow } from "@fractalboxdev/mameko-kernel";
import { Effect, Schema } from "effect";
import { InstallationDirectory, type Payloads } from "./applier.ts";
import { GithubNetworkError } from "./client.ts";
import { PARENT_CLOSED, type Verdict } from "./conclusion.ts";

/** No installation serves the row's repository, so it has no delivery key. */
export class NoInstallation extends Schema.TaggedError<NoInstallation>()("NoInstallation", {
  scopeId: Schema.String,
}) {}

/**
 * The profile's `delivery.limit_key` binding: the id of the installation that serves the row's repository, so every
 * applier call for one installation takes its permit from that installation's quota (FD-GH-056).
 */
export const installationOf = (scopeId: string) =>
  Effect.gen(function* () {
    const id = yield* (yield* InstallationDirectory).installationFor(scopeId);
    if (id === null) return yield* new NoInstallation({ scopeId });
    return String(id);
  });

export class InvalidCheckLabel extends Schema.TaggedError<InvalidCheckLabel>()(
  "InvalidCheckLabel",
  {
    label: Schema.String,
  },
) {}

const CHECK_LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;

/** A run definition's `checkLabel`, rejected at registration when it does not match the pattern (FD-GH-007). */
export const validateCheckLabel = (label: string) =>
  CHECK_LABEL.test(label) ? Effect.succeed(label) : Effect.fail(new InvalidCheckLabel({ label }));

// ---------------------------------------------------------------------------
// The `check.progress` payload

/** The `check.progress` payload the check-run applier renders the queued check run from. */
export type CheckProgressPayload = (typeof Payloads)["check.progress"]["Type"];

/** The queue-position buckets a `check.progress` payload states: `1`, `2–5`, `6–20` and `more than 20` (FD-GH-012). */
export type QueueBucket = CheckProgressPayload["bucket"];

/** The bucket of a 1-based queue position; a position below 1 reads as the head of the queue. */
export const queueBucket = (position: number): QueueBucket =>
  position <= 1 ? "1" : position <= 5 ? "2–5" : position <= 20 ? "6–20" : "more than 20";

/** What the `checkProgressPayload` binding reads of one waiting execution's execution and placement rows. */
export interface CheckProgressRequest {
  /**
   * The check run the execution owns: its name, `flare-dispatch/<run>[:<checkLabel>]`, the commit it reports on and the
   * log viewer URL; null for an execution of a run that owns no check.
   */
  readonly check: {
    readonly name: string;
    readonly headSha: string;
    readonly detailsUrl?: string;
  } | null;
  /** The execution row's `class` and `deadline_at`; both null for a request rejected before class resolution. */
  readonly execution: { readonly class: string | null; readonly deadlineAt: number | null };
  /** The placement row's 1-based position in its queue. */
  readonly queuePosition: number;
}

/**
 * The profile's `checkProgressPayload` binding: the execution's class, its queue-position bucket and its `deadline_at`
 * (FD-GH-012), and none (null) for an execution that owns no check run or has no class or `deadline_at` to state. The
 * payload carries every field in every confidentiality mode; under `confidential-compute` the applier renders the class
 * alone, reading the repository's mode at delivery (FD-GH-019).
 */
export const checkProgressPayload = (r: CheckProgressRequest): CheckProgressPayload | null =>
  r.check === null || r.execution.class === null || r.execution.deadlineAt === null
    ? null
    : {
        name: r.check.name,
        head_sha: r.check.headSha,
        ...(r.check.detailsUrl === undefined ? {} : { details_url: r.check.detailsUrl }),
        class: r.execution.class,
        bucket: queueBucket(r.queuePosition),
        deadline_at: r.execution.deadlineAt,
      };

// ---------------------------------------------------------------------------
// Ops intents

const sha256Hex = (text: string) =>
  Effect.promise(async () => {
    const hash = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
    );
    return Array.from(hash, (b) => b.toString(16).padStart(2, "0")).join("");
  });

/** `ops_class` is `required`, rank 1 in the profile's catalogue. */
const OPS_CLASS_RANK = 1;

export interface OpsIntent {
  readonly kind: "canary.push" | "delivery.redeliver";
  /** The repository the probe names, the row's scope. */
  readonly scopeId: string;
  /** The key after `ops:`: `canary:<tick time>` or `redeliver:<delivery id>`. */
  readonly key: string;
  readonly payload: unknown;
  readonly limitKey: string;
  readonly now: number;
}

/**
 * Inserts one ops intent, keyed `ops:<key>` with no execution, through mameko's outbox insert (FD-GH-089,
 * MAMEKO-OUT-056). A row already present for the key stays as it is.
 */
export const insertOpsIntent = (db: D1Like, intent: OpsIntent) =>
  Effect.gen(function* () {
    const payloadJson = JSON.stringify(intent.payload);
    const intentKey = `ops:${intent.key}`;
    yield* Effect.tryPromise({
      try: async () =>
        insertOutboxRows(db, [
          {
            id: `${intent.scopeId}:${intentKey}`,
            limitKey: intent.limitKey,
            tier: "effect",
            priority: 2,
            classRank: OPS_CLASS_RANK,
            drawsReserve: false,
            intent: {
              executionId: null,
              scopeId: intent.scopeId,
              intentKey,
              kind: intent.kind,
              payload: intent.payload,
              payloadDigest: await Effect.runPromise(sha256Hex(payloadJson)),
              effectClass: "adoptable",
              attempts: 0,
            },
            row: newRow({ effectClass: "adoptable", insertedAt: intent.now }),
          },
        ]),
      catch: (e) => new GithubNetworkError({ sent: false, message: `outbox insert: ${e}` }),
    });
  });

// ---------------------------------------------------------------------------
// Fan-out children and the neutral invariant

/** The intent key of a child's conclusion. */
export const CHILD_CONCLUDE_KEY = "cp:check:conclude";

export interface ChildCheck {
  readonly executionId: string;
  /** The child's recorded outcome, or null when it has none. */
  readonly verdict: Verdict | null;
  readonly concluded: boolean;
}

/**
 * The `check.conclude` intents a fan-out parent's outcome inserts: one per child check run not yet concluded, with the
 * child's recorded outcome or `failure` "parent closed before this part settled" (FD-GH-020).
 */
export const childConclusions = (children: readonly ChildCheck[]) =>
  children
    .filter((c) => !c.concluded)
    .map((c) => ({
      executionId: c.executionId,
      intentKey: CHILD_CONCLUDE_KEY,
      verdict: c.verdict ?? PARENT_CLOSED,
    }));

export { checkNeutralInvariant, neutralHolds, PARENT_CLOSED } from "./conclusion.ts";
