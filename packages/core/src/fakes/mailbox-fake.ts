// @fractalboxdev/flare-dispatch-core — Mailbox fake.
//
// `RunContext` is the union of *all* capability services, so `CFRuntimeTest`
// needs a Layer for `Mailbox` even when the run under test never provisions an
// inbox. The fake mints a deterministic address (so a run's checkpointed
// `provision-inbox` step result is stable across the test) and records every
// allocation in an inspectable state handle. The WAIT side of the loop is fed
// separately via the inline runner's `eventQueue` (enqueue an `InboxMessage`
// under `INBOX_EVENT_TYPE`), so a test drives the whole provision→wait→extract
// path in-process with no CF.
//
// Spec: specs/pm/plan.md § 3 (fakes/), specs/03-dsl.md § Layers.

import { Effect, Layer } from "effect";
import { INBOX_TTL_SEC_DEFAULT, type InboxAddress } from "../mailbox/contract";
import { type AllocateOpts, Mailbox, type MailboxService } from "../services/mailbox";

/** Inspectable record of every Mailbox fake allocation. */
export type MailboxFakeState = {
  /** every address `allocate` minted, in order. */
  readonly allocated: InboxAddress[];
};

/** Options for the Mailbox fake — override the domain the deterministic address
 * is built on. */
export type MailboxFakeOptions = {
  /** Domain the minted address uses (default `inbox.test`). */
  readonly inboxDomain?: string;
  /** Local-part body the deterministic mint uses (default a fixed 32-char hex).
   * Each allocation appends its index so repeated allocations differ. */
  readonly localPartSeed?: string;
};

/**
 * Build a Mailbox fake plus an inspectable state handle. `allocate` returns a
 * deterministic `InboxAddress` (index-suffixed so multiple allocations differ)
 * and records it.
 */
export const makeMailboxFake = (
  opts: MailboxFakeOptions = {},
): { layer: Layer.Layer<Mailbox>; state: MailboxFakeState } => {
  const inboxDomain = opts.inboxDomain ?? "inbox.test";
  const seed = opts.localPartSeed ?? "0123456789abcdef0123456789abcdef";
  const state: MailboxFakeState = { allocated: [] };
  const service: MailboxService = {
    allocate: (allocOpts?: AllocateOpts) =>
      Effect.sync(() => {
        const n = state.allocated.length;
        // Keep it within INBOX_LOCAL_PART_RE (16–40 lowercase hex/base36).
        const body = `${seed}${n}`.slice(0, 32);
        const localPart = `demo-${body}`;
        const ttl = allocOpts?.ttlSec ?? INBOX_TTL_SEC_DEFAULT;
        const addr: InboxAddress = {
          address: `${localPart}@${inboxDomain}`,
          localPart,
          token: `fake-token-${n}`,
          expiresAtS: ttl,
        };
        state.allocated.push(addr);
        return addr;
      }),
  };
  return { layer: Layer.succeed(Mailbox, service), state };
};

/** A ready-to-use Mailbox fake Layer — deterministic mint, records calls. */
export const MailboxFake: Layer.Layer<Mailbox> = makeMailboxFake().layer;
