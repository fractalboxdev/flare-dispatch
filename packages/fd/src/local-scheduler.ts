// The local scheduler's Unix socket, which `fd mcp` and the `rehearse`, `queue` and `lease` commands reach. The socket's
// operations are submit, outcome, failure summary, cancel, queue and lease status ([mameko local-scheduler.md
// § Overview]). An absent socket, or one that refuses the connection, answers `scheduler_unreachable` and exit 5
// (FD-IFC-069). The socket carries one JSON object per line, each answered on one line with the request's `id` as
// `ref` ([mameko local-scheduler.md § Process and keys]); `mameko-local-scheduler --socket <path> --lease <file>`
// serves `submit`, `queue`, `status`, `cancel` and `lease`, and generates every local execution id (FD-IFC-076).
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { IncidentV1 } from "@fractalboxdev/flare-dispatch-api/declaration";
import type { LeaseStatus, LocalExecution } from "@fractalboxdev/flare-dispatch-api/mcp-tools";
import { Context, Effect, Layer, Match, Schema } from "effect";
import { FdConfig } from "./config.ts";
import { EXIT, FdFailure } from "./outcome.ts";

/** Local execution ids are `local-` and a ULID (FD-IFC-076); every other id is the control plane's. */
export const isLocalId = (id: string): boolean => id.startsWith("local-");

/** A local execution id as the local scheduler generates it: `local-` and a 26-character Crockford ULID (FD-IFC-076). */
export const LOCAL_ID = /^local-[0-9A-HJKMNP-TV-Z]{26}$/;

export interface LocalSubmission {
  readonly run: string;
  readonly inputs: unknown;
  /** `rehearsal` unless the caller names another local class. */
  readonly class: string;
}

export class LocalScheduler extends Context.Service<
  LocalScheduler,
  {
    readonly submit: (submission: LocalSubmission) => Effect.Effect<LocalExecution, FdFailure>;
    readonly outcome: (id: string, waitSeconds: number) => Effect.Effect<LocalExecution, FdFailure>;
    readonly failureSummary: (id: string) => Effect.Effect<IncidentV1, FdFailure>;
    readonly cancel: (id: string) => Effect.Effect<LocalExecution, FdFailure>;
    readonly queue: Effect.Effect<readonly LocalExecution[], FdFailure>;
    readonly leaseStatus: Effect.Effect<LeaseStatus, FdFailure>;
  }
>()("@fractalboxdev/flare-dispatch-fd/LocalScheduler") {}

export const schedulerUnreachable = (message: string) =>
  new FdFailure({ code: "scheduler_unreachable", message, exitCode: EXIT.noVerdict });

const schedulerProtocol = (message: string) =>
  new FdFailure({ code: "scheduler_protocol", message, exitCode: EXIT.noVerdict });

/** Connects to the socket and closes again: `undefined` when it accepts, the failure when it is absent or refuses. */
export const probeSocket = (path: string | undefined): Effect.Effect<void, FdFailure> =>
  Effect.scoped(Effect.asVoid(openSocket(path)));

/** One connection to the socket, closed when its scope closes. */
const openSocket = (path: string | undefined) =>
  path === undefined
    ? Effect.fail(schedulerUnreachable("no local scheduler socket: set FD_SCHEDULER_SOCKET"))
    : Effect.acquireRelease(
        Effect.callback<Socket, FdFailure>((resume) => {
          const socket = connect(path);
          socket.once("connect", () => resume(Effect.succeed(socket)));
          socket.once("error", (error: NodeJS.ErrnoException) =>
            resume(
              Effect.fail(
                schedulerUnreachable(
                  `the local scheduler socket ${path} is unreachable (${error.code ?? error.message})`,
                ),
              ),
            ),
          );
        }),
        (socket) => Effect.sync(() => socket.destroy()),
      );

/**
 * A connection's request function: each request goes out as one line with a fresh `id`, and the line answered with
 * that `id` as `ref` is its answer. The socket answers a connection's requests in order.
 */
