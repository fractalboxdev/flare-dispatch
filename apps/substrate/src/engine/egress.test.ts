import { describe, expect, it } from "vitest";
import type { DenialEvent } from "@fractalboxdev/flare-dispatch-substrate-contract";
import {
  applyGrant,
  buildGrant,
  decide,
  egressHandlers,
  grantParamsFor,
  hostMatches,
  normalizeHost,
  publicRepoPolicy,
  revokeGrant,
  serveGrantedRequest,
  WRITE_SINKS,
  type GrantParams,
  type GrantTarget,
  type OutboundContext,
} from "./egress";

const CONTAINER = "T0:C1:1700.0:7";
const PARAMS: GrantParams = { repo: "acme/widget", containerId: CONTAINER };
const LFS_PARAMS: GrantParams = { ...PARAMS, lfs: true };
const CTX: OutboundContext<GrantParams> = {
  containerId: CONTAINER,
  className: "SubstrateSandboxTask",
  params: PARAMS,
};

const policy = publicRepoPolicy(PARAMS);
const lfsPolicy = publicRepoPolicy(LFS_PARAMS);

const at = (u: string) => new URL(u);

/** A fetch stub that records what the handler actually sent. */
function recorder(responses: Response[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const queue = [...responses];
  const fetchStub = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return queue.shift() ?? new Response("no stub queued", { status: 500 });
  }) as unknown as typeof fetch;
  return { calls, fetch: fetchStub };
}

const redirectTo = (location: string, status = 302) =>
  new Response(null, { status, headers: { location } });

const serve = (
  req: Request,
  deps: { fetch: typeof fetch; recordDenial?: (e: Omit<DenialEvent, "count">) => void },
  ctx = CTX,
) => serveGrantedRequest(req, ctx, deps);

describe("normalizeHost", () => {
  it("folds case, a trailing root dot, and a port to one form", () => {
    expect(normalizeHost("GitHub.com")).toBe("github.com");
    expect(normalizeHost("github.com.")).toBe("github.com");
    expect(normalizeHost("github.com:443")).toBe("github.com");
    expect(normalizeHost("GitHub.com.:443")).toBe("github.com");
  });

  it("does not mistake an IPv6 literal's colons for a port", () => {
    expect(normalizeHost("[::1]")).toBe("[::1]");
    expect(normalizeHost("[::1]:8080")).toBe("[::1]");
  });
});

describe("hostMatches — globs are anchored at both ends", () => {
  it("refuses a suffix spoof of a wildcard", () => {
    expect(hostMatches("*.github.com", "evilgithub.com")).toBe(false);
    expect(hostMatches("*.github.com", "api.github.com.evil.com")).toBe(false);
    expect(hostMatches("*.github.com", "notgithub.com")).toBe(false);
  });

  it("refuses a prefix spoof of an exact pattern", () => {
    expect(hostMatches("github.com", "github.com.evil.com")).toBe(false);
    expect(hostMatches("github.com", "evilgithub.com")).toBe(false);
    expect(hostMatches("github.com", "x.github.com")).toBe(false);
  });

  it("treats a pattern without * as exact — the sibling-host trap", () => {
    // `github.com` alone admits neither of these, which is why a clone that
    // redirects or uses LFS fails until each host is listed.
    expect(hostMatches("github.com", "codeload.github.com")).toBe(false);
    expect(hostMatches("github.com", "objects.githubusercontent.com")).toBe(false);
  });

  it("matches exactly one label for a *", () => {
    expect(hostMatches("*.github.com", "api.github.com")).toBe(true);
    expect(hostMatches("*.github.com", "a.b.github.com")).toBe(false);
    expect(hostMatches("*.github.com", "github.com")).toBe(false);
  });

  it("does not let regex metacharacters in a pattern widen it", () => {
    expect(hostMatches("git.hub.com", "gitXhub.com")).toBe(false);
    expect(hostMatches("git+hub.com", "githubcom")).toBe(false);
  });

  it("normalizes both sides before comparing", () => {
    expect(hostMatches("GitHub.com", "github.com.")).toBe(true);
    expect(hostMatches("*.GITHUB.com", "API.github.com:443")).toBe(true);
  });
});

