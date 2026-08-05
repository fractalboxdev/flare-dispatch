// Tests for the live `mailbox` capability Layer — allocate writes the
// `localPart → executionId` row and returns a minted address + signed token;
// the dying stub fails loudly when no INBOX_DOMAIN is configured.

import { describe, expect, it } from "vitest";
import { Effect, Exit } from "effect";
import { mailbox } from "@fractalboxdev/flare-dispatch-core";
import { makeMailboxCloudflareLive, type MailboxCloudflareConfig } from "./mailbox-cf";

/** A fake D1 that records the INSERT binds. */
const fakeDb = () => {
  const inserts: { sql: string; args: unknown[] }[] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return { run: async () => (inserts.push({ sql, args }), { success: true }) };
        },
      };
    },
  } as unknown as D1Database;
  return { db, inserts };
};

describe("makeMailboxCloudflareLive", () => {
  it("mints an address, signs a token, and records the allocation", async () => {
    const { db, inserts } = fakeDb();
    const config: MailboxCloudflareConfig = {
      inboxDomain: "inbox.example.com",
      db,
      executionId: "exec-123",
      signToken: async (localPart, exp) => `tok:${localPart}:${exp}`,
      ttlSec: 600,
    };
    const layer = makeMailboxCloudflareLive(config);

    const addr = await Effect.runPromise(
      mailbox.allocate({ label: "signup" }).pipe(Effect.provide(layer)),
    );

    expect(addr.address).toMatch(/^demo-[a-z0-9]{16,40}@inbox\.example\.com$/);
    expect(addr.localPart.startsWith("demo-")).toBe(true);
    expect(addr.token).toBe(`tok:${addr.localPart}:${addr.expiresAtS}`);
    // The allocation row was written with this execution id + the label.
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.sql).toContain("INSERT INTO inbox_allocations");
    expect(inserts[0]!.args).toContain("exec-123");
    expect(inserts[0]!.args).toContain(addr.localPart);
    expect(inserts[0]!.args).toContain("signup");
  });

  it("the dying stub fails loudly when no INBOX_DOMAIN is configured", async () => {
    const layer = makeMailboxCloudflareLive(undefined);
    const exit = await Effect.runPromiseExit(mailbox.allocate().pipe(Effect.provide(layer)));
    expect(Exit.isFailure(exit)).toBe(true);
  });
});
