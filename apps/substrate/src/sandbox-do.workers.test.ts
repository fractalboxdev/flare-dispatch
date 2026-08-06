// The sandbox DO against real Durable Object storage, inside workerd
// (`vitest.workers.config.ts`).
//
// What only the runtime can answer lives here. The Node suites drive the
// engine's decisions behind structural fakes; these drive the object that
// actually holds the ticket and the attestation records, with the SDK's real
// `Sandbox` base class underneath and `ctx.storage.kv` doing the persisting.
//
// No container is ever started: the DO binding carries a container designator
// only so `Container`'s constructor finds `ctx.container` (it throws otherwise),
// and every path exercised below answers before touching it. That is not a
// limitation of the test — the ticket gate refusing before boot IS the
// property specs/platform.md lists as a success criterion.
import { env, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { ApprovalAttestation } from "@fractalboxdev/flare-dispatch-substrate-contract";
import { recordDenialD1 } from "./admission/denials-d1";
import { mintTicket, TICKET_TTL_MS } from "./admission/ticket";
import { sha256Hex } from "./engine/approval";
import type { SubstrateSandboxBase } from "./sandbox-do";

const SECRET = "substrate-test-ticket-secret";
const RECIPE = { version: 1, repo: { owner: "acme", name: "widget" } } as const;

let seq = 0;
/** A DO nobody else in this file has touched — storage is real and persists. */
const freshSandbox = (): DurableObjectStub<SubstrateSandboxBase> => {
  const name = `dispatcher:exec-${++seq}-${crypto.randomUUID().slice(0, 8)}`;
  return env.SANDBOX_LEAN.get(
    env.SANDBOX_LEAN.idFromName(name),
  ) as DurableObjectStub<SubstrateSandboxBase>;
};

const ticketFor = (key: string, over: { expiresAt?: number } = {}) =>
  mintTicket(SECRET, {
    consumer: "dispatcher",
    key,
    pool: "lean",
    expiresAt: over.expiresAt ?? Date.now() + TICKET_TTL_MS,
  });

describe("the ticket gate (ADR-0004) - enforcement is at the container", () => {
  it("refuses ensure() on an object admission never admitted", async () => {
    // The platform spec's success criterion, driven the way it is written:
    // call ensure() directly, with no facade in front of it.
    const outcome = await runInDurableObject(freshSandbox(), (instance) =>
      instance.ensure(RECIPE),
    );
    expect(outcome).toEqual({
      ok: false,
      refusal: { kind: "ticket-rejected", reason: "no admission ticket" },
    });
  });

  it("refuses to store a ticket minted for a different execution", async () => {
    const stub = freshSandbox();
    const foreign = await ticketFor("some-other-key");
    const stored = await runInDurableObject(stub, (instance) =>
      instance.admit("dispatcher", "my-key", foreign),
    );
    expect(stored).toEqual({
      ok: false,
      reason: "admission ticket was minted for a different execution",
    });
    // And nothing was written: the gate still reads as never-admitted.
    const outcome = await runInDurableObject(stub, (instance) => instance.ensure(RECIPE));
    expect(outcome).toMatchObject({ refusal: { reason: "no admission ticket" } });
  });

  it("refuses a ticket signed with the wrong secret", async () => {
    const forged = await mintTicket("not-the-substrate-secret", {
      consumer: "dispatcher",
      key: "k",
      pool: "lean",
      expiresAt: Date.now() + TICKET_TTL_MS,
    });
    const stored = await runInDurableObject(freshSandbox(), (instance) =>
      instance.admit("dispatcher", "k", forged),
    );
    expect(stored).toEqual({ ok: false, reason: "admission ticket failed verification" });
  });

  it("re-verifies at boot, so a ticket that expired after admit stops the next ensure()", async () => {
    // Store-time and boot-time verification are deliberately both there: the
    // first refuses a facade bug loudly, the second is the gate. Only the
    // second can catch a ticket that was valid when it was stored.
    const stub = freshSandbox();
    const shortLived = await ticketFor("k", { expiresAt: Date.now() + 50 });
    expect(
      await runInDurableObject(stub, (instance) => instance.admit("dispatcher", "k", shortLived)),
    ).toEqual({ ok: true });

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(await runInDurableObject(stub, (instance) => instance.ensure(RECIPE))).toEqual({
      ok: false,
      refusal: { kind: "ticket-rejected", reason: "admission ticket expired" },
    });
  });
});

describe("attestation single-use (ADR-0007) - persisted where the ticket is", () => {
  const command = "git push origin main";
  let attestation: ApprovalAttestation;

  beforeEach(async () => {
    attestation = {
      taskId: "task-7",
      ordinal: 3,
      commandSha256: await sha256Hex(command),
      approvedBy: "U0HUMAN",
      approvedAt: Date.now(),
    };
  });

  it("claims an ordinal once and refuses it under a second idempotency key", async () => {
    const stub = freshSandbox();
    // Separate RPC calls, so the second one reads the first one's record back
    // out of storage rather than out of an isolate-local map.
    expect(
      await runInDurableObject(stub, (i) => i.claimAttestation(attestation, "step-3-try-1")),
    ).toBeUndefined();
    expect(
      await runInDurableObject(stub, (i) => i.claimAttestation(attestation, "step-3-again")),
    ).toEqual({
      kind: "attestation-rejected",
      reason: "approval for this step was already used",
    });
  });

  it("lets the same durable step retry - a receipt dedupe sits behind it", async () => {
    const stub = freshSandbox();
    await runInDurableObject(stub, (i) => i.claimAttestation(attestation, "step-3"));
    expect(
      await runInDurableObject(stub, (i) => i.claimAttestation(attestation, "step-3")),
    ).toBeUndefined();
  });

  it("scopes the record to the pair, so a later ordinal is unaffected", async () => {
    const stub = freshSandbox();
    await runInDurableObject(stub, (i) => i.claimAttestation(attestation, "step-3"));
    expect(
      await runInDurableObject(stub, (i) =>
        i.claimAttestation({ ...attestation, ordinal: 4 }, "step-4"),
      ),
    ).toBeUndefined();
  });

  it("keeps two executions' records apart - the record lives in the object", async () => {
    const first = freshSandbox();
    const second = freshSandbox();
    await runInDurableObject(first, (i) => i.claimAttestation(attestation, "step-3"));
    // A different sandbox key is a different execution environment with its own
    // approval flow; spending an ordinal in one must not spend it in the other.
    expect(
      await runInDurableObject(second, (i) => i.claimAttestation(attestation, "step-3")),
    ).toBeUndefined();
  });
});

describe("denial retrieval (ADR-0005) - served with the artifacts, never inward", () => {
  it("returns this execution's denials, aggregated, and nobody else's", async () => {
    const mine = freshSandbox();
    const other = freshSandbox();
    const myId = await runInDurableObject(mine, (_i, state) => state.id.toString());
    const otherId = await runInDurableObject(other, (_i, state) => state.id.toString());

    const denial = { host: "evil.example", method: "GET", path: "/exfil", reason: "not admitted" };
    await recordDenialD1(env.ADMISSION_DB, myId, denial);
    await recordDenialD1(env.ADMISSION_DB, myId, denial);
    await recordDenialD1(env.ADMISSION_DB, myId, {
      host: "api.github.com",
      method: "POST",
      path: "/repos",
      reason: "denied write sink",
    });
    await recordDenialD1(env.ADMISSION_DB, otherId, denial);

    const rows = await runInDurableObject(mine, (i) => i.denials());
    // Repeats aggregate into a count rather than a row each, and the ordering
    // puts the loudest first — a report-mode reader wants the hot host on top.
    expect(rows).toEqual([
      { host: "evil.example", method: "GET", path: "/exfil", reason: "not admitted", count: 2 },
      {
        host: "api.github.com",
        method: "POST",
        path: "/repos",
        reason: "denied write sink",
        count: 1,
      },
    ]);
  });

  it("answers with an empty list for an execution that was refused nothing", async () => {
    expect(await runInDurableObject(freshSandbox(), (i) => i.denials())).toEqual([]);
  });
});
