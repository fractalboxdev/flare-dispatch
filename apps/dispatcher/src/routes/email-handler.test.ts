// FlareDispatch Dispatcher — `handleInboundEmail` (email-handler.ts) tests.
//
// The ordering is load-bearing (reject-before-parse is a security property), so
// the tests pin BOTH the outcome AND that the raw MIME is never buffered when a
// guard rejects:
//
//   * non-`demo-` RCPT        → setReject, raw NEVER read, NO D1 insert.
//   * unknown allocation      → setReject, NO D1 insert.
//   * expired allocation      → setReject ("mailbox expired"), NO D1 insert.
//   * disallowed sender       → setReject, raw NEVER read, NO D1 insert.
//   * happy path              → text-only row inserted + `sendEvent` called with
//                               type "mailbox-message" and the extracted code.
//
// The "raw never read on reject" assertion is made real with a `raw`
// ReadableStream whose `getReader` throws if anything touches it — the only way
// the handler reads the body is `new Response(message.raw)`, which pulls the
// stream, so a touched stream would surface as a thrown error here.

import { describe, expect, it, vi } from "vitest";
import { handleInboundEmail } from "./email-handler";
import type { Env } from "../env";

const VALID_LOCAL = "demo-abcdef0123456789abcd"; // 22 hex chars → matches RE.
const INBOX_DOMAIN = "inbox.flare-dispatch.example";

// --- Fakes ----------------------------------------------------------------

/** A captured `inbox_messages` INSERT, as bound. */
type InsertCall = { readonly sql: string; readonly binds: readonly unknown[] };

/** A seedable D1 fake: serves one canned allocation row and captures inserts.
 * Distinguishes the two statement shapes the handler emits by keyword. */
const makeFakeD1 = (
  allocation: { execution_id: string; expires_at: number } | null,
  opts: { failSelect?: boolean; failInsert?: boolean } = {},
) => {
  const inserts: InsertCall[] = [];
  const binding = {
    prepare: (sql: string) => ({
      bind: (...binds: unknown[]) => ({
        first: async () => {
          if (opts.failSelect) throw new Error("D1_ERROR: select boom");
          return allocation;
        },
        run: async () => {
          if (opts.failInsert) throw new Error("D1_ERROR: insert boom");
          inserts.push({ sql, binds });
          return { success: true };
        },
        all: async () => ({ results: [], success: true }),
      }),
    }),
  } as unknown as Env["RUNS_METADATA"];
  return { binding, inserts };
};

/** A fake `RUNS_WORKFLOW` recording `get(id).sendEvent({type, payload})`. */
const makeFakeWorkflow = (opts: { reject?: ReadonlySet<string> } = {}) => {
  const sendEvent = vi.fn(async (_e: { type: string; payload: unknown }) => {});
  const events: { wfId: string; type: string; payload: unknown }[] = [];
  const reject = opts.reject ?? new Set<string>();
  const binding = {
    get: (id: string) => ({
      id,
      sendEvent: async (e: { type: string; payload: unknown }) => {
        await sendEvent(e);
        if (reject.has(id)) throw new Error(`unknown_instance: ${id}`);
        events.push({ wfId: id, type: e.type, payload: e.payload });
      },
    }),
  } as unknown as Env["RUNS_WORKFLOW"];
  return { binding, sendEvent, events };
};

/** Build the minimal `Env` the handler touches, plus the optional allowlist. */
const makeEnv = (opts: {
  metadata: Env["RUNS_METADATA"];
  workflow: Env["RUNS_WORKFLOW"];
  allowedSenders?: string;
}): Env =>
  ({
    HMAC_SECRET: "unused",
    RUNS_WORKFLOW: opts.workflow,
    RUNS_METADATA: opts.metadata,
    RUNS_SANDBOX: {} as Env["RUNS_SANDBOX"],
    RUNS_STORAGE: {} as Env["RUNS_STORAGE"],
    ...(opts.allowedSenders !== undefined
      ? { INBOX_ALLOWED_SENDERS: opts.allowedSenders }
      : {}),
  }) as unknown as Env;

/** A `raw` stream that records whether it was ever read, and (when `poison`)
 * throws the instant anything pulls it — so "raw never read" is observable. */
const makeRawStream = (mime: string, opts: { poison?: boolean } = {}) => {
  const touched = { value: false };
  if (opts.poison) {
    const stream = {
      getReader: () => {
        touched.value = true;
        throw new Error("raw stream must not be read on a reject path");
      },
    } as unknown as ReadableStream<Uint8Array>;
    return { stream, touched };
  }
  const bytes = new TextEncoder().encode(mime);
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      touched.value = true;
      controller.enqueue(bytes);
      controller.close();
    },
  });
  return { stream, touched };
};

