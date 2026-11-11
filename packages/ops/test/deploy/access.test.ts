// The deploy suites of `V-DEPLOY` for the committed Access configuration (specs/operability.md § Access configuration
// and webhook silence): `fd deploy` applies the Access applications of the dispatcher's hostname and `fd doctor` reports
// each difference, on the fakes of `support.ts`, whose dispatcher hostname sits behind the account's Access.
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { ACCESS_BYPASS, placeholderOverlay } from "../../src/index.ts";
import { API, deploy, fd, isWrite, OVERLAY, SCRIPT, since, world, type World } from "./support.ts";

const HOST = placeholderOverlay.hostnames["dispatcher"]!;
const ACCESS = `api.cloudflare.com${API}/access/apps`;

/** The account's Access applications on the dispatcher's hostname, by domain. */
const onHost = (w: World) =>
  new Map(
    [...w.access.values()]
      .filter((a) => a["domain"] === HOST || String(a["domain"]).startsWith(`${HOST}/`))
      .map((a) => [a["domain"] as string, a]),
  );

const policiesOf = (app: Record<string, unknown> | undefined) =>
  (app?.["policies"] as { decision: string; include: unknown[] }[] | undefined)?.map((p) => ({
    decision: p.decision,
    include: p.include,
  }));

/** A request to the dispatcher's hostname with no Access session, as the fake edge answers it. */
const edge = (w: World, path: string) => w.fetcher(`https://${HOST}${path}`);

/** One concrete request path under each bypass pattern. */
const concrete = (pattern: string) => pattern.replace(/\*/g, "x1");

const accessWrites = (calls: readonly string[]) =>
  calls.filter((c) => /^(POST|PUT|DELETE) api\.cloudflare\.com\/.*\/access\/apps/.test(c));

/** The account's Access applications changed out of band. */
const tamper = (w: World) => {
  const hosted = onHost(w);
  const webhook = hosted.get(`${HOST}/v1/webhooks/github`)!;
  w.access.delete(webhook["id"] as string);
  const root = hosted.get(HOST)!;
  root["policies"] = [{ name: "identities", decision: "allow", include: [{ everyone: {} }] }];
  w.access.set("out-of-band-ops", {
    id: "out-of-band-ops",
    name: "ops bypass",
    type: "self_hosted",
    domain: `${HOST}/v1/ops/*`,
    session_duration: "24h",
    policies: [{ name: "bypass", decision: "bypass", include: [{ everyone: {} }] }],
  });
  w.access.set("other-host", {
    id: "other-host",
    name: "another application",
    type: "self_hosted",
    domain: "other.example.com",
    session_duration: "24h",
    policies: [{ name: "bypass", decision: "bypass", include: [{ everyone: {} }] }],
  });
};

