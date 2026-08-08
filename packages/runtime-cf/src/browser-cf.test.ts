// Unit tests for the live Browser Rendering Layer — the pure pieces only.
// `wrangler-pool` Miniflare has no Browser Rendering, so the actual `/connect`
// attach can't be exercised here (that's a `wrangler dev` smoke). The
// `composeCdpEndpoint` helper is pure and worth pinning: it's what the
// container's Playwright process dials, and a bug there means runs that
// silently fail to attach.

import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { Browser } from "@fractalboxdev/flare-dispatch-core";
import { composeCdpEndpoint, makeBrowserRenderingLive } from "./browser-cf";

describe("composeCdpEndpoint", () => {
  it("returns connectUrl unchanged when apiToken is omitted", () => {
    expect(composeCdpEndpoint({ connectUrl: "wss://browser.cf/connect" })).toBe(
      "wss://browser.cf/connect",
    );
  });

  it("appends `?token=` to a URL with no query string", () => {
    expect(
      composeCdpEndpoint({
        connectUrl: "wss://browser.cf/connect",
        apiToken: "cf-token-abc",
      }),
    ).toBe("wss://browser.cf/connect?token=cf-token-abc");
  });

  it("appends `&token=` to a URL that already has a query string", () => {
    expect(
      composeCdpEndpoint({
        connectUrl: "wss://browser.cf/connect?keepalive=1",
        apiToken: "cf-token-abc",
      }),
    ).toBe("wss://browser.cf/connect?keepalive=1&token=cf-token-abc");
  });

  it("URL-encodes special characters in the token", () => {
    expect(
      composeCdpEndpoint({
        connectUrl: "wss://browser.cf/connect",
        apiToken: "cf/token+with=specials",
      }),
    ).toBe("wss://browser.cf/connect?token=cf%2Ftoken%2Bwith%3Dspecials");
  });
});

describe("makeBrowserRenderingLive — newCDPSession", () => {
  it("returns the composed wsEndpoint regardless of the targetUrl arg", async () => {
    const layer = makeBrowserRenderingLive({
      connectUrl: "wss://browser.cf/connect",
      apiToken: "tkn",
    });
    const ws = await Effect.runPromise(
      Effect.flatMap(Browser, (b) =>
        b.newCDPSession({ targetUrl: "https://app.example/path" }),
      ).pipe(Effect.provide(layer)),
    );
    expect(ws.wsEndpoint).toBe("wss://browser.cf/connect?token=tkn");
  });
});
