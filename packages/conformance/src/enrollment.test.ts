// Device enrollment and the executor connect route on the composed control plane: the control plane Worker under
// workerd through Miniflare, one deploy per deployment, each with the plane id its operator overlay renders. The
// Worker's answers are checked against mameko's own verdicts: its connect verifier under the overlay's
// `executors.planeId` on the Worker's executor registry, and its `registerDevice` under the Worker's profile on a
// fresh host-cloudflare database.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decodeOverlay } from "@fractalboxdev/flare-dispatch-ops/overlay";
import {
  renderTemplate,
  stripJsonc,
} from "@fractalboxdev/flare-dispatch-ops/render";
import { deviceSlotDefaults } from "@fractalboxdev/flare-dispatch-profile";
import {
  CONNECT_HEADERS,
  connectMessage,
  registerDevice,
  verifyConnectUpgrade,
  type ConnectCheck,
  type RegistrationResult,
} from "@fractalboxdev/mameko-coordinator";
import {
  d1LeaseStore,
  runD1Migrations,
  type D1Like,
} from "@fractalboxdev/mameko-host-cloudflare/d1";
import { LeaseStore } from "@fractalboxdev/mameko-ports";
import { Effect } from "effect";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  profileOf,
  type ControlPlaneEnv,
} from "../../../apps/control-plane/src/config.ts";
import {
  AUD,
  newDevice,
  OPERATOR,
  registration,
  startAccessTeam,
  type AccessTeam,
} from "../../../apps/control-plane/test/support.ts";

const CONNECT_PATH = "/v1/executors/connect";
const APP = join(import.meta.dirname, "../../../apps/control-plane");

const DEV_REPOSITORY = {
  repository: "fractalboxdev/flare-dispatch",
  installation: 1,
  default_branch: "main",
  head: "f".repeat(40),
  confidentiality: "non-confidential",
  files: {},
};

/** The `PLANE_ID` var the control plane's `wrangler.jsonc` renders from an overlay whose `executors.planeId` is `planeId`. */
const renderedPlaneId = (team: AccessTeam, planeId: string): unknown => {
  const overlay = Effect.runSync(
    decodeOverlay(
      JSON.stringify({
        accountId: "00000000000000000000000000000000",
        d1: { DB: "00000000-0000-0000-0000-000000000000" },
        kv: { CONFIG: "00000000000000000000000000000000" },
        r2: { CACHE: "conformance-cache", ARTIFACTS: "conformance-artifacts" },
        hostnames: {
          dispatcher: "dispatch.example.com",
          docs: "docs.example.com",
        },
        access: { teamDomain: team.teamDomain, aud: AUD },
        operators: [OPERATOR],
        dispatchers: [OPERATOR],
        github: { appId: "0", appSlug: "flare-dispatch", fixtureRepo: DEV_REPOSITORY.repository },
        executors: { planeId },
        alerts: { sink: "https://alerts.example.com/hook" },
      }),
    ),
  );
  const template = readFileSync(join(APP, "wrangler.jsonc"), "utf8");
  const rendered = Effect.runSync(
    renderTemplate("control-plane", template, overlay),
  );
  return (JSON.parse(stripJsonc(rendered)) as { vars: Record<string, unknown> })
    .vars["PLANE_ID"];
};

interface Plane {
  readonly deployment: "development" | "production";
  /** The overlay's `executors.planeId`. */
  readonly planeId: string;
  readonly mf: Miniflare;
}

let team: AccessTeam;
let planes: readonly Plane[];
/** A Worker with no route of its own, holding the reference databases mameko's `registerDevice` writes. */
let scratch: Miniflare;

