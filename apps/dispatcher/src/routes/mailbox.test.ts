// Tests for the container-side mailbox read route — token gating + burn-after-read.

import { describe, expect, it } from "vitest";
import type { Env } from "../env";
import { signMailboxToken } from "../mailbox-token";
import { handleMailboxRead } from "./mailbox";

const SECRET = "test-mailbox-secret";
const LOCAL = "demo-0123456789abcdef0123456789abcd";

/** A fake D1 that answers the SELECT with `row` and records UPDATE (burn) binds. */
const fakeDb = (row: unknown) => {
  const updates: unknown[][] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            first: async () => row,
            run: async () => {
              if (sql.includes("UPDATE")) updates.push(args);
              return { success: true };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  return { db, updates };
};

const envWith = (db: D1Database, over: Partial<Env> = {}): Env =>
  ({ MAILBOX_LINK_SECRET: SECRET, RUNS_METADATA: db, ...over }) as unknown as Env;

const url = (localPart: string, exp: number, token: string, extra = "") =>
  new URL(`https://d.example/v1/mailbox/${localPart}?exp=${exp}&t=${token}${extra}`);

const messageRow = {
  id: "m1",
  sender: "no-reply@auth.example.com",
  subject: "Your verification code",
  text_body: "Your code is 482913. Expires in 10 minutes.",
  received_at: 1_700_000_000_000,
};

describe("GET /v1/mailbox/:localPart", () => {
  it("serves the latest message + extracted code, then burns it", async () => {
    const exp = Math.floor(Date.now() / 1000) + 300;
    const token = await signMailboxToken(SECRET, LOCAL, exp);
    const { db, updates } = fakeDb(messageRow);

    const res = await handleMailboxRead(envWith(db), LOCAL, url(LOCAL, exp, token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { code?: string; sender: string };
    expect(body.code).toBe("482913");
    expect(body.sender).toBe("no-reply@auth.example.com");
    // Burn-after-read: the UPDATE consumed_at ran exactly once for this row.
    expect(updates).toHaveLength(1);
    expect(updates[0]).toContain("m1");
  });

  it("403s an expired token (even with a valid MAC)", async () => {
    const exp = Math.floor(Date.now() / 1000) - 10; // already expired
    const token = await signMailboxToken(SECRET, LOCAL, exp);
    const { db, updates } = fakeDb(messageRow);
    const res = await handleMailboxRead(envWith(db), LOCAL, url(LOCAL, exp, token));
    expect(res.status).toBe(403);
    expect(updates).toHaveLength(0); // no burn on a rejected read
  });

  it("403s a tampered token", async () => {
    const exp = Math.floor(Date.now() / 1000) + 300;
    const token = await signMailboxToken(SECRET, LOCAL, exp);
    const { db } = fakeDb(messageRow);
    const res = await handleMailboxRead(
      envWith(db),
      LOCAL,
      url(LOCAL, exp, `${token}x`),
    );
    expect(res.status).toBe(403);
  });

  it("404s when no message has arrived yet", async () => {
    const exp = Math.floor(Date.now() / 1000) + 300;
    const token = await signMailboxToken(SECRET, LOCAL, exp);
    const { db } = fakeDb(null);
    const res = await handleMailboxRead(envWith(db), LOCAL, url(LOCAL, exp, token));
    expect(res.status).toBe(404);
  });

  it("404s an invalid local-part shape", async () => {
    const { db } = fakeDb(messageRow);
    const res = await handleMailboxRead(
      envWith(db),
      "not-a-mailbox",
      url("not-a-mailbox", 0, "x"),
    );
    expect(res.status).toBe(404);
  });

  it("503s when no key material is configured", async () => {
    const { db } = fakeDb(messageRow);
    const env = { RUNS_METADATA: db } as unknown as Env; // no secret at all
    const res = await handleMailboxRead(env, LOCAL, url(LOCAL, 0, "x"));
    expect(res.status).toBe(503);
  });

  it("falls back to HMAC_SECRET when MAILBOX_LINK_SECRET is unset", async () => {
    const exp = Math.floor(Date.now() / 1000) + 300;
    const token = await signMailboxToken("hmac-fallback", LOCAL, exp);
    const { db } = fakeDb(messageRow);
    const env = { HMAC_SECRET: "hmac-fallback", RUNS_METADATA: db } as unknown as Env;
    const res = await handleMailboxRead(env, LOCAL, url(LOCAL, exp, token));
    expect(res.status).toBe(200);
  });
});