/** Build a fake `ForwardableEmailMessage`. */
const makeMessage = (opts: {
  from: string;
  to: string;
  subject?: string;
  mime?: string;
  poisonRaw?: boolean;
}) => {
  const { stream, touched } = makeRawStream(opts.mime ?? "", {
    poison: opts.poisonRaw,
  });
  const headers = new Headers();
  if (opts.subject !== undefined) headers.set("subject", opts.subject);
  const setReject = vi.fn((_reason: string) => {});
  const forward = vi.fn(async () => ({}) as never);
  const message = {
    from: opts.from,
    to: opts.to,
    headers,
    raw: stream,
    rawSize: (opts.mime ?? "").length,
    setReject,
    forward,
  } as unknown as ForwardableEmailMessage;
  return { message, setReject, forward, rawTouched: touched };
};

// --- A simple text/plain fixture carrying a 6-digit code -------------------

const OTP_MIME = [
  "From: auth@provider.example",
  "To: test@example",
  "Subject: Your verification code",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Your one-time code is 654321. It expires in 10 minutes.",
  "",
].join("\r\n");

const futureExpiry = () => Date.now() + 60_000;
const pastExpiry = () => Date.now() - 60_000;

// --- Tests ----------------------------------------------------------------

describe("handleInboundEmail — RCPT guard (reject before parse)", () => {
  it("non-`demo-` RCPT → setReject, raw NEVER read, no D1 insert", async () => {
    const d1 = makeFakeD1({ execution_id: "wf-1", expires_at: futureExpiry() });
    const wf = makeFakeWorkflow();
    const { message, setReject, rawTouched } = makeMessage({
      from: "auth@provider.example",
      to: `not-a-demo@${INBOX_DOMAIN}`,
      mime: OTP_MIME,
      poisonRaw: true, // reading it would throw → proves we never did
    });
    await handleInboundEmail(
      message,
      makeEnv({ metadata: d1.binding, workflow: wf.binding }),
    );
    expect(setReject).toHaveBeenCalledOnce();
    expect(setReject).toHaveBeenCalledWith("no such mailbox");
    expect(rawTouched.value).toBe(false);
    expect(d1.inserts).toHaveLength(0);
    expect(wf.sendEvent).not.toHaveBeenCalled();
  });
});

describe("handleInboundEmail — allocation lookup", () => {
  it("unknown allocation → setReject, no insert", async () => {
    const d1 = makeFakeD1(null);
    const wf = makeFakeWorkflow();
    const { message, setReject, rawTouched } = makeMessage({
      from: "auth@provider.example",
      to: `${VALID_LOCAL}@${INBOX_DOMAIN}`,
      mime: OTP_MIME,
      poisonRaw: true,
    });
    await handleInboundEmail(
      message,
      makeEnv({ metadata: d1.binding, workflow: wf.binding }),
    );
    expect(setReject).toHaveBeenCalledWith("no such mailbox");
    expect(rawTouched.value).toBe(false);
    expect(d1.inserts).toHaveLength(0);
  });

  it("expired allocation → setReject('mailbox expired'), no insert", async () => {
    const d1 = makeFakeD1({ execution_id: "wf-1", expires_at: pastExpiry() });
    const wf = makeFakeWorkflow();
    const { message, setReject, rawTouched } = makeMessage({
      from: "auth@provider.example",
      to: `${VALID_LOCAL}@${INBOX_DOMAIN}`,
      mime: OTP_MIME,
      poisonRaw: true,
    });
    await handleInboundEmail(
      message,
      makeEnv({ metadata: d1.binding, workflow: wf.binding }),
    );
    expect(setReject).toHaveBeenCalledWith("mailbox expired");
    expect(rawTouched.value).toBe(false);
    expect(d1.inserts).toHaveLength(0);
  });
});

describe("handleInboundEmail — sender allowlist", () => {
  it("disallowed sender → setReject, raw NEVER read, no insert", async () => {
    const d1 = makeFakeD1({ execution_id: "wf-1", expires_at: futureExpiry() });
    const wf = makeFakeWorkflow();
    const { message, setReject, rawTouched } = makeMessage({
      from: "attacker@evil.example",
      to: `${VALID_LOCAL}@${INBOX_DOMAIN}`,
      mime: OTP_MIME,
      poisonRaw: true,
    });
    await handleInboundEmail(
      message,
      makeEnv({
        metadata: d1.binding,
        workflow: wf.binding,
        allowedSenders: "provider.example, other.example",
      }),
    );
    expect(setReject).toHaveBeenCalledWith("sender not allowed");
    expect(rawTouched.value).toBe(false);
    expect(d1.inserts).toHaveLength(0);
    expect(wf.sendEvent).not.toHaveBeenCalled();
  });

  it("allowed sender on the allowlist → proceeds to insert + signal", async () => {
    const d1 = makeFakeD1({ execution_id: "wf-allow", expires_at: futureExpiry() });
    const wf = makeFakeWorkflow();
    const { message, setReject } = makeMessage({
      from: "auth@provider.example",
      to: `${VALID_LOCAL}@${INBOX_DOMAIN}`,
      subject: "Your verification code",
      mime: OTP_MIME,
    });
    await handleInboundEmail(
      message,
      makeEnv({
        metadata: d1.binding,
        workflow: wf.binding,
        allowedSenders: "provider.example",
      }),
    );
    expect(setReject).not.toHaveBeenCalled();
    expect(d1.inserts).toHaveLength(1);
    expect(wf.sendEvent).toHaveBeenCalledOnce();
  });
});