describe("the committed Access configuration", () => {
  it("[FD-OPS-088] fd deploy creates the hostname's application for the overlay's identities and a bypass application per bypass path, after the Worker deploy and before the probe", async () => {
    const w = world({ access: "none" });
    const overlay = JSON.stringify({ ...placeholderOverlay, dispatchers: ["ci@acme.com"] });
    const report = await deploy(w, overlay);
    expect(report.ok).toBe(true);

    const hosted = onHost(w);
    expect([...hosted.keys()].sort()).toEqual(
      [HOST, ...ACCESS_BYPASS.map((b) => `${HOST}${b.path}`)].sort(),
    );
    expect(policiesOf(hosted.get(HOST))).toEqual([
      {
        decision: "allow",
        include: [
          { email: { email: placeholderOverlay.operators[0] } },
          { email: { email: "ci@acme.com" } },
        ],
      },
    ]);
    for (const b of ACCESS_BYPASS)
      expect(policiesOf(hosted.get(`${HOST}${b.path}`))).toEqual([
        { decision: "bypass", include: [{ everyone: {} }] },
      ]);

    // The Worker deploy, then every Access write, then the probe.
    const deployed = w.calls.indexOf(`wrangler deploy ${SCRIPT}`);
    const writes = w.calls.flatMap((c, i) => (c === `POST ${ACCESS}` ? [i] : []));
    const probe = w.calls.indexOf(`GET ${HOST}/health`);
    expect(writes).toHaveLength(ACCESS_BYPASS.length + 1);
    expect(deployed).toBeGreaterThanOrEqual(0);
    expect(writes.every((i) => i > deployed && i < probe)).toBe(true);
    expect(report.stages.find((s) => s.stage === "deploy")?.detail).toContain(
      `access created ${HOST}/v1/webhooks/github`,
    );

    // Access now passes every bypassed path with no Access session and sends every other path to the login.
    for (const b of ACCESS_BYPASS)
      expect({ path: b.path, status: (await edge(w, concrete(b.path))).status }).toEqual({
        path: b.path,
        status: 200,
      });
    for (const path of ["/", "/v1/ops/health", "/v1/executions", "/v1/spend", "/mcp"])
      expect({ path, status: (await edge(w, path)).status }).toEqual({ path, status: 302 });
  });

  it("[FD-OPS-088] a deploy over Access as committed reads the applications and writes none", async () => {
    const w = world();
    expect((await deploy(w)).ok).toBe(true);
    expect(w.calls.filter((c) => c.startsWith(`GET ${ACCESS}`)).length).toBeGreaterThan(0);
    expect(accessWrites(w.calls)).toEqual([]);
  });

  it("[FD-OPS-088] fd doctor fails on a removed bypass, an edited policy and an uncommitted application on the hostname, and changes nothing", async () => {
    const w = world();
    expect((await deploy(w)).ok).toBe(true);
    expect((await Effect.runPromise(fd(w).doctor(OVERLAY))).ok).toBe(true);
    tamper(w);
    const before = w.snapshot();
    const from = w.calls.length;

    const report = await Effect.runPromise(fd(w).doctor(OVERLAY));
    expect(report.ok).toBe(false);
    const detail = report.stages.find((s) => s.stage === "drift")!.detail.split("\n");
    expect(detail).toContain(
      `failure access.${HOST}/v1/webhooks/github: a committed Access application is absent`,
    );
    expect(detail).toContainEqual(
      expect.stringMatching(
        new RegExp(`^failure access\\.${HOST.replace(/\./g, "\\.")}: deployed .*"everyone"`),
      ),
    );
    expect(detail).toContain(
      `failure access.${HOST}/v1/ops/*: an Access application on the dispatcher's hostname the committed configuration does not hold`,
    );
    expect(detail.filter((l) => l.includes("other.example.com"))).toEqual([]);
    expect(since(w, from).filter(isWrite)).toEqual([]);
    expect(w.snapshot()).toBe(before);
  });

  it("[FD-OPS-088] fd deploy restores a removed bypass, replaces an edited application and removes an uncommitted one, leaving other hostnames alone", async () => {
    const w = world();
    expect((await deploy(w)).ok).toBe(true);
    tamper(w);
    expect((await edge(w, "/v1/webhooks/github")).status).toBe(302);
    expect((await edge(w, "/v1/ops/health")).status).toBe(200);

    const report = await deploy(w);
    expect(report.ok).toBe(true);
    const detail = report.stages.find((s) => s.stage === "deploy")!.detail;
    expect(detail).toContain(`access created ${HOST}/v1/webhooks/github`);
    expect(detail).toContain(`access replaced ${HOST}`);
    expect(detail).toContain(`access removed ${HOST}/v1/ops/*`);
    expect(w.access.has("other-host")).toBe(true);
    expect((await edge(w, "/v1/webhooks/github")).status).toBe(200);
    expect((await edge(w, "/v1/ops/health")).status).toBe(302);
    expect((await Effect.runPromise(fd(w).doctor(OVERLAY))).ok).toBe(true);
  });

  it("[FD-OPS-088] reads the hostname's applications past the first page of the account's list", async () => {
    const w = world({ access: "none" });
    for (let i = 0; i < 120; i++)
      w.access.set(`other-${i}`, {
        id: `other-${i}`,
        name: `other ${i}`,
        type: "self_hosted",
        domain: `app${i}.example.org`,
        session_duration: "24h",
        policies: [],
      });
    expect((await deploy(w)).ok).toBe(true);
    expect((await Effect.runPromise(fd(w).doctor(OVERLAY))).ok).toBe(true);
    const from = w.calls.length;
    expect((await deploy(w)).ok).toBe(true);
    expect(accessWrites(since(w, from))).toEqual([]);
    expect(onHost(w).size).toBe(ACCESS_BYPASS.length + 1);
  });

  it("[FD-OPS-088] a failed Access write stops the deploy before the probes and prints each Worker's rollback line", async () => {
    const w = world();
    expect((await deploy(w)).ok).toBe(true);
    tamper(w);
    w.state.accessFails = true;
    const from = w.calls.length;

    const report = await deploy(w);
    expect(report.ok).toBe(false);
    const last = report.stages.at(-1)!;
    expect(last.stage).toBe("deploy");
    expect(last.ok).toBe(false);
    expect(last.detail).toContain("403 Authentication error");
    expect(last.detail).toMatch(new RegExp(`wrangler rollback \\S+ --name ${SCRIPT}`));
    expect(since(w, from)).not.toContain(`GET ${HOST}/health`);
    expect(since(w, from).filter((c) => c.includes("/r2/") && c.startsWith("PUT"))).toEqual([]);
  });
});
