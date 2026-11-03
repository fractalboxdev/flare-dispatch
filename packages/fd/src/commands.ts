// The `fd-<subcommand>` commands, built with `effect/cli`. Each one calls the one route the `fd` commands table names
// (FD-IFC-084) through the client derived from the declaration (FD-IFC-002), writes one JSON document with `--json`
// (FD-IFC-064), and exits with the code of the exit-code table (FD-IFC-065).
import type { ExecutionView } from "@fractalboxdev/flare-dispatch-api/declaration";
import { Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { readFileSync } from "node:fs";
import { call, FdFetch, makeClient } from "./client.ts";
import { controlPlaneUrl } from "./config.ts";
import { accessToken, CredentialStore } from "./credentials.ts";
import { awaitDone, DEFAULT_WAIT_TIMEOUT_S, dispatchWithRetry } from "./dispatching.ts";
import { isLocalId, LocalScheduler } from "./local-scheduler.ts";
import { BrowserLogin } from "./login.ts";
import { Operability } from "./operability.ts";
import { diagnostic, emit, EXIT, exitForVerdict, FdExit, FdFailure, reporting } from "./outcome.ts";
import { runMcpShim } from "./mcp-shim.ts";

/** A client for the configured control plane under the developer's stored Access token. */
export const session = Effect.gen(function* () {
  const url = yield* controlPlaneUrl;
  const token = yield* accessToken;
  const fetch = yield* FdFetch;
  return yield* makeClient(url, { _tag: "Access", token }, fetch);
});

const json = Flag.Boolean("json").pipe(
  Flag.withDescription("Write one JSON document matching the route's response to stdout"),
  Flag.withDefault(false),
);
const executionId = Argument.String("id").pipe(Argument.withDescription("The execution id"));
const opt = <A>(o: Option.Option<A>): A | undefined => Option.getOrUndefined(o);

const summary = (v: ExecutionView) =>
  `${v.execution_id} ${v.run} ${v.repository} ${v.class} ${v.status}${v.verdict === null ? "" : ` ${v.verdict}`}${
    v.reason === null ? "" : ` (${v.reason})`
  }`;

/** Ends a command with the verdict's exit code once the execution is done (FD-IFC-065). */
const exitWithVerdict = (view: ExecutionView) => {
  const code = exitForVerdict(view.verdict);
  return code === EXIT.ok ? Effect.void : Effect.fail(new FdExit({ code }));
};

export const login = Command.make("login", {}, () =>
  reporting(false)(
    Effect.gen(function* () {
      const url = yield* controlPlaneUrl;
      const browser = yield* BrowserLogin;
      const token = yield* browser
        .token(url)
        .pipe(
          Effect.mapError(
            (e) =>
              new FdFailure({
                code: "unauthenticated",
                message: e.message,
                exitCode: EXIT.noVerdict,
              }),
          ),
        );
      const store = yield* CredentialStore;
      yield* store
        .put(url, token)
        .pipe(
          Effect.mapError(
            (e) =>
              new FdFailure({
                code: "credential_store",
                message: e.message,
                exitCode: EXIT.noVerdict,
              }),
          ),
        );
      yield* diagnostic(`signed in to ${url}`);
    }),
  ),
).pipe(
  Command.withDescription(
    "Sign in to Cloudflare Access and keep the token in the OS credential store",
  ),
);

const readInputs = (raw: string): Effect.Effect<unknown, FdFailure> =>
  Effect.try({
    try: () =>
      JSON.parse(raw.startsWith("@") ? readFileSync(raw.slice(1), "utf8") : raw) as unknown,
    catch: () =>
      new FdFailure({
        code: "invalid_inputs",
        message: "--inputs is not JSON or a readable @file",
        exitCode: EXIT.usage,
      }),
  });

export const dispatch = Command.make(
  "dispatch",
  {
    run: Argument.String("run").pipe(Argument.withDescription("The run to dispatch")),
    repo: Flag.String("repo").pipe(Flag.withDescription("<owner>/<repo>")),
    ref: Flag.String("ref").pipe(Flag.optional),
    sha: Flag.String("sha").pipe(Flag.optional),
    inputs: Flag.String("inputs").pipe(
      Flag.withDescription("JSON, or @file"),
      Flag.withDefault("{}"),
    ),
    cls: Flag.String("class").pipe(Flag.optional),
    wait: Flag.Boolean("wait").pipe(Flag.withDefault(false)),
    timeout: Flag.Int("timeout").pipe(Flag.withDefault(DEFAULT_WAIT_TIMEOUT_S)),
    json,
  },
  (f) =>
    reporting(f.json)(
      Effect.gen(function* () {
        const client = yield* session;
        const inputs = yield* readInputs(f.inputs);
        const ref = opt(f.ref);
        const sha = opt(f.sha);
        const cls = opt(f.cls);
        const dispatched = yield* dispatchWithRetry(
          client,
          f.run,
          {
            repository: f.repo,
            inputs,
            ...(ref === undefined ? {} : { ref }),
            ...(sha === undefined ? {} : { sha }),
            ...(cls === undefined ? {} : { class: cls }),
          },
          (failure, next) => diagnostic(`${failure.code}: ${failure.message}; attempt ${next}`),
        );
        if (!f.wait)
          return yield* emit(
            f.json,
            dispatched,
            `${dispatched.execution_id} ${dispatched.class} ${dispatched.details_url}`,
          );
        yield* diagnostic(`${dispatched.execution_id} ${dispatched.details_url}`);
        const view = yield* awaitDone(client, dispatched.execution_id, f.timeout);
        yield* emit(f.json, view, summary(view));
        return yield* exitWithVerdict(view);
      }),
    ),
).pipe(Command.withDescription("Dispatch a run: POST /v1/dispatch/:run"));

export const status = Command.make("status", { id: executionId, json }, (f) =>
  reporting(f.json)(
    Effect.gen(function* () {
      const client = yield* session;
      const view = yield* call(client.executions.get({ params: { id: f.id }, query: {} }));
      yield* emit(f.json, view, summary(view));
    }),
  ),
).pipe(Command.withDescription("One execution: GET /v1/executions/:id"));

export const verdict = Command.make(
  "verdict",
  {
    id: executionId,
    wait: Flag.Boolean("wait").pipe(Flag.withDefault(false)),
    timeout: Flag.Int("timeout").pipe(Flag.withDefault(DEFAULT_WAIT_TIMEOUT_S)),
    json,
  },
  (f) =>
    reporting(f.json)(
      Effect.gen(function* () {
        const client = yield* session;
        const view = f.wait
          ? yield* awaitDone(client, f.id, f.timeout)
          : yield* call(client.executions.get({ params: { id: f.id }, query: {} }));
        yield* emit(f.json, view, summary(view));
        if (view.status !== "done") return yield* new FdExit({ code: EXIT.waitEnded });
        return yield* exitWithVerdict(view);
      }),
    ),
).pipe(Command.withDescription("The verdict of one execution: GET /v1/executions/:id"));

export const failure = Command.make("failure", { id: executionId, json }, (f) =>
  reporting(f.json)(
    Effect.gen(function* () {
      const client = yield* session;
      const pack = yield* call(client.executions.failureSummary({ params: { id: f.id } }));
      yield* emit(f.json, pack, JSON.stringify(pack, null, 2));
    }),
  ),
).pipe(Command.withDescription("The failure summary: GET /v1/executions/:id/failure-summary"));

export const logs = Command.make(
  "logs",
  {
    id: executionId,
    file: Flag.String("file").pipe(Flag.optional),
    text: Flag.Boolean("text").pipe(
      Flag.withDescription("Plain text instead of NDJSON"),
      Flag.withDefault(false),
    ),
  },
  (f) =>
    reporting(false)(
      Effect.gen(function* () {
        const client = yield* session;
        const query = f.text ? { format: "text" as const } : {};
        const file = opt(f.file);
        const body =
          file === undefined
            ? yield* call(client.logs.aggregate({ params: { id: f.id }, query }))
            : yield* call(client.logs.file({ params: { id: f.id, file }, query }));
        yield* emit(false, body, body);
      }),
    ),
).pipe(Command.withDescription("The redacted step log: GET /v1/executions/:id/logs/:file"));

export const cancel = Command.make("cancel", { id: executionId, json }, (f) =>
  reporting(f.json)(
    Effect.gen(function* () {
      if (isLocalId(f.id)) {
        const scheduler = yield* LocalScheduler;
        const local = yield* scheduler.cancel(f.id);
        return yield* emit(f.json, local, `${local.execution_id} ${local.status}`);
      }
      const client = yield* session;
      const view = yield* call(client.executions.cancel({ params: { id: f.id } }));
      yield* emit(f.json, view, summary(view));
    }),
  ),
).pipe(
  Command.withDescription(
    "Cancel: POST /v1/executions/:id/cancel, or the local scheduler for a local- id",
  ),
);

export const ls = Command.make(
  "ls",
  {
    run: Flag.String("run").pipe(Flag.optional),
    repo: Flag.String("repo").pipe(Flag.optional),
    statusFilter: Flag.Literals("status", ["queued", "running", "done"]).pipe(Flag.optional),
    cls: Flag.String("class").pipe(Flag.optional),
    executorKind: Flag.String("executor-kind").pipe(Flag.optional),
    before: Flag.String("before").pipe(Flag.optional),
    limit: Flag.Int("limit").pipe(Flag.optional),
    json,
  },
  (f) =>
    reporting(f.json)(
      Effect.gen(function* () {
        const client = yield* session;
        const entries = {
          run: opt(f.run),
          repository: opt(f.repo),
          status: opt(f.statusFilter),
          class: opt(f.cls),
          executor_kind: opt(f.executorKind),
          before: opt(f.before),
          limit: opt(f.limit),
        };
        const query = Object.fromEntries(
          Object.entries(entries).filter(([, v]) => v !== undefined),
        );
        const page = yield* call(client.executions.list({ query }));
        yield* emit(
          f.json,
          page,
          [
            ...page.executions.map(summary),
            ...(page.next_before === undefined ? [] : [`next: --before ${page.next_before}`]),
          ].join("\n"),
        );
      }),
    ),
).pipe(Command.withDescription("List executions: GET /v1/executions"));

// --- fd ops ----------------------------------------------------------------------------------------------------------

const reason = Flag.String("reason").pipe(
  Flag.withDescription("Why, 1 to 500 characters; the audit row records it"),
);
const expiresIn = Flag.Int("expires-in").pipe(
  Flag.withDescription("Seconds until the grant expires, at most 7 days"),
);
const target = Argument.String("target").pipe(
  Argument.withDescription("An executor id, or <owner>/<repo>"),
);

/** A target with a `/` is a repository; any other is an executor. */
const targetBody = (t: string) => (t.includes("/") ? { repository: t } : { executor: t });

const op = <A, I>(
  name: string,
  input: I,
  send: (client: Effect.Success<typeof session>, f: A) => Effect.Effect<unknown, unknown>,
) =>
  Command.make(name, { ...input, json } as never, (f: A & { readonly json: boolean }) =>
    reporting(f.json)(
      Effect.gen(function* () {
        const client = yield* session;
        const result = (yield* call(send(client, f))) as {
          readonly operation: string;
          readonly target: string;
          readonly request_id: string;
        };
        yield* emit(
          f.json,
          result,
          `${result.operation} ${result.target} (request ${result.request_id})`,
        );
      }),
    ),
  );

const inSeconds = (s: number) => Date.now() + s * 1000;

export const ops = Command.make("ops").pipe(
  Command.withDescription("Operator operations: /v1/ops/*"),
  Command.withSubcommands([
    op(
      "halt",
      { state: Argument.Literals("state", ["run", "halt-cloud", "halt-all"]), reason },
      (c, f: { state: "run" | "halt-cloud" | "halt-all"; reason: string }) =>
        c.ops.halt({ payload: { state: f.state, reason: f.reason } }),
    ),
    op("quarantine", { target, reason }, (c, f: { target: string; reason: string }) =>
      c.ops.quarantine({ payload: { ...targetBody(f.target), reason: f.reason } }),
    ),
    op("release", { target, reason }, (c, f: { target: string; reason: string }) =>
      c.ops.release({ payload: { ...targetBody(f.target), reason: f.reason } }),
    ),
    op(
      "drain",
      { executor: Argument.String("executor"), reason },
      (c, f: { executor: string; reason: string }) =>
        c.ops.drain({ payload: { executor: f.executor, reason: f.reason } }),
    ),
    op(
      "revoke",
      { executor: Argument.String("executor"), reason },
      (c, f: { executor: string; reason: string }) =>
        c.ops.revoke({ payload: { executor: f.executor, reason: f.reason } }),
    ),
    op(
      "force-admit",
      { execution: Argument.String("execution"), expiresIn, reason },
      (c, f: { execution: string; expiresIn: number; reason: string }) =>
        c.ops.forceAdmit({
          payload: {
            execution_id: f.execution,
            expires_at: inSeconds(f.expiresIn),
            reason: f.reason,
          },
        }),
    ),
    op(
      "top-up",
      { amount: Flag.Int("amount-micro-usd"), expiresIn, reason },
      (c, f: { amount: number; expiresIn: number; reason: string }) =>
        c.ops.topUp({
          payload: {
            amount_micro_usd: f.amount,
            expires_at: inSeconds(f.expiresIn),
            reason: f.reason,
          },
        }),
    ),
    op(
      "pause-key",
      { installation: Argument.String("installation"), reason },
      (c, f: { installation: string; reason: string }) =>
        c.ops.pauseKey({ payload: { installation: f.installation, reason: f.reason } }),
    ),
    op(
      "resume-key",
      { installation: Argument.String("installation"), reason },
      (c, f: { installation: string; reason: string }) =>
        c.ops.resumeKey({ payload: { installation: f.installation, reason: f.reason } }),
    ),
  ] as never),
);

// --- fd deploy, fd doctor --------------------------------------------------------------------------------------------

const overlayFlag = Flag.String("overlay").pipe(
  Flag.withDescription("The operator overlay: JSON, or @file"),
);

const readOverlay = (raw: string) =>
  Effect.try({
    try: () => (raw.startsWith("@") ? readFileSync(raw.slice(1), "utf8") : raw),
    catch: () =>
      new FdFailure({
        code: "invalid_body",
        message: "--overlay is not a readable @file",
        exitCode: EXIT.usage,
      }),
  });

const operabilityRun = (
  json: boolean,
  run: Effect.Effect<
    {
      readonly ok: boolean;
      readonly stages: readonly {
        readonly stage: string;
        readonly ok: boolean;
        readonly detail: string;
      }[];
    },
    { readonly message: string },
    Operability
  >,
) =>
  reporting(json)(
    Effect.gen(function* () {
      const report = yield* run.pipe(
        Effect.mapError(
          (e) => new FdFailure({ code: "operability", message: e.message, exitCode: EXIT.failure }),
        ),
      );
      yield* emit(
        json,
        report,
        report.stages.map((s) => `${s.ok ? "ok  " : "FAIL"} ${s.stage}: ${s.detail}`).join("\n"),
      );
      if (!report.ok) return yield* new FdExit({ code: EXIT.failure });
    }),
  );

export const deploy = Command.make(
  "deploy",
  { overlay: overlayFlag, dryRun: Flag.Boolean("dry-run").pipe(Flag.withDefault(false)), json },
  (f) =>
    Effect.flatMap(
      Effect.orElseSucceed(readOverlay(f.overlay), () => f.overlay),
      (overlay) =>
        operabilityRun(
          f.json,
          Effect.flatMap(Operability, (o) => o.deploy({ overlay, dryRun: f.dryRun })),
        ),
    ),
).pipe(Command.withDescription("Deploy as specs/operability.md specifies"));

export const doctor = Command.make("doctor", { overlay: overlayFlag, json }, (f) =>
  Effect.flatMap(
    Effect.orElseSucceed(readOverlay(f.overlay), () => f.overlay),
    (overlay) =>
      operabilityRun(
        f.json,
        Effect.flatMap(Operability, (o) => o.doctor(overlay)),
      ),
  ),
).pipe(Command.withDescription("Check the deploy for drift as specs/operability.md specifies"));

// --- fd mcp, and the local scheduler's commands ----------------------------------------------------------------------

export const mcp = Command.make("mcp", {}, () => runMcpShim).pipe(
  Command.withDescription("Serve the dispatcher's and the local scheduler's MCP tools over stdio"),
);

export const rehearse = Command.make("rehearse", { run: Argument.String("run"), json }, (f) =>
  reporting(f.json)(
    Effect.gen(function* () {
      const scheduler = yield* LocalScheduler;
      const local = yield* scheduler.submit({ run: f.run, inputs: {}, class: "rehearsal" });
      yield* emit(
        f.json,
        local,
        `${local.execution_id} queue position ${local.queue_position ?? "-"}`,
      );
    }),
  ),
).pipe(Command.withDescription("Rehearse a run on the local scheduler"));

export const queue = Command.make("queue", { json }, (f) =>
  reporting(f.json)(
    Effect.gen(function* () {
      const scheduler = yield* LocalScheduler;
      const entries = yield* scheduler.queue;
      yield* emit(
        f.json,
        entries,
        entries.map((e) => `${e.execution_id} ${e.status} ${e.queue_position ?? "-"}`).join("\n"),
      );
    }),
  ),
).pipe(Command.withDescription("Your submissions on the local scheduler"));

export const lease = Command.make("lease", { json }, (f) =>
  reporting(f.json)(
    Effect.gen(function* () {
      const scheduler = yield* LocalScheduler;
      const status = yield* scheduler.leaseStatus;
      yield* emit(f.json, status, `${status.state}${status.offline ? " (offline)" : ""}`);
    }),
  ),
).pipe(Command.withDescription("The capacity lease's state on the local scheduler"));

/** Each `fd-<subcommand>` executable and its command; every one maps to one route or scheduler operation. */
export const COMMANDS = {
  login,
  dispatch,
  status,
  verdict,
  failure,
  logs,
  cancel,
  ls,
  ops,
  deploy,
  doctor,
  mcp,
  rehearse,
  queue,
  lease,
} as const;

export type Subcommand = keyof typeof COMMANDS;
