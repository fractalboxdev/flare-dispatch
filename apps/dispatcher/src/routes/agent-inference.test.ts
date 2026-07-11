// FlareDispatch Dispatcher — `POST /v1/agent/:execution/inference` tests.
//
// Drives `handleAgentInference` via the router with a hand-built Request + fake
// Env. Covers the model-proxy contract (specs/08-self-healing.md § 6.3):
//   no AI binding / no budget DO / no secret   → 503 (fail closed);
//   bad capability token                       → 401;
//   invalid execution id / bad body            → 400;
//   non-POST                                   → 405;
//   budget DO denies                           → 429;
//   happy path                                 → 200 + reserve→settle, model brokered.

import { describe, expect, it, vi } from "vitest";
import { handleRequest } from "../router";
import { signAgentToken } from "../agent-token";
import { makeFakeEnv, makeFakeR2, makeFakeWorkflow } from "../test-helpers";
import type { Env } from "../env";

const HMAC = "agent-proxy-secret-please-rotate-aaaaaa";
const EXEC = "self-heal:owner_repo:abc123def456";

const url = (exec: string) =>
  `https://dispatcher.example/v1/agent/${exec}/inference`;

/** A fake AgentBudget DO namespace whose stub records reserve/settle. */
const fakeBudget = (reserve: unknown) => {
  const settle = vi.fn(async () => {});
  const stub = { reserve: vi.fn(async () => reserve), settle, kill: vi.fn(), init: vi.fn(), status: vi.fn() };
  const ns = {
    idFromName: (n: string) => ({ name: n }),
    get: () => stub,
  } as unknown as Env["AGENT_BUDGET"];
  return { ns, stub, settle };
};

/** A fake Workers AI binding: `run` returns a fixed completion. */
const fakeAi = (response: string) =>
  ({ run: vi.fn(async () => ({ response, tool_calls: [] })) }) as unknown as Env["AI"];

const baseEnv = (over: Partial<Env> = {}): Env => ({
  ...makeFakeEnv({ hmacSecret: HMAC, workflow: makeFakeWorkflow(), storage: makeFakeR2() }),
  AI: fakeAi("patched the handler"),
  AGENT_BUDGET: fakeBudget({ ok: true, held: 100, remaining: 199900 }).ns,
  ...over,
});

const body = { system: "You fix bugs.", user: "Fix the TypeError.", maxTokens: 256 };

const post = (env: Env, token: string | null, payload: unknown = body, exec = EXEC) =>
  handleRequest(
    new Request(url(exec), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token !== null ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(payload),
    }),
    env,
  );

describe("POST /v1/agent/:execution/inference", () => {
  it("503 when the AI binding is absent", async () => {
    const token = await signAgentToken(HMAC, EXEC);
    const res = await post(baseEnv({ AI: undefined }), token);
    expect(res.status).toBe(503);
  });

  it("503 when the budget DO is absent", async () => {
    const token = await signAgentToken(HMAC, EXEC);
    const res = await post(baseEnv({ AGENT_BUDGET: undefined }), token);
    expect(res.status).toBe(503);
  });

  it("401 on a missing/wrong capability token", async () => {
    expect((await post(baseEnv(), null)).status).toBe(401);
    expect((await post(baseEnv(), "wrong-token-000000000")).status).toBe(401);
  });

  it("400 on an invalid execution id", async () => {
    const token = await signAgentToken(HMAC, "a"); // too short for the id regex
    const res = await post(baseEnv(), token, body, "a");
    expect(res.status).toBe(400);
  });

  it("400 on an unparseable / invalid body", async () => {
    const token = await signAgentToken(HMAC, EXEC);
    const res = await post(baseEnv(), token, { user: 123 });
    expect(res.status).toBe(400);
  });

  it("405 on a non-POST method", async () => {
    const res = await handleRequest(new Request(url(EXEC), { method: "GET" }), baseEnv());
    expect(res.status).toBe(405);
  });

  it("429 when the budget DO denies the reservation", async () => {
    const token = await signAgentToken(HMAC, EXEC);
    const denied = fakeBudget({ ok: false, reason: "budget-exhausted", remaining: 0 });
    const res = await post(baseEnv({ AGENT_BUDGET: denied.ns }), token);
    expect(res.status).toBe(429);
    const j = (await res.json()) as { reason: string };
    expect(j.reason).toBe("budget-exhausted");
  });

  it("200 happy path — reserves, brokers the model, settles", async () => {
    const token = await signAgentToken(HMAC, EXEC);
    const b = fakeBudget({ ok: true, held: 100, remaining: 199900 });
    const res = await post(baseEnv({ AGENT_BUDGET: b.ns }), token);
    expect(res.status).toBe(200);
    const j = (await res.json()) as { text: string };
    expect(j.text).toBe("patched the handler");
    expect(b.stub.reserve).toHaveBeenCalledOnce();
    expect(b.settle).toHaveBeenCalledOnce();
  });
});
