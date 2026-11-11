// The intake test harness: mameko's real admission over a SQLite D1, the fake
// GitHub reads, a fixed run catalogue, recording doubles for the ports intake
// calls, an OIDC issuer whose keys the test holds, and webhook fixtures.
import { generateKeyPairSync, createPrivateKey, sign } from "node:crypto";
import { InstallationQuota, installationQuotaLayer } from "@fractalboxdev/flare-dispatch-github";
import {
  fakeReadLayer,
  fakeReads,
  fakeRepo,
  type FakeReads,
  type FakeRepo,
} from "@fractalboxdev/flare-dispatch-github/testing";
import { buildProfile } from "@fractalboxdev/flare-dispatch-profile";
import type { ExecutionPayload, Resolution } from "@fractalboxdev/mameko-coordinator";
import { AlarmPort, type Alarm } from "@fractalboxdev/mameko-ports";
import { Effect, Layer, ManagedRuntime, Option, Schema } from "effect";
import { TestClock } from "effect/testing";
import {
  d1Admission,
  IntakeConfig,
  type AdmissionPorts,
  type ClassRequest,
  type IntakeSettings,
} from "./config.ts";
import { AccessIdentity } from "./dispatch.ts";
import { commitOf, WebhookFields, type DispatchEvent } from "./event.ts";
import { manifestSourceLayer } from "./manifest.ts";
import { ACTIONS_ISSUER, JWKS_URL, oidcVerifierLayer } from "./oidc.ts";
import { profileClassResolver } from "./layer.ts";
import { ExecutionCanceller, InstallationEviction, ManifestReporter } from "./ports.ts";
import { protectionSnapshotsLayer } from "./protection.ts";
import type { IntakeRun } from "./runs.ts";
import { signBody } from "./signature.ts";
import { d1IntakeStore, d1ShedRecorder } from "./store.ts";
import { migratedD1, recordingResolver } from "./testing.ts";

export const NOW = Date.UTC(2026, 10, 4, 12, 0, 0);
export const SECRET = "webhook-secret";
export const APP_ID = 4242;
export const AUDIENCE = "https://control-plane.example.com";
export const REPO = "acme/app";
export const SHA = "a".repeat(40);
export const HEAD = "b".repeat(40);
export const BASE = "c".repeat(40);

const Params = Schema.Struct({ steps: Schema.optionalKey(Schema.Array(Schema.String)) });
const Input = Schema.Struct({
  sha: Schema.String,
  steps: Schema.optionalKey(Schema.Array(Schema.String)),
});

/** A webhook run: answers the events it lists with `{sha, steps}`; a cron event yields `{sha: "cron"}`. */
export const testRun = (
  name: string,
  overrides: Partial<IntakeRun> = {},
  events = ["pull_request", "push", "merge_group"],
): IntakeRun => ({
  name,
  params: Params,
  input: Input,
  trigger: (event: DispatchEvent, entry) => {
    const params = Schema.decodeUnknownSync(Params)(entry.params);
    if (event._tag === "cron") return Option.some({ sha: "cron", ...params });
    if (event._tag !== "webhook" || !events.includes(event.event)) return Option.none();
    if (event.event === "pull_request" && event.action === "closed") return Option.none();
    const fields = Schema.decodeUnknownSync(WebhookFields)(event.payload);
    return Option.map(commitOf(fields), (sha) => ({ sha, ...params }));
  },
  defaultClass: "batch",
  maxDurationSec: 600,
  ownsCheck: true,
  gating: false,
  retries: 0,
  ...overrides,
});

export const CATALOG: Record<string, IntakeRun> = {
  check: testRun("check", { gating: true, defaultClass: "interactive" }),
  lint: testRun("lint", { cooldown: { seconds: 30, scope: () => "all" } }),
  nightly: testRun("nightly"),
  review: testRun("review", { cooldown: { seconds: 300, scope: () => "all" } }),
};

export const manifest = (runs: unknown[]) => JSON.stringify({ version: 1, runs });

export const DEFAULT_MANIFEST = manifest([
  {
    recipe: "check",
    label: "ci",
    triggers: ["pull_request", "push", "merge_group", "dispatch", "mcp"],
    params: { steps: ["test"] },
  },
  { recipe: "lint", triggers: ["pull_request", "dispatch"] },
  { recipe: "nightly", triggers: ["cron"], schedules: [{ cron: "0 3 * * *" }] },
]);

/** The test issuer's signing key, published at the Actions JWKS URL the fake `fetch` answers. */
const issuer = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = issuer.publicKey.export({ format: "jwk" }) as { n: string; e: string };
const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url");