beforeAll(async () => {
  team = await startAccessTeam();
  const bundle = await build({
    entryPoints: [join(APP, "src/worker.ts")],
    bundle: true,
    format: "esm",
    platform: "browser",
    write: false,
    external: ["cloudflare:*"],
  });
  const script = bundle.outputFiles[0]!.text;
  const deploy = (deployment: Plane["deployment"], planeId: string): Plane => ({
    deployment,
    planeId,
    mf: new Miniflare({
      modules: [{ type: "ESModule", path: "worker.js", contents: script }],
      compatibilityDate: "2026-05-01",
      d1Databases: { DB: `control-plane-${deployment}` },
      durableObjects: {
        CHANNEL: { className: "ExecutorChannel", useSQLite: true },
        EXECUTION: { className: "ExecutionEngine", useSQLite: true },
        EPOCH_ANCHOR: { className: "EpochAnchor", useSQLite: true },
        MONITOR: { className: "LivenessMonitor", useSQLite: true },
        CACHE_LEDGER: { className: "CacheLedger", useSQLite: true },
      },
      r2Buckets: ["CACHE"],
      bindings: {
        DEPLOYMENT: deployment,
        PLANE_ID: String(renderedPlaneId(team, planeId)),
        ACCESS_TEAM_DOMAIN: team.teamDomain,
        ACCESS_AUD: AUD,
        OPERATORS: JSON.stringify([OPERATOR]),
        DISPATCHERS: JSON.stringify([OPERATOR]),
        FD_DEV_REPOSITORY: JSON.stringify(DEV_REPOSITORY),
      },
    }),
  });
  planes = [
    deploy("development", "plane-north"),
    deploy("production", "plane-south"),
  ];
  scratch = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response(''); } }",
    compatibilityDate: "2026-05-01",
    d1Databases: Array.from({ length: 4 }, (_, i) => `REF${i}`),
  });
  await Promise.all([...planes.map((p) => p.mf.ready), scratch.ready]);
}, 120_000);

afterAll(async () => {
  await Promise.all([
    ...(planes ?? []).map((p) => p.mf.dispose()),
    scratch?.dispose(),
  ]);
  await team?.close();
});

const dbOf = async (mf: Miniflare) =>
  (await mf.getD1Database("DB")) as unknown as D1Like;

const accessHeaders = async (): Promise<Record<string, string>> => ({
  "cf-access-jwt-assertion": await team.jwt(OPERATOR),
});

const register = async (mf: Miniflare, body: unknown) =>
  mf.dispatchFetch("http://x/v1/executors/register", {
    method: "POST",
    headers: { "content-type": "application/json", ...(await accessHeaders()) },
    body: JSON.stringify(body),
  });

type Device = Awaited<ReturnType<typeof newDevice>>;

const enroll = async (mf: Miniflare, executorId: string): Promise<Device> => {
  const device = await newDevice();
  const r = await register(mf, registration(executorId, device.identity));
  expect(r.status, await r.clone().text()).toBe(201);
  return device;
};

/** The headers of a `device` upgrade signed by `keys` for `planeId` at `at`. */
const signedHeaders = async (
  executorId: string,
  keys: Device["keys"],
  planeId: string,
  at: number = Date.now(),
): Promise<Record<string, string>> => {
  const nonce = randomBytes(32).toString("hex");
  const message = await connectMessage({
    method: "GET",
    path: CONNECT_PATH,
    executorId,
    planeId,
    connectAt: at,
    nonce,
  });
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    keys.privateKey,
    new Uint8Array(message),
  );
  return {
    [CONNECT_HEADERS.executorId]: executorId,
    [CONNECT_HEADERS.at]: String(at),
    [CONNECT_HEADERS.nonce]: nonce,
    [CONNECT_HEADERS.signature]: Buffer.from(signature).toString("base64"),
  };
};

/** mameko's connect verdict on `headers` under `planeId`, against the executor registry of the Worker's database. */
const mamekoVerdict = async (
  db: D1Like,
  headers: Record<string, string>,
  planeId: string,
): Promise<ConnectCheck> =>
  verifyConnectUpgrade(new Headers(headers), {
    method: "GET",
    path: CONNECT_PATH,
    planeId,
    now: Date.now(),
    executor: (executorId) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const row = yield* (yield* LeaseStore).get(executorId);
          return row === null
            ? null
            : {
                devicePublicKey: row.devicePublicKey,
                revoked: row.revokedAt !== null,
                quarantined: row.quarantine,
              };
        }).pipe(Effect.provide(d1LeaseStore(db))),
      ),
  });

/** The Worker's answer to an upgrade on the connect route: an open socket, or the status and body of a refusal. */
const workerAnswer = async (mf: Miniflare, headers: Record<string, string>) => {
  const r = await mf.dispatchFetch(`http://x${CONNECT_PATH}`, {
    headers: { Upgrade: "websocket", ...headers },
  });
  const ws = r.webSocket;
  if (ws !== null && ws !== undefined) {
    ws.accept();
    ws.close(1000);
    return { status: r.status, socket: true, body: "" };
  }
  return { status: r.status, socket: false, body: await r.text() };
};