describe("handleInboundEmail — happy path", () => {
  it("inserts a text-only row and signals the run with the extracted code", async () => {
    const d1 = makeFakeD1({ execution_id: "wf-happy", expires_at: futureExpiry() });
    const wf = makeFakeWorkflow();
    const { message, setReject, rawTouched } = makeMessage({
      from: "auth@provider.example",
      to: `${VALID_LOCAL}@${INBOX_DOMAIN}`,
      subject: "Your verification code",
      mime: OTP_MIME,
    });
    await handleInboundEmail(
      message,
      makeEnv({ metadata: d1.binding, workflow: wf.binding }),
    );

    expect(setReject).not.toHaveBeenCalled();
    expect(rawTouched.value).toBe(true); // body WAS read on the accept path

    // One INSERT into inbox_messages, text-only (no html column, and the body
    // bind carries the source text the OTP is extracted from).
    expect(d1.inserts).toHaveLength(1);
    const insert = d1.inserts[0]!;
    expect(insert.sql).toMatch(/INSERT INTO inbox_messages/);
    expect(insert.sql).not.toMatch(/html/i);
    // binds: (id, local_part, sender, subject, text_body, received_at, expires_at)
    const [id, local, sender, subject, textBody] = insert.binds;
    expect(typeof id).toBe("string");
    expect(local).toBe(VALID_LOCAL);
    expect(sender).toBe("auth@provider.example");
    expect(subject).toBe("Your verification code");
    expect(String(textBody)).toContain("654321");

    // Signalled with the contract event type + a payload carrying the code text.
    expect(wf.sendEvent).toHaveBeenCalledOnce();
    expect(wf.events).toHaveLength(1);
    const ev = wf.events[0]!;
    expect(ev.wfId).toBe("wf-happy");
    expect(ev.type).toBe("mailbox-message");
    const payload = ev.payload as {
      id: string;
      localPart: string;
      recipient: string;
      sender: string;
      subject: string;
      text: string;
      receivedAt: number;
    };
    expect(payload.localPart).toBe(VALID_LOCAL);
    expect(payload.recipient).toBe(`${VALID_LOCAL}@${INBOX_DOMAIN}`);
    expect(payload.sender).toBe("auth@provider.example");
    expect(payload.text).toContain("654321");
    expect(typeof payload.receivedAt).toBe("number");
  });

  it("a wf_not_found signal outcome is swallowed (row still inserted)", async () => {
    const d1 = makeFakeD1({ execution_id: "missing-wf", expires_at: futureExpiry() });
    const wf = makeFakeWorkflow({ reject: new Set(["missing-wf"]) });
    const { message, setReject } = makeMessage({
      from: "auth@provider.example",
      to: `${VALID_LOCAL}@${INBOX_DOMAIN}`,
      mime: OTP_MIME,
    });
    await expect(
      handleInboundEmail(
        message,
        makeEnv({ metadata: d1.binding, workflow: wf.binding }),
      ),
    ).resolves.toBeUndefined();
    expect(setReject).not.toHaveBeenCalled();
    expect(d1.inserts).toHaveLength(1); // row stored despite no running instance
  });
});

describe("handleInboundEmail — never throws", () => {
  it("a failed insert after accept does not throw (message already accepted)", async () => {
    const d1 = makeFakeD1(
      { execution_id: "wf-1", expires_at: futureExpiry() },
      { failInsert: true },
    );
    const wf = makeFakeWorkflow();
    const { message, setReject } = makeMessage({
      from: "auth@provider.example",
      to: `${VALID_LOCAL}@${INBOX_DOMAIN}`,
      mime: OTP_MIME,
    });
    await expect(
      handleInboundEmail(
        message,
        makeEnv({ metadata: d1.binding, workflow: wf.binding }),
      ),
    ).resolves.toBeUndefined();
    // No setReject — the message was already accepted past the guards.
    expect(setReject).not.toHaveBeenCalled();
    expect(wf.sendEvent).not.toHaveBeenCalled(); // insert failed → never signalled
  });

  it("a failed allocation SELECT (before accept) → setReject, no throw", async () => {
    const d1 = makeFakeD1(null, { failSelect: true });
    const wf = makeFakeWorkflow();
    const { message, setReject } = makeMessage({
      from: "auth@provider.example",
      to: `${VALID_LOCAL}@${INBOX_DOMAIN}`,
      mime: OTP_MIME,
      poisonRaw: true,
    });
    await expect(
      handleInboundEmail(
        message,
        makeEnv({ metadata: d1.binding, workflow: wf.binding }),
      ),
    ).resolves.toBeUndefined();
    expect(setReject).toHaveBeenCalledWith("temporary failure");
    expect(d1.inserts).toHaveLength(0);
  });
});