export const actionsToken = (
  claims: Record<string, unknown>,
  kid = "k1",
  key = issuer.privateKey,
) => {
  const header = b64u(JSON.stringify({ alg: "RS256", kid, typ: "JWT" }));
  const payload = b64u(
    JSON.stringify({
      iss: ACTIONS_ISSUER,
      aud: AUDIENCE,
      exp: NOW / 1000 + 300,
      sub: `repo:${REPO}:ref:refs/heads/main`,
      repository: REPO,
      ref: "refs/heads/main",
      workflow_ref: `${REPO}/.github/workflows/ci.yml@refs/heads/main`,
      ...claims,
    }),
  );
  return `${header}.${payload}.${b64u(sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), key))}`;
};
export const otherKey = createPrivateKey(
  generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
    type: "pkcs8",
    format: "pem",
  }),
);

export interface Recorded {
  readonly resolved: ClassRequest[];
  readonly reported: { repo: string; sha: string; errors: readonly string[] }[];
  readonly cancelled: { executionId: string; cause: string }[];
  /** Every workflow cancel admission or a group cancel asked for, in order (MAMEKO-ADM-062, MAMEKO-ADM-064). */
  readonly workflowCancels: { executionId: string; cause: string }[];
  readonly evicted: string[];
  readonly alarms: Alarm[];
  /** Every `ExecutionEngine` start admission asked for, in order. */
  readonly started: ExecutionPayload[];
  jwksFetches: number;
}

export interface HarnessOptions {
  readonly repos?: Record<string, FakeRepo>;
  readonly installations?: Record<string, number>;
  readonly settings?: Partial<IntakeSettings>;
  readonly resolve?: (r: ClassRequest) => Resolution;
  /** Resolve classes through the profile's `resolveClass` binding instead of the recording resolver. */
  readonly profileResolver?: boolean;
  /** Answers each workflow start after it is recorded; a start succeeds by default. */
  readonly startExecution?: AdmissionPorts["startExecution"];
}

/** A default repository: `main` at `BASE` carrying the default manifest. */
export const repoWithManifest = (text = DEFAULT_MANIFEST, overrides: Partial<FakeRepo> = {}) =>
  fakeRepo({
    branches: { main: BASE },
    files: { [`${BASE}:.github/flare-dispatch.json`]: text },
    ...overrides,
  });

export const harness = async (options: HarnessOptions = {}) => {
  const db = await migratedD1();
  const reads: FakeReads = fakeReads(
    options.repos ?? { [REPO]: repoWithManifest() },
    options.installations ?? { [REPO]: 7 },
  );
  const recorded: Recorded = {
    resolved: [],
    reported: [],
    cancelled: [],
    workflowCancels: [],
    evicted: [],
    alarms: [],
    started: [],
    jwksFetches: 0,
  };
  const settings: IntakeSettings = {
    catalog: (name) => CATALOG[name],
    profile: buildProfile("production"),
    appId: APP_ID,
    webhookSecret: SECRET,
    webhookEvents: undefined,
    oidcAudience: AUDIENCE,
    dispatchers: ["dev@example.com"],
    allows: () => true,
    confidentiality: () => "unclassified",
    ...options.settings,
  };
  const fetch = (async (input: string | URL | Request) => {
    if (String(input) !== JWKS_URL) return Response.json({}, { status: 404 });
    recorded.jwksFetches++;
    return Response.json({ keys: [{ ...jwk, kty: "RSA", kid: "k1", alg: "RS256", use: "sig" }] });
  }) as typeof globalThis.fetch;
  const readLayer = fakeReadLayer(reads);
  const config = Layer.succeed(IntakeConfig, settings);
  const protection = protectionSnapshotsLayer.pipe(Layer.provide(readLayer));
  const alarms = Layer.succeed(AlarmPort, {
    deliver: (alarm) => Effect.sync(() => void recorded.alarms.push(alarm)),
  });
  const resolver =
    options.profileResolver === true
      ? profileClassResolver.pipe(Layer.provide(Layer.mergeAll(config, protection, alarms)))
      : recordingResolver(recorded.resolved, options.resolve);
  const layer = Layer.mergeAll(
    config,
    d1Admission(db, settings.profile, {
      alarms,
      cancelExecution: (executionId, cause) =>
        Effect.sync(() => void recorded.workflowCancels.push({ executionId, cause })),
      startExecution: (payload) =>
        Effect.andThen(
          Effect.sync(() => void recorded.started.push(payload)),
          options.startExecution?.(payload) ?? Effect.void,
        ),
    }),
    d1IntakeStore(db),
    d1ShedRecorder(db),
    manifestSourceLayer,
    readLayer,
    oidcVerifierLayer(fetch),
    resolver,
    protection,
    alarms,
    installationQuotaLayer(),
    Layer.succeed(ManifestReporter, {
      invalid: (repo, sha, errors) =>
        Effect.sync(() => void recorded.reported.push({ repo, sha, errors })),
    }),
    Layer.succeed(InstallationEviction, {
      installation: (id) => Effect.sync(() => void recorded.evicted.push(`installation ${id}`)),
      repositories: (repos) =>
        Effect.sync(() => void recorded.evicted.push(...repos.map((r) => `repo ${r}`))),
    }),
    Layer.succeed(ExecutionCanceller, {
      cancel: (executionId, cause) =>
        Effect.sync(() => void recorded.cancelled.push({ executionId, cause })),
    }),
    Layer.succeed(AccessIdentity, {
      identity: (r) => Effect.succeed(r.headers.get("x-test-identity")),
    }),
  ).pipe(Layer.provideMerge(readLayer), Layer.provideMerge(TestClock.layer()));
  const runtime = ManagedRuntime.make(layer);
  await runtime.runPromise(TestClock.setTime(NOW));
  const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof layer>>) =>
    runtime.runPromise(effect);
  const rows = (sql: string, ...params: unknown[]) =>
    db.sqlite.prepare(sql).all(...(params as never[])) as Record<string, unknown>[];
  return {
    db,
    reads,
    recorded,
    settings,
    run,
    rows,
    sheds: () => rows("select scope_id, run, reason from shed order by id"),
    executions: () =>
      rows("select id, scope_id, run, class, status from executions order by enqueued_at, run, id"),
    records: () => rows("select * from intake_records order by created_at, attempt, run"),
    adjust: (ms: number) => runtime.runPromise(TestClock.adjust(ms)),
    quota: () => run(InstallationQuota.use((q) => Effect.succeed(q))),
  };
};
export type Harness = Awaited<ReturnType<typeof harness>>;