const lineClient = (socket: Socket) => {
  let buffer = "";
  const waiting: ((line: string | null) => void)[] = [];
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      waiting.shift()?.(line);
    }
  });
  const closed = () => {
    for (const w of waiting.splice(0)) w(null);
  };
  socket.on("close", closed);
  socket.on("error", closed);
  return (request: Record<string, unknown>): Effect.Effect<unknown, FdFailure> =>
    Effect.gen(function* () {
      const id = randomUUID();
      const line = yield* Effect.callback<string | null>((resume) => {
        waiting.push((l) => resume(Effect.succeed(l)));
        socket.write(`${JSON.stringify({ ...request, id })}\n`);
      });
      if (line === null)
        return yield* schedulerUnreachable(
          `the local scheduler closed the connection before answering ${String(request["type"])}`,
        );
      const answer = yield* Effect.try({
        try: () => JSON.parse(line) as unknown,
        catch: () => schedulerProtocol(`the local scheduler answered a line that is not JSON`),
      });
      if ((answer as { readonly ref?: unknown }).ref !== id)
        return yield* schedulerProtocol(
          `the local scheduler answered ${String(request["type"])} under another request's id`,
        );
      return answer;
    });
};

const SubmitOk = Schema.Struct({
  type: Schema.Literal("submit.ok"),
  execution_id: Schema.String,
  submission_id: Schema.String,
  /** Absent when the submission attached to a live execution. */
  position: Schema.optionalKey(Schema.Number),
  attached: Schema.Boolean,
});
const QueueOk = Schema.Struct({
  type: Schema.Literal("queue.ok"),
  executions: Schema.Array(Schema.String),
});
const StatusOk = Schema.Struct({
  type: Schema.Literal("status.ok"),
  state: Schema.Literals(["queued", "running"]),
});
const CancelOk = Schema.Struct({ type: Schema.Literal("cancel.ok"), stopped: Schema.Boolean });
const LeaseOk = Schema.Struct({
  type: Schema.Literal("lease.ok"),
  offline: Schema.Boolean,
  slots: Schema.Array(Schema.Struct({ pool: Schema.String, slots: Schema.Number })),
  token_allowance: Schema.Number,
});
/**
 * A rejected request: `unknown-member`, `class-not-allowed`, `offline-hosted`, `ineligible` with its `rule`,
 * `queue-full` with its `reason` and `retry_after_s`, `advisory-only`, `not-found` or `invalid` with its `field`.
 */
const Rejected = Schema.Struct({
  type: Schema.Literal("error"),
  code: Schema.String,
  rule: Schema.optionalKey(Schema.String),
  reason: Schema.optionalKey(Schema.String),
  retry_after_s: Schema.optionalKey(Schema.Number),
  field: Schema.optionalKey(Schema.String),
});

/**
 * A rejection's failure, under the scheduler's own code: a submitter the lease does not name or a full queue leaves no
 * verdict (5), and every other rejection is a request the caller has to change (2).
 */
const rejection = (r: typeof Rejected.Type): FdFailure => {
  const detail = [
    r.rule === undefined ? null : `rule ${r.rule}`,
    r.reason === undefined ? null : `reason ${r.reason}`,
    r.retry_after_s === undefined ? null : `retry after ${r.retry_after_s} s`,
    r.field === undefined ? null : `field ${r.field}`,
  ].filter((d) => d !== null);
  return new FdFailure({
    code: r.code,
    message: `the local scheduler rejected the request: ${r.code}${detail.length === 0 ? "" : ` (${detail.join(", ")})`}`,
    exitCode: Match.value(r.code).pipe(
      Match.when("unknown-member", () => EXIT.noVerdict),
      Match.when("queue-full", () => EXIT.noVerdict),
      Match.orElse(() => EXIT.usage),
    ),
    body: r,
  });
};

/** The answer as `schema`, a rejection as its failure, and anything else as `scheduler_protocol`. */
const answerAs =
  <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S, operation: string) =>
  (answer: unknown): Effect.Effect<S["Type"], FdFailure> =>
    Effect.gen(function* () {
      const rejected = Schema.decodeUnknownOption(Rejected)(answer);
      if (rejected._tag === "Some") return yield* rejection(rejected.value);
      return yield* Schema.decodeUnknownEffect(schema)(answer).pipe(
        Effect.mapError(() =>
          schedulerProtocol(
            `the local scheduler's ${operation} answer does not match its wire format`,
          ),
        ),
      );
    });

/** One file of the working tree as the socket carries it. */
export interface TreeFile {
  readonly path: string;
  /** The file's bytes, base64. */
  readonly bytes: string;
  readonly executable: boolean;
}

/** The working tree a submission carries: its tenant scope and its files, from which the scheduler hashes the tree. */
export interface WorkingTree {
  readonly scope: string;
  readonly files: readonly TreeFile[];
}

/** `owner/name` of a GitHub remote URL, or null for any other URL. */
export const scopeOfRemote = (url: string): string | null =>
  /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url.trim())?.slice(1, 3).join("/") ??
  null;

