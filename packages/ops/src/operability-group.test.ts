// The operability group as the control plane serves it: `OperabilityHandlers` mounted through the router, behind its
// identity gates and error model, over a SQLite D1 and stub spend and manifest-conversion services.
import { ApiConfig } from "@fractalboxdev/flare-dispatch-api/config";
import { operabilityGroup } from "@fractalboxdev/flare-dispatch-api/groups";
import { accessIssuer } from "@fractalboxdev/flare-dispatch-api/identity";
import { mount, toFetchHandler } from "@fractalboxdev/flare-dispatch-api/router";
import {
  accessClaims,
  baseConfig,
  jwksLayer,
  makeSigner,
  MEMBER,
  OPERATOR,
  ORIGIN,
  TEAM,
  type Signer,
} from "@fractalboxdev/flare-dispatch-api/test-support";
import type { D1Like } from "@fractalboxdev/mameko-host-cloudflare/d1";
import { Context, Effect } from "effect";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sqliteDb, type TestDb } from "./d1.test-support.ts";
import {
  ManifestConversion,
  OperabilityHandlers,
  OpsStore,
  SpendUnreadable,
  SpendView,
  STATE_TTL_MS,
  type AppCredentials,
  type SpendViewBody,
} from "./index.ts";

let access: Signer;
let fetchHandler: ReturnType<typeof toFetchHandler>;
beforeAll(async () => {
  access = await makeSigner("access-kid");
  fetchHandler = toFetchHandler(mount(operabilityGroup(OperabilityHandlers)), {
    shared: jwksLayer({ [`${accessIssuer(TEAM)}/cdn-cgi/access/certs`]: [access.jwk] }),
  });
});

let t: TestDb;
beforeEach(async () => {
  t = await sqliteDb();
});
afterEach(() => t.dispose());

const VIEW: SpendViewBody = {
  month: "2027-01",
  budget: 50_000_000,
  settled: 1_000_000,
  reserved: 200_000,
  committed: 1_200_000,
  classes: [{ class: "batch", line: 9_000_000, lane: 410_000, admitted_list_rate: 0, reserve: 0 }],
  floor: 2_000_000,
  measured_reserve_runway_days: 12,
  control_state: "run",
  resets_at: 0,
};

const CREDENTIALS: AppCredentials = {
  id: 7,
  slug: "fd",
  pem: "-----BEGIN KEY-----",
  webhookSecret: "whsec",
  clientId: "cid",
  clientSecret: "cs",
};

interface Setup {
  readonly now?: number;
  readonly db?: D1Like;
  readonly spend?: SpendView["Service"];
  /** Whether the deploy supplies a manifest conversion. */
  readonly conversion?: boolean;
}