// ---------------------------------------------------------------------------
// Webhook fixtures

export const signedWebhook = async (
  event: string,
  payload: unknown,
  options: {
    secret?: string;
    delivery?: string | null;
    signature?: string | null;
    tamper?: boolean;
  } = {},
) => {
  const body = new TextEncoder().encode(JSON.stringify(payload));
  const signature =
    options.signature !== undefined
      ? options.signature
      : await Effect.runPromise(signBody(options.secret ?? SECRET, body));
  const sent =
    options.tamper === true ? new TextEncoder().encode(JSON.stringify(payload) + " ") : body;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-github-event": event,
  };
  if (signature !== null) headers["x-hub-signature-256"] = signature;
  if (options.delivery !== null) headers["x-github-delivery"] = options.delivery ?? "d-1";
  return new Request("https://control-plane.example.com/v1/webhooks/github", {
    method: "POST",
    headers,
    body: sent,
  });
};

const repository = (full_name = REPO) => ({ full_name });

export const pullRequestPayload = (
  overrides: { action?: string; head?: string; headRepo?: string | null; number?: number } = {},
) => ({
  action: overrides.action ?? "synchronize",
  repository: repository(),
  installation: { id: 7 },
  pull_request: {
    number: overrides.number ?? 12,
    head: {
      sha: overrides.head ?? HEAD,
      ref: "feature",
      repo: overrides.headRepo === null ? null : repository(overrides.headRepo ?? REPO),
    },
    base: { ref: "main", sha: "d".repeat(40), repo: repository() },
  },
});

export const pushPayload = (ref = "refs/heads/main", after = HEAD) => ({
  ref,
  after,
  repository: repository(),
  installation: { id: 7 },
  head_commit: { id: after },
});

export const mergeGroupPayload = (action: string, head = HEAD) => ({
  action,
  repository: repository(),
  installation: { id: 7 },
  merge_group: {
    head_sha: head,
    base_ref: "refs/heads/main",
    head_ref: "refs/heads/gh-readonly-queue/main/pr-12",
  },
});

export const checkRunRerequested = (externalId: string | null, appId = APP_ID, head = HEAD) => ({
  action: "rerequested",
  repository: repository(),
  installation: { id: 7 },
  check_run: {
    id: 99,
    head_sha: head,
    external_id: externalId,
    name: "flare-dispatch/check:ci",
    app: { id: appId },
  },
});

export const checkSuiteRerequested = (head = HEAD, appId = APP_ID) => ({
  action: "rerequested",
  repository: repository(),
  installation: { id: 7 },
  check_suite: { head_sha: head, app: { id: appId } },
});

export const dispatchRequest = (
  run: string,
  body: unknown,
  headers: Record<string, string> = { authorization: `Bearer ${actionsToken({})}` },
) =>
  new Request(`https://control-plane.example.com/v1/dispatch/${run}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

/** The JSON body of a response the route group served. */
export const bodyOf = async (r: Response | null): Promise<Record<string, unknown>> => {
  if (r === null) throw new Error("the route group served no response");
  return (await r.json()) as Record<string, unknown>;
};