describe("decide — the read path a clone actually needs", () => {
  it("admits ref discovery for upload-pack", () => {
    const d = decide(policy, "GET", at("https://github.com/acme/widget/info/refs?service=git-upload-pack"));
    expect(d.ok).toBe(true);
  });

  it("admits the same path spelled with .git", () => {
    const d = decide(policy, "GET", at("https://github.com/acme/widget.git/info/refs?service=git-upload-pack"));
    expect(d.ok).toBe(true);
  });

  it("admits the upload-pack negotiation POST", () => {
    expect(decide(policy, "POST", at("https://github.com/acme/widget/git-upload-pack")).ok).toBe(true);
  });

  it("admits HEAD wherever GET is admitted", () => {
    const d = decide(policy, "HEAD", at("https://github.com/acme/widget/info/refs?service=git-upload-pack"));
    expect(d.ok).toBe(true);
  });

  it("admits an archive fetch on codeload", () => {
    expect(decide(policy, "GET", at("https://codeload.github.com/acme/widget/tar.gz/main")).ok).toBe(true);
  });
});

describe("decide — same host, wrong path", () => {
  it("refuses push negotiation on the granted repo", () => {
    const d = decide(policy, "POST", at("https://github.com/acme/widget/git-receive-pack"));
    expect(d.ok).toBe(false);
    expect(d.ok === false && d.reason).toMatch(/outside the grant/);
  });

  it("refuses push discovery, which differs only by a query parameter", () => {
    const d = decide(policy, "GET", at("https://github.com/acme/widget/info/refs?service=git-receive-pack"));
    expect(d.ok).toBe(false);
  });

  it("refuses ref discovery with no service parameter at all", () => {
    expect(decide(policy, "GET", at("https://github.com/acme/widget/info/refs")).ok).toBe(false);
  });

  it("refuses a different repository on the granted host", () => {
    expect(decide(policy, "GET", at("https://github.com/attacker/sink/info/refs?service=git-upload-pack")).ok).toBe(false);
    expect(decide(policy, "POST", at("https://github.com/attacker/sink/git-upload-pack")).ok).toBe(false);
  });

  it("refuses a repo whose name merely starts with the granted one", () => {
    expect(decide(policy, "POST", at("https://github.com/acme/widget-evil/git-upload-pack")).ok).toBe(false);
    expect(decide(policy, "POST", at("https://github.com/acme/widget/../other/git-upload-pack")).ok).toBe(false);
  });

  it("refuses an unrelated path on the granted host", () => {
    expect(decide(policy, "GET", at("https://github.com/settings/tokens")).ok).toBe(false);
  });

  it("refuses methods outside GET/HEAD/POST", () => {
    for (const m of ["PUT", "DELETE", "PATCH", "OPTIONS"])
      expect(decide(policy, m, at("https://github.com/acme/widget/git-upload-pack")).ok).toBe(false);
  });
});

describe("decide — hosts", () => {
  it("refuses a host that is not admitted", () => {
    const d = decide(policy, "GET", at("https://evil.com/acme/widget/info/refs?service=git-upload-pack"));
    expect(d.ok === false && d.reason).toMatch(/not admitted/);
  });

  it("refuses a sibling host the exact pattern never admitted", () => {
    expect(decide(policy, "GET", at("https://raw.githubusercontent.com/acme/widget/main/x")).ok).toBe(false);
  });

  it("refuses every declared write sink, ahead of any path rule", () => {
    for (const sink of WRITE_SINKS) {
      const d = decide(policy, "GET", at(`https://${sink}/acme/widget/info/refs?service=git-upload-pack`));
      expect(d.ok).toBe(false);
      expect(d.ok === false && d.reason).toMatch(/denied write sink/);
    }
  });

  it("refuses a plaintext downgrade", () => {
    const d = decide(policy, "GET", at("http://github.com/acme/widget/info/refs?service=git-upload-pack"));
    expect(d.ok === false && d.reason).toMatch(/not https/);
  });

  it("is not fooled by userinfo naming an admitted host", () => {
    // URL.hostname is evil.com here; the credential-shaped prefix is decoration.
    expect(decide(policy, "GET", at("https://github.com@evil.com/acme/widget/info/refs?service=git-upload-pack")).ok).toBe(false);
  });

  it("refuses the LFS object host unless the grant opted in", () => {
    expect(decide(policy, "GET", at("https://objects.githubusercontent.com/x")).ok).toBe(false);
    expect(decide(lfsPolicy, "GET", at("https://objects.githubusercontent.com/x")).ok).toBe(true);
  });
});

