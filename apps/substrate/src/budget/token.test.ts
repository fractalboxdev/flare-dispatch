import { describe, expect, it } from "vitest";
import { mintTicket } from "../admission/ticket";
import {
  MODEL_TOKEN_MAX_TTL_MS,
  bearerToken,
  mintModelToken,
  verifyModelToken,
} from "./token";

const SECRET = "model-proxy-signing-key";
const NOW = 1_800_000_000_000;
const EXECUTION = "dispatcher:exec-7";
const EXPECT = { executionId: EXECUTION, epoch: 0 };

const mint = (overrides: Partial<Parameters<typeof mintModelToken>[1]> = {}, now = NOW) =>
  mintModelToken(SECRET, { executionId: EXECUTION, consumer: "dispatcher", epoch: 0, ...overrides }, now);

describe("mint / verify", () => {
  it("verifies a freshly minted token for its own execution", async () => {
    const verdict = await verifyModelToken(SECRET, await mint(), EXPECT, NOW + 1_000);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.claims.consumer).toBe("dispatcher");
  });

  it("refuses a token minted for a different execution", async () => {
    const other = await mintModelToken(
      SECRET,
      { executionId: "dispatcher:exec-8", consumer: "dispatcher", epoch: 0 },
      NOW,
    );
    const verdict = await verifyModelToken(SECRET, other, EXPECT, NOW + 1_000);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain("different execution");
  });

  it("refuses a token signed with another key", async () => {
    const forged = await mintModelToken(
      "not-the-signing-key",
      { executionId: EXECUTION, consumer: "dispatcher", epoch: 0 },
      NOW,
    );
    expect((await verifyModelToken(SECRET, forged, EXPECT, NOW + 1)).ok).toBe(false);
  });

  it("refuses an admission ticket presented as a model token, same key or not", async () => {
    // Domain separation: `v1.` and `mp1.` envelopes must never cross over, or
    // the one credential allowed inside a container becomes a boot ticket.
    const ticket = await mintTicket(SECRET, {
      consumer: "dispatcher",
      key: "exec-7",
      pool: "lean",
      expiresAt: NOW + 60_000,
    });
    const verdict = await verifyModelToken(SECRET, ticket, EXPECT, NOW + 1);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain("malformed");
  });

  it("refuses a malformed or absent token rather than treating it as unsigned-allow", async () => {
    expect((await verifyModelToken(SECRET, undefined, EXPECT, NOW)).ok).toBe(false);
    expect((await verifyModelToken(SECRET, "", EXPECT, NOW)).ok).toBe(false);
    expect((await verifyModelToken(SECRET, "mp1.notbase64.zz", EXPECT, NOW)).ok).toBe(false);
  });
});

describe("wall-clock revocation", () => {
  it("expires at the ceiling without anything having to run", async () => {
    const token = await mint();
    expect((await verifyModelToken(SECRET, token, EXPECT, NOW + MODEL_TOKEN_MAX_TTL_MS - 1)).ok).toBe(
      true,
    );
    expect((await verifyModelToken(SECRET, token, EXPECT, NOW + MODEL_TOKEN_MAX_TTL_MS)).ok).toBe(
      false,
    );
  });

  it("clamps a requested lifetime down to the ceiling, never up", async () => {
    const token = await mint({ ttlMs: 24 * 60 * 60_000 });
    expect((await verifyModelToken(SECRET, token, EXPECT, NOW + MODEL_TOKEN_MAX_TTL_MS)).ok).toBe(
      false,
    );
  });

  it("honours a shorter requested lifetime", async () => {
    const token = await mint({ ttlMs: 60_000 });
    expect((await verifyModelToken(SECRET, token, EXPECT, NOW + 60_001)).ok).toBe(false);
  });

  it("dies at once when the store bumps the revocation epoch", async () => {
    const token = await mint();
    const verdict = await verifyModelToken(
      SECRET,
      token,
      { executionId: EXECUTION, epoch: 1 },
      NOW + 1_000,
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain("revoked");
  });
});

describe("bearerToken — header-only transport", () => {
  const url = (u: string) => new URL(u);

  it("reads a bearer token from the Authorization header", () => {
    const out = bearerToken(
      new Request("https://substrate.example/model", { headers: { authorization: "Bearer abc" } }),
      url("https://substrate.example/model"),
    );
    expect(out).toEqual({ ok: true, token: "abc" });
  });

  it("refuses a ?token= even when the header would have worked", () => {
    const out = bearerToken(
      new Request("https://substrate.example/model?token=abc", {
        headers: { authorization: "Bearer abc" },
      }),
      url("https://substrate.example/model?token=abc"),
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain("header-only");
  });

  it("refuses a non-bearer Authorization scheme", () => {
    expect(
      bearerToken(
        new Request("https://substrate.example/model", { headers: { authorization: "Basic abc" } }),
        url("https://substrate.example/model"),
      ).ok,
    ).toBe(false);
  });

  it("refuses a request with no Authorization at all", () => {
    expect(
      bearerToken(new Request("https://substrate.example/model"), url("https://substrate.example/model"))
        .ok,
    ).toBe(false);
  });
});