/** A client of the mounted group; each call names its Access identity and Access session. */
const setup = (options: Setup = {}) => {
  const now = options.now ?? Date.now();
  const conversions: string[] = [];
  const months: string[] = [];
  let services = Context.make(ApiConfig, baseConfig()).pipe(
    Context.add(OpsStore, { db: options.db ?? t.db, now: () => now }),
    Context.add(
      SpendView,
      options.spend ?? { view: (m) => Effect.sync(() => (months.push(m), VIEW)) },
    ),
  );
  if (options.conversion !== false)
    services = services.pipe(
      Context.add(ManifestConversion, {
        convert: (code) => Effect.sync(() => (conversions.push(code), CREDENTIALS)),
      }),
    ) as never;
  const call = async (
    identity: string | null,
    path: string,
    init: RequestInit & { readonly sub?: string } = {},
  ) => {
    const { sub, ...rest } = init;
    const headers: Record<string, string> = {};
    if (identity !== null)
      headers["cf-access-jwt-assertion"] = await access.sign(
        accessClaims(identity, { sub: sub ?? `session-of-${identity}` }),
      );
    return fetchHandler.fetch(
      new Request(`${ORIGIN}${path}`, { ...rest, headers }),
      services as never,
    );
  };
  const body = async (r: Response) => (await r.json()) as Record<string, unknown>;
  /** A state `/v1/github/install/new` issues to the identity and session. */
  const issue = async (identity: string, sub?: string) => {
    const page = await (
      await call(identity, "/v1/github/install/new", sub === undefined ? {} : { sub })
    ).text();
    return decodeURIComponent(/state=([^"&]+)/.exec(page)![1]!);
  };
  return { call, body, issue, conversions, months };
};

/** A D1 whose reads of one table fail, as a store outage would. */
const failingOn = (db: D1Like, table: string): D1Like => ({
  ...db,
  prepare: (sql: string) => {
    if (/^\s*select\b/i.test(sql) && sql.includes(`from ${table}`))
      return {
        bind: () => {
          throw new Error(`${table} unreadable`);
        },
        run: () => Promise.reject(new Error(`${table} unreadable`)),
        all: () => Promise.reject(new Error(`${table} unreadable`)),
      } as never;
    return db.prepare(sql);
  },
});

describe("the fleet view and the phase gate's records", () => {
  it("[FD-VER-028] [FD-VER-029] GET /v1/ops/phase-gate serves an operator gate n's records over the 14-day window", async () => {
    const now = 1_800_000_000_000;
    const s = setup({ now });
    await t.db
      .prepare(
        "insert into fd_alarms (dedupe_key, name, severity, state, detail_json, first_raised_at, updated_at) values ('kill-line:toil', 'kill-line', 'notify', 'raised', 'null', ?, ?)",
      )
      .bind(now - 1000, now - 1000)
      .run();
    const res = await s.call(OPERATOR, "/v1/ops/phase-gate?gate=0");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { measures: { name: string }[] };
    expect(body).toMatchObject({
      gate: 0,
      windowStart: now - 14 * 86_400_000,
      windowEnd: now,
      pageAlarms: [],
      killLines: ["kill-line:toil"],
    });
    expect(body.measures.map((m) => m.name)).toEqual([
      "warm-verdict",
      "cache-hit-rate",
      "estimate-drift",
    ]);
    expect((await s.call(MEMBER, "/v1/ops/phase-gate?gate=0")).status).toBe(403);
    for (const gate of ["", "4", "0x1", "1e0", " 1"]) {
      const bad = await s.call(OPERATOR, `/v1/ops/phase-gate?gate=${encodeURIComponent(gate)}`);
      expect(bad.status, gate).toBe(400);
      expect(await s.body(bad)).toMatchObject({ error: "invalid_body" });
    }
    expect((await s.call(OPERATOR, "/v1/ops/phase-gate")).status).toBe(400);
    expect((await s.call(OPERATOR, "/v1/ops/phase-gate?gate=0", { method: "POST" })).status).toBe(
      405,
    );
  });

  it("[FD-VER-028] unreadable phase-gate records answer 503 unavailable", async () => {
    const s = setup({ db: failingOn(t.db, "fd_alarms") });
    const res = await s.call(OPERATOR, "/v1/ops/phase-gate?gate=0");
    expect(res.status).toBe(503);
    const body = await s.body(res);
    expect(body).toMatchObject({ error: "unavailable" });
    expect(String(body["message"])).toContain("fd_alarms unreadable");
    expect(typeof body["request_id"]).toBe("string");
  });
});

describe("spend", () => {
  it("[FD-SPD-057] GET /v1/spend answers the spend view of the current UTC month for an Access identity", async () => {
    const s = setup({ now: Date.UTC(2027, 0, 31, 23, 59) });
    const res = await s.call(MEMBER, "/v1/spend");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(VIEW);
    expect(s.months).toEqual(["2027-01"]);
    const february = setup({ now: Date.UTC(2027, 1, 1) });
    await february.call(MEMBER, "/v1/spend");
    expect(february.months).toEqual(["2027-02"]);
    expect((await s.call(null, "/v1/spend")).status).toBe(401);
  });

  it("[FD-SPD-058] an unreadable spend store answers 503 spend_unreadable", async () => {
    const s = setup({
      spend: { view: () => Effect.fail(new SpendUnreadable({ reason: "d1 timeout" })) },
    });
    const res = await s.call(MEMBER, "/v1/spend");
    expect(res.status).toBe(503);
    const body = await s.body(res);
    expect(body).toMatchObject({ error: "spend_unreadable" });
    expect(typeof body["request_id"]).toBe("string");
  });
});

describe("GitHub App install", () => {
  it("[FD-OPS-072] the install routes serve only an operator", async () => {
    const s = setup();
    expect((await s.call(MEMBER, "/v1/github/install/new")).status).toBe(403);
    expect((await s.call(MEMBER, "/v1/github/install/callback?state=x&code=y")).status).toBe(403);
    const start = await s.call(OPERATOR, "/v1/github/install/new");
    expect(start.status).toBe(200);
    expect(await start.text()).toContain("https://github.com/settings/apps/new?state=");
  });

  it("[FD-OPS-073] [FD-OPS-074] a state binds to the operator's session and is accepted once within 600 s", async () => {
    const now = 1_800_000_000_000;
    const s = setup({ now });
    const state = encodeURIComponent(await s.issue(OPERATOR));
    const other = await s.call(OPERATOR, `/v1/github/install/callback?state=${state}&code=c0`, {
      sub: "sub-other-session",
    });
    expect(other.status).toBe(403);
    expect(await s.body(other)).toMatchObject({ error: "forbidden" });
    expect(
      (await s.call(OPERATOR, "/v1/github/install/callback?state=unknown&code=c1")).status,
    ).toBe(403);
    expect((await s.call(OPERATOR, `/v1/github/install/callback?state=${state}`)).status).toBe(403);
    expect(
      (await s.call(OPERATOR, `/v1/github/install/callback?state=${state}&code=c2`)).status,
    ).toBe(200);
    expect(
      (await s.call(OPERATOR, `/v1/github/install/callback?state=${state}&code=c3`)).status,
    ).toBe(403);
    expect(s.conversions).toEqual(["c2"]);

    const late = encodeURIComponent(await s.issue(OPERATOR));
    const after = setup({ now: now + STATE_TTL_MS });
    const expired = await after.call(OPERATOR, `/v1/github/install/callback?state=${late}&code=c4`);
    expect(expired.status).toBe(403);
    expect(after.conversions).toEqual([]);
  });

  it("[FD-OPS-074] a deploy with no manifest conversion still refuses a bad state with 403, and answers an accepted one 503 not_configured", async () => {
    const s = setup({ conversion: false });
    const unknown = await s.call(OPERATOR, "/v1/github/install/callback?state=unknown&code=c");
    expect(unknown.status).toBe(403);
    expect(await s.body(unknown)).toMatchObject({ error: "forbidden" });
    const state = encodeURIComponent(await s.issue(OPERATOR));
    const accepted = await s.call(OPERATOR, `/v1/github/install/callback?state=${state}&code=c`);
    expect(accepted.status).toBe(503);
    const body = await s.body(accepted);
    expect(body).toMatchObject({ error: "not_configured" });
    expect(String(body["message"])).toContain("manifest conversion");
  });

  it("[FD-OPS-075] the credentials page is no-store", async () => {
    const s = setup();
    const state = encodeURIComponent(await s.issue(OPERATOR));
    const res = await s.call(OPERATOR, `/v1/github/install/callback?state=${state}&code=c`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toContain("GITHUB_APP_PRIVATE_KEY");
  });
});