/**
 * The git working tree at `dir`: every tracked file and every untracked file `.gitignore` admits, and the repository
 * its `origin` remote names on GitHub as the tenant scope.
 */
export const gitWorkingTree = (dir: string): Effect.Effect<WorkingTree, FdFailure> =>
  Effect.try({
    try: () => {
      const git = (...args: string[]) =>
        execFileSync("git", args, { cwd: dir, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
      const scope = scopeOfRemote(git("config", "--get", "remote.origin.url"));
      if (scope === null) throw new Error("its origin remote is not a GitHub repository");
      const top = git("rev-parse", "--show-toplevel").trim();
      const paths = git(
        "ls-files",
        "-z",
        "--cached",
        "--others",
        "--exclude-standard",
        "--full-name",
      )
        .split("\0")
        .filter((p) => p !== "");
      const files = paths.flatMap((path): TreeFile[] => {
        const full = join(top, path);
        const stat = statSync(full, { throwIfNoEntry: false });
        if (stat === undefined || !stat.isFile()) return [];
        return [
          {
            path,
            bytes: readFileSync(full).toString("base64"),
            executable: (stat.mode & 0o111) !== 0,
          },
        ];
      });
      return { scope, files };
    },
    catch: (error) =>
      new FdFailure({
        code: "invalid_input",
        message: `a rehearsal runs on a git working tree with a GitHub origin remote: ${error instanceof Error ? error.message : String(error)}`,
        exitCode: EXIT.usage,
      }),
  });

/** JSON with every object's keys sorted, so equal inputs give one digest. */
const canonical = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(",")}]`
    : value !== null && typeof value === "object"
      ? `{${Object.keys(value)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
          .join(",")}}`
      : JSON.stringify(value ?? null);

/** The submission's `inputs_digest`: the SHA-256 of the inputs' canonical JSON. */
export const inputsDigest = (inputs: unknown): string =>
  createHash("sha256").update(canonical(inputs)).digest("hex");

/**
 * The submission ids this device's submissions received, by execution: `cancel` detaches a submission, so a later `fd`
 * process cancels an execution an earlier one submitted. The ledger holds no credential (FD-IFC-067).
 */
export interface SubmissionLedger {
  readonly add: (executionId: string, submissionId: string) => Effect.Effect<void>;
  readonly of: (executionId: string) => Effect.Effect<readonly string[]>;
  readonly remove: (executionId: string) => Effect.Effect<void>;
}

/** The ledger as a JSON file at `path`, written mode 0600; an unreadable file reads as empty. */
export const fileLedger = (path: string): SubmissionLedger => {
  const read = (): Record<string, readonly string[]> => {
    try {
      return JSON.parse(readFileSync(path, "utf8")) as Record<string, readonly string[]>;
    } catch {
      return {};
    }
  };
  const write = (entries: Record<string, readonly string[]>) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(entries), { mode: 0o600 });
  };
  return {
    add: (executionId, submissionId) =>
      Effect.sync(() => {
        const entries = read();
        write({ ...entries, [executionId]: [...(entries[executionId] ?? []), submissionId] });
      }),
    of: (executionId) => Effect.sync(() => read()[executionId] ?? []),
    remove: (executionId) =>
      Effect.sync(() => {
        const { [executionId]: _, ...rest } = read();
        write(rest);
      }),
  };
};

/** `$XDG_STATE_HOME/flare-dispatch/local-submissions.json`, under `~/.local/state` when the variable is unset. */
export const ledgerPath = (env: NodeJS.ProcessEnv): string =>
  join(
    env["XDG_STATE_HOME"] ?? join(homedir(), ".local", "state"),
    "flare-dispatch",
    "local-submissions.json",
  );

const localExecution = (
  executionId: string,
  status: LocalExecution["status"],
  over: Partial<Pick<LocalExecution, "queue_position" | "verdict">> = {},
): LocalExecution => ({
  execution_id: executionId,
  status,
  queue_position: over.queue_position ?? null,
  verdict: over.verdict ?? null,
  reason: null,
  advisory: true,
});

/** What the socket client reads besides the socket: the working tree a submission carries and the submission ledger. */
export interface SocketSources {
  readonly workingTree: Effect.Effect<WorkingTree, FdFailure>;
  readonly ledger: SubmissionLedger;
}

/**
 * The socket client over `socket`. `submit` sends the working tree, whose tree hash the scheduler computes from the
 * bytes it receives, with the run, the local class and the inputs' digest; the run's pool, memory, model use, labels
 * and declarations are the catalogue's, which `fd` does not carry, so the scheduler takes them as none. Each local
 * execution's `advisory` is true (FD-IFC-081).
 */
export const socketScheduler = (
  socket: string | undefined,
  sources: SocketSources,
): LocalScheduler["Service"] => {
  const session = <A>(body: (call: ReturnType<typeof lineClient>) => Effect.Effect<A, FdFailure>) =>
    Effect.scoped(Effect.flatMap(openSocket(socket), (s) => body(lineClient(s))));
  const status = (call: ReturnType<typeof lineClient>, executionId: string) =>
    Effect.flatMap(
      call({ type: "status", execution_id: executionId }),
      answerAs(StatusOk, "status"),
    );
  // mameko's socket serves no outcome or failure-summary request yet, so once the socket accepts these answer
  // `scheduler_protocol` naming that gap rather than guessing a format.
  const unserved = <A>(operation: string): Effect.Effect<A, FdFailure> =>
    probeSocket(socket).pipe(
      Effect.andThen(
        Effect.fail(
          schedulerProtocol(
            `the local scheduler's ${operation} operation has no wire format in the pinned mameko release`,
          ),
        ),
      ),
    );
  return {
    submit: (submission) =>
      Effect.gen(function* () {
        yield* probeSocket(socket);
        const tree = yield* sources.workingTree;
        return yield* session((call) =>
          Effect.gen(function* () {
            const ok = yield* Effect.flatMap(
              call({
                type: "submit",
                class: submission.class,
                scope: tree.scope,
                run: submission.run,
                inputs_digest: inputsDigest(submission.inputs),
                files: tree.files,
              }),
              answerAs(SubmitOk, "submit"),
            );
            yield* sources.ledger.add(ok.execution_id, ok.submission_id);
            // An attached submission joins a live execution, which may already run.
            const { state } = ok.attached
              ? yield* status(call, ok.execution_id)
              : { state: "queued" as const };
            return localExecution(ok.execution_id, state, {
              queue_position: ok.position ?? null,
            });
          }),
        );
      }),
    outcome: () => unserved("outcome"),
    failureSummary: () => unserved("failure summary"),
    cancel: (id) =>
      session((call) =>
        Effect.gen(function* () {
          const submissions = yield* sources.ledger.of(id);
          if (submissions.length === 0)
            return yield* new FdFailure({
              code: "not-found",
              message: `no submission of ${id} was made from this device`,
              exitCode: EXIT.usage,
            });
          // Each of this device's submissions detaches; the execution stops when the last submitter leaves.
          let stopped = false;
          for (const submission of submissions) {
            const ok = yield* Effect.flatMap(
              call({ type: "cancel", execution_id: id, submission_id: submission }),
              answerAs(CancelOk, "cancel"),
            );
            stopped = ok.stopped;
          }
          yield* sources.ledger.remove(id);
          if (stopped) return localExecution(id, "done", { verdict: "cancelled" });
          const { state } = yield* status(call, id);
          return localExecution(id, state);
        }),
      ),
    queue: session((call) =>
      Effect.gen(function* () {
        const { executions } = yield* Effect.flatMap(
          call({ type: "queue" }),
          answerAs(QueueOk, "queue"),
        );
        return yield* Effect.forEach(executions, (id) =>
          Effect.map(status(call, id), ({ state }) => localExecution(id, state)),
        );
      }),
    ),
    leaseStatus: session((call) =>
      Effect.map(
        Effect.flatMap(call({ type: "lease" }), answerAs(LeaseOk, "lease")),
        (lease): LeaseStatus => ({
          // A scheduler that serves the socket holds its capacity lease; `offline` reports offline mode apart.
          state: "active",
          slots: Object.fromEntries(lease.slots.map((s) => [s.pool, s.slots])),
          remaining_token_allowance: lease.token_allowance,
          offline: lease.offline,
        }),
      ),
    ),
  };
};

/** The socket client on this device: the current directory's working tree and the ledger under `$XDG_STATE_HOME`. */
export const LocalSchedulerSocket = Layer.effect(LocalScheduler)(
  Effect.gen(function* () {
    const { schedulerSocket } = yield* FdConfig;
    return LocalScheduler.of(
      socketScheduler(schedulerSocket, {
        workingTree: Effect.suspend(() => gitWorkingTree(process.cwd())),
        ledger: fileLedger(ledgerPath(process.env)),
      }),
    );
  }),
);
