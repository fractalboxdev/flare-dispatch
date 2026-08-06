import { describe, expect, it } from "vitest";
import { resolveSubstrateSecret } from "./secrets";
import type { Env } from "./env";

/** Only the string bindings matter here; the rest of Env is irrelevant to the lookup. */
const env = (overrides: Partial<Env> = {}): Env =>
  ({
    TICKET_SECRET: "the-key-that-signs-admission-tickets",
    MODEL_PROXY_SECRET: "the-key-that-signs-model-tokens",
    CLOUDFLARE_API_TOKEN: "cf-token",
    NPM_TOKEN: "npm-token",
    ...overrides,
  }) as unknown as Env;

describe("resolveSubstrateSecret", () => {
  it("resolves the injectable bindings", () => {
    expect(resolveSubstrateSecret(env(), "CLOUDFLARE_API_TOKEN")).toBe("cf-token");
    expect(resolveSubstrateSecret(env(), "NPM_TOKEN")).toBe("npm-token");
  });

  it("cannot reach TICKET_SECRET — a descriptor naming it resolves to nothing", () => {
    // A forged ticket boots a container admission never admitted (ADR-0004),
    // so the egress handler must not be a read primitive for this binding.
    expect(resolveSubstrateSecret(env(), "TICKET_SECRET")).toBeUndefined();
  });

  it("cannot reach MODEL_PROXY_SECRET either", () => {
    expect(resolveSubstrateSecret(env(), "MODEL_PROXY_SECRET")).toBeUndefined();
  });

  it("treats an unset or empty binding as unset", () => {
    expect(resolveSubstrateSecret(env({ CLOUDFLARE_API_TOKEN: undefined }), "CLOUDFLARE_API_TOKEN"))
      .toBeUndefined();
    expect(resolveSubstrateSecret(env({ NPM_TOKEN: "" }), "NPM_TOKEN")).toBeUndefined();
  });

  it("resolves nothing for a name that is not a binding at all", () => {
    expect(resolveSubstrateSecret(env(), "PATH")).toBeUndefined();
  });
});
