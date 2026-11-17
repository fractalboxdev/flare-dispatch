// The deploy suites of `V-DEPLOY` for the Access check (specs/operability.md § Access configuration and webhook
// silence): the Access applications on the dispatcher's hostname are managed outside FlareDispatch, and `fd deploy` and
// `fd doctor` read them, on the fakes of `support.ts`, and fail where one covers a machine path, a human path is left
// uncovered, or an application on a human path carries an AUD tag other than the overlay's `access.aud`. Neither
// writes an Access application.
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { HUMAN_PATHS, MACHINE_PATHS, placeholderOverlay, samplePath } from "../../src/index.ts";
import {
  API,
  deploy,
  fd,
  HOST,
  HUMAN_ACCESS,
  isWrite,
  OVERLAY,
  since,
  world,
  type World,
} from "./support.ts";

const ACCESS = `api.cloudflare.com${API}/access/apps`;

/** A request to the dispatcher's hostname with no Access session, as the fake edge answers it. */
const edge = (w: World, path: string) => w.fetcher(`https://${HOST}${path}`);

const accessWrites = (calls: readonly string[]) =>
  calls.filter((c) => /^(POST|PUT|DELETE|PATCH) api\.cloudflare\.com\/.*\/access\//.test(c));

/** An Access application on `paths` of the hostname, with `decision` for everyone. */
const app = (id: string, paths: readonly string[], decision = "allow", aud = `aud-${id}`) => ({
  id,
  name: id,
  type: "self_hosted",
  aud,
  domain: `${HOST}${paths[0]}`,
  destinations: paths.map((p) => ({ type: "public", uri: `${HOST}${p}` })),
  policies: [{ id: `${id}-policy`, name: decision, decision, include: [{ everyone: {} }] }],
});

type Report = {
  readonly ok: boolean;
  readonly stages: readonly { stage: string; ok: boolean; detail: string }[];
};
const driftDetail = (r: Report) => r.stages.find((s) => s.stage === "drift")!.detail;

/**
 * `fd doctor`, then `fd deploy`, on the account `change` leaves: both fail at the drift stage, the deploy before any
 * write; answers the doctor's drift detail.
 */
const refused = async (change: (w: World) => void) => {
  const w = world();
  change(w);
  const doctor = await Effect.runPromise(fd(w).doctor(OVERLAY));
  expect(doctor.ok).toBe(false);
  const report = await deploy(w);
  expect(report.ok).toBe(false);
  expect(report.stages.at(-1)).toMatchObject({ stage: "drift", ok: false });
  expect(w.calls.filter(isWrite)).toEqual([]);
  return driftDetail(doctor);
};

/** `fd doctor` and `fd deploy` on the account `change` leaves both pass, and no Access application is written. */
const admitted = async (change: (w: World) => void) => {
  const w = world();
  change(w);
  expect((await Effect.runPromise(fd(w).doctor(OVERLAY))).ok).toBe(true);
  expect((await deploy(w)).ok).toBe(true);
  expect(accessWrites(w.calls)).toEqual([]);
  return w;
};

describe("the Access check", () => {
  it("[FD-OPS-088] passes an account whose Access applications cover the human paths with the overlay's AUD and leave every machine path uncovered, reading the applications and writing none", async () => {
    const w = await admitted(() => undefined);
    expect(w.calls.filter((c) => c.startsWith(`GET ${ACCESS}`)).length).toBeGreaterThan(0);
    // The machine paths reach the dispatcher with no Access session; the human paths go to the login.
    for (const m of MACHINE_PATHS)
      expect({ path: m.path, status: (await edge(w, samplePath(m.path))).status }).toEqual({
        path: m.path,
        status: 200,
      });
    for (const h of HUMAN_PATHS)
      expect({ path: h.path, status: (await edge(w, samplePath(h.path))).status }).toEqual({
        path: h.path,
        status: 302,
      });
  });

  it("[FD-OPS-088] fails on an Access application that covers a machine path: one on the path, one on the bare hostname, or one below a machine pattern", async () => {
    const onPath = await refused(
      (w) => void w.access.set("hook", app("hook", ["/v1/webhooks/github"])),
    );
    expect(onPath).toContain(
      `failure access.${HOST}/v1/webhooks/github: Access application "hook" covers the webhook path, which must be reachable without Access`,
    );
    expect(onPath).not.toContain(`access.${HOST}/v1/dispatch/*`);

    const bare = await refused((w) => void w.access.set("bare", app("bare", [""])));
    for (const m of MACHINE_PATHS)
      expect(bare).toContain(`failure access.${HOST}${m.path}: Access application "bare" covers`);

    const below = await refused(
      (w) => void w.access.set("below", app("below", ["/v1/artifacts/secret"])),
    );
    expect(below).toContain(`failure access.${HOST}/v1/artifacts/*: Access application "below"`);
  });

  it("[FD-OPS-088] passes a machine path that an application with a bypass policy decides, the most specific application over the bare hostname's", async () => {
    await admitted((w) => {
      w.access.set("bare", app("bare", [""], "allow", placeholderOverlay.access.aud));
      for (const [i, m] of MACHINE_PATHS.entries())
        w.access.set(`bypass-${i}`, app(`bypass-${i}`, [m.path], "bypass"));
    });
    await admitted(
      (w) => void w.access.set("dispatch", app("dispatch", ["/v1/dispatch/*"], "bypass")),
    );
  });

  it("[FD-OPS-088] fails on a human path no Access application covers, or that only a bypass application decides", async () => {
    const none = await refused((w) => void w.access.clear());
    for (const h of HUMAN_PATHS)
      expect(none).toContain(
        `failure access.${HOST}${h.path}: no Access application covers the ${h.surface} path`,
      );

    const mcp = await refused((w) => {
      const human = w.access.get(HUMAN_ACCESS.id)!;
      human["destinations"] = HUMAN_ACCESS.destinations.filter((d) => !d.uri.endsWith("/mcp"));
    });
    expect(mcp.split("\n").filter((l) => l.startsWith("failure"))).toEqual([
      `failure access.${HOST}/mcp: no Access application covers the mcp path without a bypass policy: cover it with an application whose AUD is access.aud`,
    ]);

    const bypassed = await refused(
      (w) => void w.access.set("ops", app("ops", ["/v1/ops/*"], "bypass")),
    );
    expect(bypassed).toContain(`failure access.${HOST}/v1/ops/*: no Access application covers`);
  });

  it("[FD-OPS-088] fails on an application deciding a human path whose AUD tag is not the overlay's access.aud, and passes once the overlay carries it", async () => {
    const change = (w: World) => void (w.access.get(HUMAN_ACCESS.id)!["aud"] = "recreated-aud");
    const detail = await refused(change);
    expect(detail.split("\n").filter((l) => l.startsWith("failure"))).toEqual([
      `failure access.${HOST}.aud: Access application "${HUMAN_ACCESS.name}" has AUD "recreated-aud", the overlay's access.aud is ${JSON.stringify(placeholderOverlay.access.aud)}: the dispatcher rejects every Access JWT it issues; set access.aud to the application's AUD`,
    ]);

    // A second application on one human path, more specific than the first, with its own AUD tag.
    const ops = await refused((w) => void w.access.set("ops", app("ops", ["/v1/ops/*"])));
    expect(ops).toContain(`failure access.${HOST}.aud: Access application "ops" has AUD "aud-ops"`);

    const w = world();
    change(w);
    const overlay = JSON.stringify({
      ...placeholderOverlay,
      access: { ...placeholderOverlay.access, aud: "recreated-aud" },
    });
    expect((await deploy(w, overlay)).ok).toBe(true);
    expect(accessWrites(w.calls)).toEqual([]);
  });

  it("[FD-OPS-088] reads the hostname's applications past the first page of the account's list, and leaves other hostnames' applications out of the check", async () => {
    await admitted((w) => {
      for (let i = 0; i < 120; i++)
        w.access.set(`other-${i}`, {
          id: `other-${i}`,
          name: `other ${i}`,
          type: "self_hosted",
          domain: `app${i}.example.org`,
          policies: [],
        });
      // The human application last, on the second page.
      const human = w.access.get(HUMAN_ACCESS.id)!;
      w.access.delete(HUMAN_ACCESS.id);
      w.access.set(HUMAN_ACCESS.id, human);
    });
  });

  it("[FD-OPS-088] a token that cannot read the Access applications stops fd deploy at the drift check, before any write", async () => {
    const w = world();
    expect((await deploy(w)).ok).toBe(true);
    w.state.accessReadFails = true;
    const from = w.calls.length;

    const report = await deploy(w);
    expect(report.ok).toBe(false);
    const last = report.stages.at(-1)!;
    expect(last).toMatchObject({ stage: "drift", ok: false });
    expect(last.detail).toContain("403 Authentication error");
    expect(since(w, from).filter(isWrite)).toEqual([]);
  });
});
