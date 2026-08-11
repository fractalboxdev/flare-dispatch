// redactWsEndpoint tests — the security-critical transform that keeps CDP
// WebSocket credentials (bearer tokens in the query string, userinfo) out of
// error objects and log lines. A regression here is a credential leak into
// the dispatcher's logs on every failed attach.

import { describe, expect, it } from "vitest";
import { redactWsEndpoint } from "./cdp.js";

describe("redactWsEndpoint", () => {
  it("strips the query string (where Browser Rendering tokens ride)", () => {
    expect(
      redactWsEndpoint("wss://browser-rendering.example/ws?token=abc123&recording=true"),
    ).toBe("wss://browser-rendering.example/ws");
  });

  it("strips userinfo", () => {
    expect(
      redactWsEndpoint("wss://user:secret@host.example:9222/devtools"),
    ).toBe("wss://host.example:9222/devtools");
  });

  it("strips both userinfo and query", () => {
    expect(
      redactWsEndpoint("wss://user:secret@host.example/ws?token=abc"),
    ).toBe("wss://host.example/ws");
  });

  it("strips the fragment", () => {
    expect(
      redactWsEndpoint("wss://host.example/ws?token=abc#frag"),
    ).toBe("wss://host.example/ws");
  });

  it("keeps a bare endpoint unchanged", () => {
    expect(redactWsEndpoint("wss://host.example/ws")).toBe(
      "wss://host.example/ws",
    );
  });

  it("redacts an unparseable endpoint at the first ? or #", () => {
    expect(redactWsEndpoint("not a url?token=abc")).toBe("not a url");
  });

  it("drops the fragment even on a minimal parseable endpoint", () => {
    expect(redactWsEndpoint("wss://broken#frag")).toBe("wss://broken/");
  });
});