describe("buildGrant", () => {
  it("admits exactly the hosts it maps a handler to", () => {
    const grant = buildGrant(PARAMS);
    expect(grant.allow).toEqual(grant.handlers.map((h) => h.host));
    expect(grant.allow).toEqual(["github.com", "codeload.github.com"]);
  });

  it("emits concrete hostnames, never a glob", () => {
    // A glob would admit hosts no handler is mapped to, and precedence ends in
    // public egress — those would get a direct, uninspected fetch.
    for (const host of buildGrant(LFS_PARAMS).allow) expect(host).not.toContain("*");
  });

  it("adds the LFS object host only when asked", () => {
    expect(buildGrant(PARAMS).allow).not.toContain("objects.githubusercontent.com");
    expect(buildGrant(LFS_PARAMS).allow).toContain("objects.githubusercontent.com");
  });

  it("carries the write sinks as denies", () => {
    expect(buildGrant(PARAMS).deny).toEqual([...WRITE_SINKS]);
  });

  it("refuses a malformed repo slug rather than widening every path rule", () => {
    for (const repo of ["", "widget", "acme/widget/extra", "acme/*", "../../etc"])
      expect(() => buildGrant({ ...PARAMS, repo })).toThrow(/malformed repo/);
  });

  it("refuses a grant with no container to bind to", () => {
    expect(() => buildGrant({ ...PARAMS, containerId: "" })).toThrow(/containerId/);
  });

  it("freezes the recipe's repo into handler params", () => {
    const params = grantParamsFor({ owner: "acme", name: "widget" }, CONTAINER);
    expect(buildGrant(params).handlers.every((h) => h.params.repo === "acme/widget")).toBe(true);
  });
});

/** A GrantTarget that records call order and can be made to fail. */
function target(failOn: string[] = []) {
  const calls: string[] = [];
  const record = async (name: string) => {
    calls.push(name);
    if (failOn.includes(name)) throw new Error(`boom: ${name}`);
  };
  const t: GrantTarget = {
    allowHost: (h) => record(`allow:${h}`),
    removeAllowedHost: (h) => record(`unallow:${h}`),
    denyHost: (h) => record(`deny:${h}`),
    removeDeniedHost: (h) => record(`undeny:${h}`),
    setOutboundByHost: (h, m) => record(`map:${h}:${m}`),
    removeOutboundByHost: (h) => record(`unmap:${h}`),
  };
  return { calls, t };
}

describe("applyGrant / revokeGrant", () => {
  it("maps every handler before admitting any host", () => {
    const { calls, t } = target();
    const grant = buildGrant(PARAMS);
    return applyGrant(t, grant).then(() => {
      const firstAllow = calls.findIndex((c) => c.startsWith("allow:"));
      const lastMap = calls.map((c) => c.startsWith("map:")).lastIndexOf(true);
      // Admitting before mapping would leave a window where requests fall
      // through precedence to public egress.
      expect(lastMap).toBeLessThan(firstAllow);
    });
  });

  it("drops admission before unmapping handlers", async () => {
    const { calls, t } = target();
    await revokeGrant(t, buildGrant(PARAMS));
    const lastUnallow = calls.map((c) => c.startsWith("unallow:")).lastIndexOf(true);
    const firstUnmap = calls.findIndex((c) => c.startsWith("unmap:"));
    expect(lastUnallow).toBeLessThan(firstUnmap);
  });

  it("completes the revoke even when one call throws", async () => {
    const { calls, t } = target(["unallow:github.com"]);
    await expect(revokeGrant(t, buildGrant(PARAMS))).rejects.toThrow(/revoke call/);
    // The failure must not strand a host admitted with its handler gone.
    expect(calls).toContain("unallow:codeload.github.com");
    expect(calls).toContain("unmap:github.com");
  });

  it("leaves the write sinks denied — a deny is a floor, not part of the grant", async () => {
    // `removeDeniedHost` filters `effectiveDeniedHosts`, so revoking a deny
    // would fold a future class-level list into an override missing that host.
    const { calls, t } = target();
    await revokeGrant(t, buildGrant(PARAMS));
    expect(calls.some((c) => c.startsWith("undeny:"))).toBe(false);
  });
});

