// The intake test harness: mameko's real admission over a SQLite D1, the fake
// GitHub reads, a fixed run catalogue, recording doubles for the ports intake
// calls, and webhook fixtures.
import { InstallationQuota, installationQuotaLayer } from "@fractalboxdev/flare-dispatch-github";
import {
  fakeGithub,
  fakeGithubLayers,
  fakeReadLayer,
  fakeReads,
  fakeRepo,
  type FakeGithub,
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
  IntakeError,
  type IntakeSettings,
} from "./config.ts";
import { admitDispatch, type AuthenticatedDispatch } from "./dispatch.ts";
import { AccessIdentity } from "./mcp.ts";
import { commitOf, WebhookFields, type DispatchEvent } from "./event.ts";
import { manifestSourceLayer } from "./manifest.ts";
import { profileClassResolver } from "./layer.ts";
import { heldCheckReporterLayer, InstallationEviction, ManifestReporter } from "./ports.ts";
import { protectionSnapshotsLayer } from "./protection.ts";
import type { IntakeRun } from "./runs.ts";
import { signBody } from "./signature.ts";
import { d1IntakeStore, d1ShedRecorder } from "./store.ts";
import { migratedD1, recordingResolver } from "./testing.ts";

export const NOW = Date.UTC(2026, 10, 4, 12, 0, 0);
export const SECRET = "webhook-secret";
export const APP_ID = 4242;
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

export interface Recorded {
  readonly resolved: ClassRequest[];
  readonly reported: { repo: string; sha: string; errors: readonly string[] }[];
  /**
   * Every workflow cancel admission, a group cancel or a per-execution cancel asked for, in order (MAMEKO-ADM-062,
   * MAMEKO-ADM-064, MAMEKO-ADM-065).
   */
  readonly workflowCancels: { executionId: string; cause: string }[];
  readonly evicted: string[];
  readonly alarms: Alarm[];
  /** Every `ExecutionEngine` start admission asked for, in order. */
  readonly started: ExecutionPayload[];
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
    workflowCancels: [],
    evicted: [],
    alarms: [],
    started: [],
  };
  const settings: IntakeSettings = {
    catalog: (name) => CATALOG[name],
    profile: buildProfile("production"),
    appId: APP_ID,
    webhookSecret: SECRET,
    webhookEvents: undefined,
    allows: () => true,
    confidentiality: () => "unclassified",
    writeCredentialIn: () => null,
    ...options.settings,
  };
  const readLayer = fakeReadLayer(reads);
  // The check runs GitHub holds; a held request's queued check run is written here (FD-INT-057).
  const github: FakeGithub = fakeGithub();
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
    resolver,
    protection,
    alarms,
    installationQuotaLayer(),
    heldCheckReporterLayer.pipe(Layer.provide(Layer.merge(fakeGithubLayers(github), readLayer))),
    Layer.succeed(ManifestReporter, {
      invalid: (repo, sha, errors) =>
        Effect.sync(() => void recorded.reported.push({ repo, sha, errors })),
    }),
    Layer.succeed(InstallationEviction, {
      installation: (id) => Effect.sync(() => void recorded.evicted.push(`installation ${id}`)),
      repositories: (repos) =>
        Effect.sync(() => void recorded.evicted.push(...repos.map((r) => `repo ${r}`))),
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
    github,
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
// Dispatch fixtures

/** A dispatch as the HTTP API's declared route hands it to intake: an Actions caller of `REPO` on `main`. */
export const authenticated = (
  overrides: Partial<AuthenticatedDispatch> = {},
): AuthenticatedDispatch => ({
  trigger: "dispatch",
  run: "check",
  repository: REPO,
  ref: "refs/heads/main",
  sha: undefined,
  label: "ci",
  inputs: { sha: HEAD },
  signals: undefined,
  classInput: null,
  caller: {
    kind: "actions-oidc",
    id: `actions:${REPO}:${REPO}/.github/workflows/ci.yml@refs/heads/main`,
    workflowRef: `${REPO}/.github/workflows/ci.yml@refs/heads/main`,
    ref: "refs/heads/main",
  },
  vouchedSha: undefined,
  idempotency: null,
  ...overrides,
});

/** An authenticated dispatch through intake's admission. */
export const admit = (h: Harness, d: AuthenticatedDispatch) => h.run(admitDispatch(d));

/** The refusal of an authenticated dispatch: its status, code and the execution a `conflict` names. */
export const refusal = (h: Harness, d: AuthenticatedDispatch) =>
  h.run(
    admitDispatch(d).pipe(
      Effect.flip,
      Effect.map((e) =>
        e instanceof IntakeError
          ? {
              status: e.status,
              code: e.code,
              ...(e.executionId === undefined ? {} : { executionId: e.executionId }),
            }
          : { status: 503, code: "store_unavailable" },
      ),
    ),
  );

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
  overrides: {
    action?: string;
    head?: string;
    headRepo?: string | null;
    number?: number;
    closedAt?: string | null;
  } = {},
) => ({
  action: overrides.action ?? "synchronize",
  repository: repository(),
  installation: { id: 7 },
  pull_request: {
    number: overrides.number ?? 12,
    ...(overrides.closedAt === undefined ? {} : { closed_at: overrides.closedAt }),
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

/** The JSON body of a response the route group served. */
export const bodyOf = async (r: Response | null): Promise<Record<string, unknown>> => {
  if (r === null) throw new Error("the route group served no response");
  return (await r.json()) as Record<string, unknown>;
};