/** The executor row columns, as the coordinator's registry stores them. */
const executorRow = async (db: D1Like, executorId: string) =>
  (db as unknown as D1Database)
    .prepare("select * from executors where executor_id = ?")
    .bind(executorId)
    .first<Record<string, unknown>>();

/** A host-cloudflare database at mameko's migrations, with no executor row: one of the scratch Worker's D1 bindings. */
let references = 0;
const referenceDb = async (): Promise<D1Like> => {
  const db = (await scratch.getD1Database(
    `REF${references++}`,
  )) as unknown as D1Like;
  await runD1Migrations(db);
  return db;
};

/** mameko's `registerDevice` on `db` for the body the register route received, under the Worker's own profile. */
const mamekoRegister = (
  db: D1Like,
  deployment: Plane["deployment"],
  body: ReturnType<typeof registration>,
): Promise<RegistrationResult> => {
  const identity = body.identity as Device["identity"];
  const { interactive, batch } = deviceSlotDefaults.claim_caps;
  return Effect.runPromise(
    registerDevice(
      {
        executorId: body.executor_id,
        identity: {
          publicKey: identity.public_key,
          keyStore: identity.key_store as "software",
          certificateChain: identity.certificate_chain,
          evidence: identity.evidence,
        },
        labels: body.labels,
        slots: { interactive, batch },
        protocolVersion: body.protocol_version,
        codeHash: body.code_hash,
      },
      {
        registration: profileOf({
          DEPLOYMENT: deployment,
        } as unknown as ControlPlaneEnv).registration,
        now: Date.now(),
        posture: () => Effect.succeed("unmanaged" as const),
        verify: () => Effect.succeed(false),
      },
    ).pipe(Effect.provide(d1LeaseStore(db))),
  );
};

describe("the executor connect route", () => {
  it("[FD-IFC-085] renders each overlay's executors.planeId as the deploy's plane id", () => {
    expect(renderedPlaneId(team, "plane-north")).toBe("plane-north");
    expect(renderedPlaneId(team, "plane-south")).toBe("plane-south");
  });

  for (const index of [0, 1]) {
    it(`[FD-IFC-085] opens a socket exactly for the upgrades mameko's verifier accepts under the overlay's executors.planeId (deploy ${index})`, async () => {
      const plane = planes[index]!;
      const other = planes[1 - index]!;
      const db = await dbOf(plane.mf);
      const device = await enroll(plane.mf, "verdict-device");
      const stranger = await newDevice();
      const cases: readonly {
        readonly name: string;
        readonly headers: Record<string, string>;
        /** mameko's verdict: `Accepted`, or the reason it refuses. */
        readonly verdict: string;
      }[] = [
        {
          name: "signed for the overlay's plane",
          headers: await signedHeaders(
            "verdict-device",
            device.keys,
            plane.planeId,
          ),
          verdict: "Accepted",
        },
        {
          name: "signed for the other deploy's plane",
          headers: await signedHeaders(
            "verdict-device",
            device.keys,
            other.planeId,
          ),
          verdict: "signature",
        },
        {
          name: "signed outside the 60 s window",
          headers: await signedHeaders(
            "verdict-device",
            device.keys,
            plane.planeId,
            Date.now() - 61_000,
          ),
          verdict: "clock",
        },
        {
          name: "signed by a key the registry does not hold",
          headers: await signedHeaders(
            "verdict-device",
            stranger.keys,
            plane.planeId,
          ),
          verdict: "signature",
        },
        {
          name: "signed for an executor id with no row",
          headers: await signedHeaders(
            "never-enrolled",
            device.keys,
            plane.planeId,
          ),
          verdict: "unknown",
        },
        {
          name: "an Access JWT",
          headers: await accessHeaders(),
          verdict: "unsigned",
        },
        {
          name: "an Access JWT naming the enrolled executor",
          headers: {
            ...(await accessHeaders()),
            [CONNECT_HEADERS.executorId]: "verdict-device",
          },
          verdict: "unsigned",
        },
        {
          name: "a bearer token naming the enrolled executor",
          headers: {
            authorization: `Bearer ${await team.jwt(OPERATOR)}`,
            [CONNECT_HEADERS.executorId]: "verdict-device",
          },
          verdict: "unsigned",
        },
      ];
      for (const c of cases) {
        const verdict = await mamekoVerdict(db, c.headers, plane.planeId);
        const expected =
          verdict._tag === "Accepted" ? "Accepted" : verdict.reason;
        expect(expected, c.name).toBe(c.verdict);
        const answer = await workerAnswer(plane.mf, c.headers);
        if (verdict._tag === "Accepted")
          expect(answer, c.name).toMatchObject({ status: 101, socket: true });
        else
          expect(answer, c.name).toEqual({
            status: 403,
            socket: false,
            body: `upgrade refused: ${verdict.reason}`,
          });
      }
    });
  }

  it("[FD-IFC-085] refuses a signed upgrade for a quarantined or revoked executor row", async () => {
    const plane = planes[0]!;
    const db = await dbOf(plane.mf);
    const sql = db as unknown as D1Database;
    const quarantined = await enroll(plane.mf, "quarantined-device");
    const revoked = await enroll(plane.mf, "revoked-device");
    await sql
      .prepare("update executors set quarantine = 1 where executor_id = ?")
      .bind("quarantined-device")
      .run();
    await sql
      .prepare("update executors set revoked_at = ? where executor_id = ?")
      .bind(Date.now(), "revoked-device")
      .run();
    for (const [executorId, device, reason] of [
      ["quarantined-device", quarantined, "quarantined"],
      ["revoked-device", revoked, "revoked"],
    ] as const) {
      const headers = await signedHeaders(
        executorId,
        device.keys,
        plane.planeId,
      );
      expect(await mamekoVerdict(db, headers, plane.planeId)).toMatchObject({
        reason,
      });
      expect(await workerAnswer(plane.mf, headers)).toEqual({
        status: 403,
        socket: false,
        body: `upgrade refused: ${reason}`,
      });
    }
  });
});

