// The operator routes: each `/v1/ops/*` route and its `fd ops` command surface one of mameko's operator operations,
// and no other operation is surfaced (FD-OPS-077, MAMEKO-OPS-030, MAMEKO-OPS-046). The dispatcher authenticates the
// operator, then passes the identity, the `reason` and its request id to the operation (specs/operability.md
// § Operator routes). No route changes a value the operator overlay carries, the budget included (FD-OPS-083).
import { Context, Effect, Schema } from "effect";
import { decodeStrict } from "./decode.ts";

/** A `reason` of 1 to 500 characters (MAMEKO-OPS-031). */
const Reason = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500));
const Id = Schema.String.check(Schema.isMinLength(1));
/** An expiry, epoch ms, at most 7 days ahead (MAMEKO-OPS-033). */
const Expiry = Schema.Number.check(Schema.isInt());

/** mameko's operator operations FlareDispatch surfaces, each with its request body. */
export const OPERATIONS = {
  halt: Schema.Struct({
    state: Schema.Literals(["run", "halt-cloud", "halt-all"]),
    reason: Reason,
  }),
  drain: Schema.Struct({ executor: Id, reason: Reason }),
  quarantine: Schema.Struct({ target: Id, reason: Reason }),
  release: Schema.Struct({ target: Id, reason: Reason }),
  cancel: Schema.Struct({ reason: Reason }),
  "force-admit": Schema.Struct({ execution: Id, expires_at: Expiry, reason: Reason }),
  "top-up": Schema.Struct({
    amount_usd: Schema.Number.check(Schema.isGreaterThan(0)),
    expires_at: Expiry,
    reason: Reason,
  }),
  revoke: Schema.Struct({ executor: Id, reason: Reason }),
  pause: Schema.Struct({ installation: Id, reason: Reason }),
  resume: Schema.Struct({ installation: Id, reason: Reason }),
} as const;
export type OperationName = keyof typeof OPERATIONS;

/** The routes table of specs/operability.md § Operator routes: route, method, `fd ops` command, operation. */
export const OPERATOR_ROUTES: readonly {
  readonly path: string;
  readonly command: string;
  readonly operation: OperationName;
}[] = [
  { path: "/v1/ops/halt", command: "fd ops halt <run|halt-cloud|halt-all>", operation: "halt" },
  { path: "/v1/ops/drain", command: "fd ops drain <executor>", operation: "drain" },
  {
    path: "/v1/ops/quarantine",
    command: "fd ops quarantine <executor or repository>",
    operation: "quarantine",
  },
  {
    path: "/v1/ops/release",
    command: "fd ops release <executor or repository>",
    operation: "release",
  },
  { path: "/v1/executions/:id/cancel", command: "fd cancel <id>", operation: "cancel" },
  {
    path: "/v1/ops/force-admit",
    command: "fd ops force-admit <execution>",
    operation: "force-admit",
  },
  { path: "/v1/ops/top-up", command: "fd ops top-up", operation: "top-up" },
  { path: "/v1/ops/revoke", command: "fd ops revoke <executor>", operation: "revoke" },
  { path: "/v1/ops/pause-key", command: "fd ops pause-key <installation>", operation: "pause" },
  { path: "/v1/ops/resume-key", command: "fd ops resume-key <installation>", operation: "resume" },
];

/** What the route passes the operation beside its body. */
export interface OperatorCall<Op extends OperationName = OperationName> {
  readonly operation: Op;
  readonly operator: string;
  readonly requestId: string;
  readonly body: (typeof OPERATIONS)[Op]["Type"];
  /** The execution of `cancel`, from the path. */
  readonly executionId?: string;
}

/** The coordinator refused the operation; the message carries its reason. */
export class OperationRefused extends Schema.TaggedError<OperationRefused>()("OperationRefused", {
  status: Schema.Literals([400, 404, 409]),
  code: Schema.String,
  message: Schema.String,
}) {}

/** mameko's operator operations (MAMEKO-OPS-030); the coordinator writes the audit row (MAMEKO-OPS-032). */
export class OperatorOperations extends Context.Service<
  OperatorOperations,
  { readonly perform: (call: OperatorCall) => Effect.Effect<unknown, OperationRefused> }
>()("@fractalboxdev/flare-dispatch-ops/OperatorOperations") {}

/** The longest expiry a `force-admit` or `top-up` may carry (MAMEKO-OPS-033). */
export const MAX_GRANT_MS = 7 * 86_400_000;

/** Matches a request path to its operator route; `cancel` binds the execution id. */
export const matchOperatorRoute = (pathname: string) => {
  const cancel = /^\/v1\/executions\/([^/]+)\/cancel$/.exec(pathname);
  if (cancel !== null)
    return {
      route: OPERATOR_ROUTES.find((r) => r.operation === "cancel")!,
      executionId: cancel[1]!,
    };
  const route = OPERATOR_ROUTES.find((r) => r.path === pathname);
  return route === undefined ? null : { route, executionId: undefined };
};

const errorResponse = (status: number, code: string, message: string, requestId: string) =>
  Response.json({ error: code, message, request_id: requestId }, { status });

/**
 * Serves one operator route for an identity the operator gate has passed: `POST` only, the body decoded strictly,
 * `reason_required` for a missing or out-of-bounds reason, and the operation's own refusal as its status.
 */
export const operatorRoute = (
  request: Request,
  match: NonNullable<ReturnType<typeof matchOperatorRoute>>,
  operator: string,
  requestId: string,
  now: number,
) =>
  Effect.gen(function* () {
    if (request.method !== "POST")
      return errorResponse(405, "method_not_allowed", "operator routes take POST", requestId);
    const raw = yield* Effect.promise(() => request.json().catch(() => null));
    const schema = OPERATIONS[match.route.operation];
    const decoded = yield* decodeStrict(schema as Schema.Top, raw).pipe(
      Effect.map((body) => ({ ok: true as const, body })),
      Effect.catch((issues) => Effect.succeed({ ok: false as const, issues })),
    );
    if (!decoded.ok) {
      const reasonIssue = decoded.issues.some((i) => i.path === "reason");
      return errorResponse(
        400,
        reasonIssue ? "reason_required" : "invalid_body",
        decoded.issues.map((i) => `${i.path}: ${i.message}`).join("; "),
        requestId,
      );
    }
    const body = decoded.body as { expires_at?: number };
    if (
      body.expires_at !== undefined &&
      (body.expires_at <= now || body.expires_at - now > MAX_GRANT_MS)
    )
      return errorResponse(
        400,
        "invalid_body",
        "expires_at must fall within the next 7 days",
        requestId,
      );
    const ops = yield* OperatorOperations;
    return yield* ops
      .perform({
        operation: match.route.operation,
        operator,
        requestId,
        body: decoded.body as never,
        ...(match.executionId === undefined ? {} : { executionId: match.executionId }),
      })
      .pipe(
        Effect.map((result) => Response.json({ ok: true, result, request_id: requestId })),
        Effect.catchTag("OperationRefused", (e) =>
          Effect.succeed(errorResponse(e.status, e.code, e.message, requestId)),
        ),
      );
  });
