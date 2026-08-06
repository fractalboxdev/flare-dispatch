import { describe, expect, it } from "vitest";
import { mintTicket, verifyTicket, TICKET_TTL_MS, type TicketClaims } from "./ticket";

const SECRET = "test-ticket-secret";
const NOW = 1_700_000_000_000;

const claims = (over: Partial<TicketClaims> = {}): TicketClaims => ({
  consumer: "fractalbot",
  key: "T0:C1:1700.0:7",
  pool: "task",
  expiresAt: NOW + TICKET_TTL_MS,
  ...over,
});

const expect_ = { consumer: "fractalbot", key: "T0:C1:1700.0:7" };

describe("admission tickets (ADR-0004)", () => {
  it("round-trips a minted ticket", async () => {
    const ticket = await mintTicket(SECRET, claims());
    const verdict = await verifyTicket(SECRET, ticket, expect_, NOW);
    expect(verdict).toEqual({ ok: true, claims: claims() });
  });

  it("fails closed with no ticket at all — the boot-without-admission case", async () => {
    const verdict = await verifyTicket(SECRET, undefined, expect_, NOW);
    expect(verdict).toEqual({ ok: false, reason: "no admission ticket" });
  });

  it("refuses a ticket signed under a different secret", async () => {
    const ticket = await mintTicket("some-other-secret", claims());
    const verdict = await verifyTicket(SECRET, ticket, expect_, NOW);
    expect(verdict).toMatchObject({ ok: false, reason: expect.stringMatching(/verification/) });
  });

  it("refuses a ticket whose claims were tampered with", async () => {
    const ticket = await mintTicket(SECRET, claims());
    const [v, , mac] = ticket.split(".");
    const forged = JSON.stringify(claims({ expiresAt: NOW + 10 * TICKET_TTL_MS }));
    const payload = btoa(forged).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
    const verdict = await verifyTicket(SECRET, `${v}.${payload}.${mac}`, expect_, NOW);
    expect(verdict).toMatchObject({ ok: false });
  });

  it("refuses a ticket minted for a different execution or consumer", async () => {
    const wrongKey = await mintTicket(SECRET, claims({ key: "T0:C1:1700.0:8" }));
    expect(await verifyTicket(SECRET, wrongKey, expect_, NOW)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/different execution/),
    });
    const wrongConsumer = await mintTicket(SECRET, claims({ consumer: "dispatcher" }));
    expect(await verifyTicket(SECRET, wrongConsumer, expect_, NOW)).toMatchObject({ ok: false });
  });

  it("refuses an expired ticket — admission is a lease, not a grant of forever", async () => {
    const ticket = await mintTicket(SECRET, claims());
    const verdict = await verifyTicket(SECRET, ticket, expect_, NOW + TICKET_TTL_MS);
    expect(verdict).toEqual({ ok: false, reason: "admission ticket expired" });
  });

  it("refuses malformed tickets rather than treating them as unsigned-allow", async () => {
    for (const bad of ["", "v1", "v1.only-two", "v0.a.b", "v1.!!!.zz", "v1.YQ.deadbeef"]) {
      const verdict = await verifyTicket(SECRET, bad, expect_, NOW);
      expect(verdict.ok).toBe(false);
    }
  });
});