describe("handler — binding", () => {
  it("refuses when no grant params are bound", async () => {
    const { calls, fetch } = recorder([]);
    const res = await serve(
      new Request("https://github.com/acme/widget/info/refs?service=git-upload-pack"),
      { fetch },
      { containerId: CONTAINER, className: "SubstrateSandboxTask", params: undefined },
    );
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it("refuses when the grant was issued to a different container", async () => {
    const { calls, fetch } = recorder([]);
    const res = await serve(
      new Request("https://github.com/acme/widget/info/refs?service=git-upload-pack"),
      { fetch },
      { containerId: "someone-elses-container", className: "SubstrateSandboxTask", params: PARAMS },
    );
    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(/different container/);
    expect(calls).toHaveLength(0);
  });
});

describe("handler — denial events (ADR-0005)", () => {
  it("records a denial with the request's host, method, path and the rule's reason", async () => {
    const denials: Omit<DenialEvent, "count">[] = [];
    const { fetch } = recorder([]);
    const res = await serve(
      new Request("https://github.com/acme/widget/git-receive-pack", { method: "POST" }),
      { fetch, recordDenial: (e) => denials.push(e) },
    );
    expect(res.status).toBe(403);
    expect(denials).toEqual([
      {
        host: "github.com",
        method: "POST",
        path: "/acme/widget/git-receive-pack",
        reason: expect.stringMatching(/outside the grant/),
      },
    ]);
  });

  it("records the redirect target on a refused redirect, not the first hop", async () => {
    const denials: Omit<DenialEvent, "count">[] = [];
    const { fetch } = recorder([redirectTo("https://evil.com/collect?d=secret")]);
    await serve(new Request("https://github.com/acme/widget/archive/main.tar.gz"), {
      fetch,
      recordDenial: (e) => denials.push(e),
    });
    expect(denials).toHaveLength(1);
    expect(denials[0]).toMatchObject({ host: "evil.com", path: "/collect" });
  });

  it("records nothing on an admitted request", async () => {
    const denials: Omit<DenialEvent, "count">[] = [];
    const { fetch } = recorder([new Response("ok")]);
    const res = await serve(
      new Request("https://github.com/acme/widget/info/refs?service=git-upload-pack"),
      { fetch, recordDenial: (e) => denials.push(e) },
    );
    expect(res.status).toBe(200);
    expect(denials).toHaveLength(0);
  });

  it("never surfaces the denial record into the container's 403 body", async () => {
    // Oracle resistance: the body names the rule, the record carries the
    // request — a hostile process must not learn the policy's shape from text.
    const { fetch } = recorder([]);
    const res = await serve(
      new Request("https://github.com/acme/widget/git-receive-pack", { method: "POST" }),
      { fetch, recordDenial: () => {} },
    );
    const body = await res.text();
    expect(body).not.toContain(CONTAINER);
  });
});

describe("handler — request construction", () => {
  it("sends redirect: manual and never forwards the container's Request object", async () => {
    const { calls, fetch } = recorder([new Response("ok")]);
    await serve(
      new Request("https://github.com/acme/widget/info/refs?service=git-upload-pack", {
        headers: { "git-protocol": "version=2", accept: "*/*" },
      }),
      { fetch },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init.redirect).toBe("manual");
    expect(typeof calls[0]!.url).toBe("string");
  });

  it("drops credential-shaped headers the container invented", async () => {
    const { calls, fetch } = recorder([new Response("ok")]);
    await serve(
      new Request("https://github.com/acme/widget/info/refs?service=git-upload-pack", {
        headers: {
          authorization: "Bearer stolen-token",
          cookie: "session=stolen",
          "x-forwarded-for": "10.0.0.1",
          "git-protocol": "version=2",
        },
      }),
      { fetch },
    );
    const sent = new Headers(calls[0]!.init.headers as HeadersInit);
    expect(sent.get("authorization")).toBeNull();
    expect(sent.get("cookie")).toBeNull();
    expect(sent.get("x-forwarded-for")).toBeNull();
    // The one header a v2 clone genuinely needs still rides along.
    expect(sent.get("git-protocol")).toBe("version=2");
  });

  it("strips set-cookie from the response", async () => {
    const { fetch } = recorder([
      new Response("ok", { headers: { "set-cookie": "a=b", "content-type": "text/plain" } }),
    ]);
    const res = await serve(
      new Request("https://github.com/acme/widget/info/refs?service=git-upload-pack"),
      { fetch },
    );
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("content-type")).toBe("text/plain");
  });

  it("denies before any fetch when the path is outside the grant", async () => {
    const { calls, fetch } = recorder([new Response("ok")]);
    const res = await serve(new Request("https://github.com/acme/widget/git-receive-pack", { method: "POST" }), { fetch });
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
  });
});

describe("handler — redirects", () => {
  it("follows a redirect that lands inside the grant", async () => {
    const { calls, fetch } = recorder([
      redirectTo("https://codeload.github.com/acme/widget/tar.gz/main"),
      new Response("tarball"),
    ]);
    const res = await serve(new Request("https://github.com/acme/widget/archive/main.tar.gz"), { fetch });
    expect(res.status).toBe(200);
    expect(calls.map((c) => c.url)).toEqual([
      "https://github.com/acme/widget/archive/main.tar.gz",
      "https://codeload.github.com/acme/widget/tar.gz/main",
    ]);
  });

  it("refuses a redirect off the allowlist — the channel through the allowlist", async () => {
    const { calls, fetch } = recorder([redirectTo("https://evil.com/collect?d=secret")]);
    const res = await serve(new Request("https://github.com/acme/widget/archive/main.tar.gz"), { fetch });
    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(/redirect to evil.com/);
    // The point of the control: the second leg never happened.
    expect(calls).toHaveLength(1);
  });

  it("refuses a redirect to a denied write sink", async () => {
    const { calls, fetch } = recorder([redirectTo("https://gist.github.com/acme/widget/tar.gz/main")]);
    const res = await serve(new Request("https://github.com/acme/widget/archive/main.tar.gz"), { fetch });
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(1);
  });

  it("refuses a redirect that stays on an admitted host but leaves the granted path", async () => {
    const { calls, fetch } = recorder([redirectTo("https://codeload.github.com/attacker/sink/tar.gz/main")]);
    const res = await serve(new Request("https://github.com/acme/widget/archive/main.tar.gz"), { fetch });
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(1);
  });

  it("refuses a protocol downgrade on the redirect leg", async () => {
    const { fetch } = recorder([redirectTo("http://codeload.github.com/acme/widget/tar.gz/main")]);
    const res = await serve(new Request("https://github.com/acme/widget/archive/main.tar.gz"), { fetch });
    expect(res.status).toBe(403);
  });

  it("re-decides a relative Location against the current target", async () => {
    const { calls, fetch } = recorder([redirectTo("/attacker/sink/tar.gz/main"), new Response("nope")]);
    const res = await serve(new Request("https://github.com/acme/widget/archive/main.tar.gz"), { fetch });
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(1);
  });

  it("downgrades a 302 to GET and drops the body", async () => {
    const { calls, fetch } = recorder([
      redirectTo("https://github.com/acme/widget/info/refs?service=git-upload-pack"),
      new Response("refs"),
    ]);
    const res = await serve(
      new Request("https://github.com/acme/widget/git-upload-pack", {
        method: "POST",
        body: "0000",
        headers: { "content-type": "application/x-git-upload-pack-request" },
      }),
      { fetch },
    );
    expect(res.status).toBe(200);
    expect(calls[1]!.init.method).toBe("GET");
    expect(calls[1]!.init.body).toBeUndefined();
  });

  it("re-decides the preserved method on a 308 rather than trusting the first hop", async () => {
    const { calls, fetch } = recorder([
      redirectTo("https://codeload.github.com/acme/widget/tar.gz/main", 308),
    ]);
    const res = await serve(
      new Request("https://github.com/acme/widget/git-upload-pack", {
        method: "POST",
        body: "0000",
        headers: { "content-type": "application/x-git-upload-pack-request" },
      }),
      { fetch },
    );
    // codeload has no POST rule, so the preserved-method hop is refused.
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(1);
  });

  it("stops a redirect loop rather than following it forever", async () => {
    const hop = () => redirectTo("https://github.com/acme/widget/archive/main.tar.gz");
    const { calls, fetch } = recorder([hop(), hop(), hop(), hop(), hop(), hop(), hop(), hop()]);
    const res = await serve(new Request("https://github.com/acme/widget/archive/main.tar.gz"), { fetch });
    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(/too many redirects/);
    expect(calls.length).toBeLessThanOrEqual(6);
  });
});

describe("handler — bodies are sinks", () => {
  it("caps the upload-pack body", async () => {
    const { calls, fetch } = recorder([new Response("ok")]);
    const res = await serve(
      new Request("https://github.com/acme/widget/git-upload-pack", {
        method: "POST",
        body: "x".repeat(1024 * 1024 + 1),
        headers: { "content-type": "application/x-git-upload-pack-request" },
      }),
      { fetch },
    );
    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(/over the .* cap/);
    expect(calls).toHaveLength(0);
  });

  it("passes an upload-pack body within the cap", async () => {
    const { calls, fetch } = recorder([new Response("pack")]);
    const res = await serve(
      new Request("https://github.com/acme/widget/git-upload-pack", {
        method: "POST",
        body: "0032want deadbeef\n0000",
        headers: { "content-type": "application/x-git-upload-pack-request" },
      }),
      { fetch },
    );
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it("refuses an LFS batch that asks to upload — same URL, same method, different intent", async () => {
    const { calls, fetch } = recorder([new Response("ok")]);
    const res = await serveGrantedRequest(
      new Request("https://github.com/acme/widget/info/lfs/objects/batch", {
        method: "POST",
        body: JSON.stringify({ operation: "upload", objects: [{ oid: "abc", size: 1 }] }),
        headers: { "content-type": "application/vnd.git-lfs+json" },
      }),
      { ...CTX, params: LFS_PARAMS },
      { fetch },
    );
    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(/is not download/);
    expect(calls).toHaveLength(0);
  });

  it("admits an LFS batch that asks to download", async () => {
    const { fetch } = recorder([new Response("{}")]);
    const res = await serveGrantedRequest(
      new Request("https://github.com/acme/widget/info/lfs/objects/batch", {
        method: "POST",
        body: JSON.stringify({ operation: "download", objects: [{ oid: "abc", size: 1 }] }),
        headers: { "content-type": "application/vnd.git-lfs+json" },
      }),
      { ...CTX, params: LFS_PARAMS },
      { fetch },
    );
    expect(res.status).toBe(200);
  });

  it("refuses an unparseable LFS batch body rather than passing it through", async () => {
    const { fetch } = recorder([new Response("{}")]);
    const res = await serveGrantedRequest(
      new Request("https://github.com/acme/widget/info/lfs/objects/batch", {
        method: "POST",
        body: "not json",
        headers: { "content-type": "application/vnd.git-lfs+json" },
      }),
      { ...CTX, params: LFS_PARAMS },
      { fetch },
    );
    expect(res.status).toBe(403);
  });

  it("refuses the LFS batch endpoint entirely when the grant did not opt in", async () => {
    const { fetch } = recorder([new Response("{}")]);
    const res = await serve(
      new Request("https://github.com/acme/widget/info/lfs/objects/batch", {
        method: "POST",
        body: JSON.stringify({ operation: "download" }),
        headers: { "content-type": "application/vnd.git-lfs+json" },
      }),
      { fetch },
    );
    expect(res.status).toBe(403);
  });
});

describe("egressHandlers", () => {
  it("exposes publicRepo under the name a grant maps to", () => {
    expect(typeof egressHandlers.publicRepo).toBe("function");
    expect(buildGrant(PARAMS).handlers.every((h) => h.method in egressHandlers)).toBe(true);
  });

  it("refuses an unbound call without reaching the network", async () => {
    const res = await egressHandlers.publicRepo(
      new Request("https://github.com/acme/widget/info/refs?service=git-upload-pack"),
      {},
      { containerId: CONTAINER, className: "SubstrateSandboxTask", params: undefined },
    );
    expect(res.status).toBe(403);
  });
});