describe("device enrollment", () => {
  for (const index of [0, 1]) {
    it(`[FD-IFC-086] writes the executor row mameko's registerDevice writes under the profile's registration (deploy ${index})`, async () => {
      const plane = planes[index]!;
      const { identity } = await newDevice();
      // `runner:separated` comes only from a pool registration; registerDevice drops a device's claim to it.
      const body = registration("parity-device", identity, [
        "isolation:none",
        "runner:separated",
      ]);
      const r = await register(plane.mf, body);
      expect(r.status).toBe(201);
      const reference = await referenceDb();
      const result = await mamekoRegister(reference, plane.deployment, body);
      expect(result).toMatchObject({
        _tag: "Registered",
        executorId: "parity-device",
      });
      const answer = (await r.json()) as Record<string, unknown>;
      expect(answer).toMatchObject({
        executor_id: "parity-device",
        posture_tier: result._tag === "Registered" ? result.postureTier : null,
      });

      const written = await executorRow(await dbOf(plane.mf), "parity-device");
      const expected = await executorRow(reference, "parity-device");
      expect(expected).not.toBeNull();
      expect(written).toEqual(expected);
      expect(JSON.parse(String(written!["labels_json"]))).toEqual([
        "isolation:none",
      ]);
      expect(written).toMatchObject({
        kind: "device",
        key_store: "software",
        device_public_key: identity.public_key,
      });
    });

    it(`[FD-IFC-086] writes no row for each registration registerDevice refuses under the profile's registration (deploy ${index})`, async () => {
      const plane = planes[index]!;
      const { identity } = await newDevice();
      const refusals = [
        {
          executorId: "tpm-device",
          identity: { ...identity, key_store: "tpm" },
        },
        {
          executorId: "enclave-device",
          identity: { ...identity, key_store: "secure-enclave" },
        },
        {
          executorId: "keyless-device",
          identity: { ...identity, public_key: "bm90IGEga2V5" },
        },
      ];
      const reference = await referenceDb();
      for (const { executorId, identity: claimed } of refusals) {
        const body = registration(executorId, claimed);
        const result = await mamekoRegister(reference, plane.deployment, body);
        expect(result._tag, executorId).toBe("Refused");
        const r = await register(plane.mf, body);
        expect(r.status, executorId).toBe(403);
        const answer = (await r.json()) as { error: string; message: string };
        expect(answer.error).toBe("registration_refused");
        expect(answer.message).toBe(
          `registration refused: ${result._tag === "Refused" ? result.reason : ""}`,
        );
        expect(
          await executorRow(await dbOf(plane.mf), executorId),
          executorId,
        ).toBeNull();
        expect(await executorRow(reference, executorId), executorId).toBeNull();
      }
    });
  }
});
