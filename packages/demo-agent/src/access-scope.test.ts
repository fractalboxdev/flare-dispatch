import { describe, expect, it } from "vitest";
import {
  accessHosts,
  cfAuthorizationFromSetCookie,
  exchangeUrlForHost,
} from "./access-scope";

describe("accessHosts", () => {
  it("derives the app's host from the play/record --url", () => {
    expect(
      accessHosts("https://app-staging.pages.dev/some/path", undefined),
    ).toEqual(["app-staging.pages.dev"]);
  });

  it("adds CF_ACCESS_HOSTS entries (whitespace-tolerant, deduped)", () => {
    expect(
      accessHosts(
        "https://app.pages.dev",
        " api.example.com , app.pages.dev , ",
      ),
    ).toEqual(["app.pages.dev", "api.example.com"]);
  });

  it("works from extra hosts alone when the app url is missing/unparseable", () => {
    expect(accessHosts(undefined, "api.example.com")).toEqual([
      "api.example.com",
    ]);
    expect(accessHosts("not a url", "api.example.com")).toEqual([
      "api.example.com",
    ]);
  });

  it("returns empty when no host information exists — caller falls back to global headers", () => {
    expect(accessHosts(undefined, undefined)).toEqual([]);
    expect(accessHosts("not a url", " , ")).toEqual([]);
  });
});

describe("exchangeUrlForHost", () => {
  it("exchanges against the full target path for the app's own host (path-scoped app)", () => {
    expect(
      exchangeUrlForHost(
        "flare-dispatch-app.openhackers.club",
        "https://flare-dispatch-app.openhackers.club/logs/abc?t=xyz",
      ),
    ).toBe("https://flare-dispatch-app.openhackers.club/logs/abc?t=xyz");
  });

  it("falls back to the host root for a different (CF_ACCESS_HOSTS) host", () => {
    expect(
      exchangeUrlForHost("api.example.com", "https://app.example.com/logs/abc"),
    ).toBe("https://api.example.com/");
  });

  it("falls back to the host root when appUrl is missing or unparseable", () => {
    expect(exchangeUrlForHost("app.pages.dev", undefined)).toBe(
      "https://app.pages.dev/",
    );
    expect(exchangeUrlForHost("app.pages.dev", "not a url")).toBe(
      "https://app.pages.dev/",
    );
  });
});

describe("cfAuthorizationFromSetCookie", () => {
  it("extracts the CF_Authorization value", () => {
    expect(
      cfAuthorizationFromSetCookie([
        "__cflb=abc; Path=/; HttpOnly",
        "CF_Authorization=eyJhbGciOi.payload.sig; Expires=Sat, 06 Jun 2026 11:23:41 GMT; Path=/; Secure; SameSite=none",
      ]),
    ).toBe("eyJhbGciOi.payload.sig");
  });

  it("returns null when the target is not Access-gated (no cookie)", () => {
    expect(cfAuthorizationFromSetCookie([])).toBeNull();
    expect(cfAuthorizationFromSetCookie(["theme=dark; Path=/"])).toBeNull();
  });

  it("ignores an empty value", () => {
    expect(cfAuthorizationFromSetCookie(["CF_Authorization=; Path=/"])).toBeNull();
  });
});
