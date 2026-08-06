// The classifier that turns a platform gate's bodyless 520 into a denial record
// (ADR-0005). The proxy class itself needs a container to exercise; this covers
// the decision it makes, which is the part that can be wrong.
import { describe, expect, it } from "vitest";
import { WRITE_SINKS } from "./egress";
import { classifyPlatformDenial, type ProxyProps } from "./platform-denial";

/** What `applyOutboundInterception` freezes in during a `public-repo-read` grant. */
const GRANTED: ProxyProps = {
  containerId: "b1946ac92492d2347c6235b4d2611184",
  className: "SubstrateSandboxLean",
  allowedHosts: ["github.com", "codeload.github.com"],
  deniedHosts: [...WRITE_SINKS],
  outboundByHostOverrides: {
    "github.com": { method: "publicRepo" },
    "codeload.github.com": { method: "publicRepo" },
  },
};

const get = (url: string) => ({ method: "GET", url });

describe("classifyPlatformDenial - the half the handler never sees", () => {
  it("records an unlisted host the gate refused before any handler ran", () => {
    expect(classifyPlatformDenial(GRANTED, get("https://evil.example/exfil?q=1"), 520)).toEqual({
      host: "evil.example",
      method: "GET",
      path: "/exfil",
      reason: "host evil.example is not admitted (refused by the container gate)",
    });
  });

  it("names the write-sink deny list when that is the gate that answered", () => {
    // Step 1 and step 2 both answer 520; which one did is the difference
    // between "this run needs a grant profile" and "this run tried a sink".
    expect(
      classifyPlatformDenial(GRANTED, { method: "POST", url: "https://api.github.com/repos" }, 520),
    ).toMatchObject({
      host: "api.github.com",
      method: "POST",
      reason: "host api.github.com is a denied write sink (refused by the container gate)",
    });
  });

  it("records a denial under deny-all, where nothing is admitted and nothing is handled", () => {
    // The posture between grants: `allowedHosts: []` engages the gate and
    // matches nothing, so every host dies at step 2.
    const denyAll: ProxyProps = { containerId: "c1", allowedHosts: [], deniedHosts: [...WRITE_SINKS] };
    expect(classifyPlatformDenial(denyAll, get("https://registry.npmjs.org/left-pad"), 520)).toMatchObject({
      host: "registry.npmjs.org",
      path: "/left-pad",
    });
  });

  it("ignores a 520 that came back through a mapped handler", () => {
    // `serveGrantedRequest` proxies upstream responses verbatim, so a genuine
    // 520 from github.com is an upstream fact, not a denial — and the handler
    // already records its own refusals as 403s.
    expect(classifyPlatformDenial(GRANTED, get("https://github.com/acme/widget.git"), 520)).toBeUndefined();
  });

  it("ignores every status the gate does not use", () => {
    expect(classifyPlatformDenial(GRANTED, get("https://evil.example/"), 403)).toBeUndefined();
    expect(classifyPlatformDenial(GRANTED, get("https://evil.example/"), 200)).toBeUndefined();
    expect(classifyPlatformDenial(GRANTED, get("https://evil.example/"), 502)).toBeUndefined();
  });

  it("normalises the method and drops the query string", () => {
    // The record is `{host, method, path, reason}`; a query string is
    // workload-authored and would make every request its own aggregate row.
    expect(
      classifyPlatformDenial(GRANTED, { method: "post", url: "https://evil.example/p?token=abc" }, 520),
    ).toMatchObject({ method: "POST", path: "/p" });
  });

  it("says nothing about an unparseable url rather than recording a broken row", () => {
    expect(classifyPlatformDenial(GRANTED, get("not a url"), 520)).toBeUndefined();
  });
});
