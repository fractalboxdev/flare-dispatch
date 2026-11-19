// `AwsBuilds` for one `image-publish` or `stack-deploy` execution in the `control` pool (specs/runs/gate.md § AWS builds
// and stack deploys). The control plane mints an OIDC token from its own issuer whose `aud` names the lease's
// repository and the run's target and whose `sub` is `<run>:<execution_id>` (FD-GATE-117), exchanges it with STS
// `AssumeRoleWithWebIdentity`, and signs each CodeBuild and ECS call with SigV4 under the role's credentials. The
// credentials stay in this module's memory for the execution and reach no intent, log, store or build (FD-GATE-118).
import { signRequest, type AwsCredentials } from "@fractalboxdev/flare-dispatch-agentic";
import { issueOidcToken, parseOidcKeys } from "@fractalboxdev/flare-dispatch-cache/oidc";
import {
  AwsAssumeRoleFailed,
  AwsBuilds,
  AwsCallFailed,
  awsAudience,
  CloudLeaseMissing,
  ExecutionLease,
  type AwsTarget,
  type BuildState,
  type BuildStatusName,
  type ServiceRollout,
} from "@fractalboxdev/flare-dispatch-catalog";
import { Effect, Layer, Schema } from "effect";

/** The bindings `AwsBuilds` reads. */
export interface AwsEnv {
  /** The issuer of the OIDC tokens, the dispatcher's public origin (FD-PROV-050). */
  readonly PUBLIC_ORIGIN?: string;
  /** The control plane's OIDC key set (FD-PROV-049). */
  readonly OIDC_SIGNING_JWK?: string;
}

export interface AwsOptions {
  readonly fetch: typeof globalThis.fetch;
  readonly now?: () => number;
}

/** The lifetime of the OIDC token and of the role session. */
export const OIDC_TOKEN_TTL_SEC = 900;
export const ROLE_SESSION_SEC = 3600;
/** Assumed credentials are replaced this long before they expire. */
export const REFRESH_BEFORE_EXPIRY_MS = 5 * 60_000;

const STS_VERSION = "2011-06-15";

interface Assumed extends AwsCredentials {
  readonly sessionToken: string;
  readonly expiresAt: number;
}

const xmlTag = (xml: string, name: string): string | undefined =>
  new RegExp(`<${name}>\\s*([^<]+?)\\s*</${name}>`).exec(xml)?.[1];

/** The role session name: `fd-<execution_id>`, which the role's CloudTrail records show. */
export const roleSessionName = (executionId: string): string =>
  `fd-${executionId}`.replace(/[^\w+=,.@-]/g, "-").slice(0, 64);

/**
 * One `AssumeRoleWithWebIdentity` call (unsigned: the token is the credential). A refusal names STS's error code, a
 * lost request `NetworkError`, an unparsable answer `InvalidResponse` (FD-GATE-119).
 */
export const assumeRoleWithWebIdentity = (input: {
  readonly region: string;
  readonly roleArn: string;
  readonly sessionName: string;
  readonly token: string;
  readonly fetch: typeof globalThis.fetch;
}): Effect.Effect<Assumed, AwsAssumeRoleFailed> =>
  Effect.gen(function* () {
    const body = new URLSearchParams({
      Action: "AssumeRoleWithWebIdentity",
      Version: STS_VERSION,
      RoleArn: input.roleArn,
      RoleSessionName: input.sessionName,
      WebIdentityToken: input.token,
      DurationSeconds: String(ROLE_SESSION_SEC),
    }).toString();
    const response = yield* Effect.tryPromise({
      try: () =>
        input.fetch(`https://sts.${input.region}.amazonaws.com/`, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded; charset=utf-8",
            accept: "application/xml",
          },
          body,
        }),
      catch: () => new AwsAssumeRoleFailed({ code: "NetworkError" }),
    });
    const text = yield* Effect.promise(() => response.text().catch(() => ""));
    if (!response.ok)
      return yield* new AwsAssumeRoleFailed({
        code: xmlTag(text, "Code") ?? `HTTP${response.status}`,
      });
    const accessKeyId = xmlTag(text, "AccessKeyId");
    const secretAccessKey = xmlTag(text, "SecretAccessKey");
    const sessionToken = xmlTag(text, "SessionToken");
    const expiresAt = Date.parse(xmlTag(text, "Expiration") ?? "");
    if (
      accessKeyId === undefined ||
      secretAccessKey === undefined ||
      sessionToken === undefined ||
      Number.isNaN(expiresAt)
    )
      return yield* new AwsAssumeRoleFailed({ code: "InvalidResponse" });
    return { accessKeyId, secretAccessKey, sessionToken, expiresAt };
  });

/** The AWS JSON 1.1 services the recipes call. */
const SERVICES = {
  codebuild: { host: "codebuild", prefix: "CodeBuild_20161006" },
  ecs: { host: "ecs", prefix: "AmazonEC2ContainerServiceV20141113" },
} as const;
type ServiceName = keyof typeof SERVICES;

/**
 * One signed AWS JSON 1.1 call. A network error or a 5xx is transient; any other refusal names the error code of
 * the response's `__type` (FD-GATE-125).
 */
export const awsJson = (input: {
  readonly service: ServiceName;
  readonly operation: string;
  readonly region: string;
  readonly credentials: AwsCredentials;
  readonly body: unknown;
  readonly fetch: typeof globalThis.fetch;
  readonly now: Date;
}): Effect.Effect<unknown, AwsCallFailed> =>
  Effect.gen(function* () {
    const service = SERVICES[input.service];
    const host = `${service.host}.${input.region}.amazonaws.com`;
    const body = JSON.stringify(input.body);
    const failed = (transient: boolean, code: string) =>
      new AwsCallFailed({ service: input.service, operation: input.operation, transient, code });
    const headers = yield* Effect.promise(() =>
      signRequest({
        credentials: input.credentials,
        region: input.region,
        service: input.service,
        host,
        canonicalPath: "/",
        body,
        now: input.now,
        headers: {
          "content-type": "application/x-amz-json-1.1",
          "x-amz-target": `${service.prefix}.${input.operation}`,
        },
      }),
    );
    const response = yield* Effect.tryPromise({
      try: () => input.fetch(`https://${host}/`, { method: "POST", headers, body }),
      catch: () => failed(true, "NetworkError"),
    });
    const text = yield* Effect.promise(() => response.text().catch(() => ""));
    let parsed: unknown;
    try {
      parsed = text === "" ? {} : JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    if (!response.ok) {
      const type = (parsed as { __type?: unknown } | undefined)?.__type;
      const code =
        typeof type === "string" ? (type.split("#").pop() ?? type) : `HTTP${response.status}`;
      return yield* failed(response.status >= 500, code);
    }
    if (parsed === undefined) return yield* failed(false, "InvalidResponse");
    return parsed;
  });

const BuildPhaseJson = Schema.Struct({
  phaseType: Schema.String,
  phaseStatus: Schema.optionalKey(Schema.String),
  durationInSeconds: Schema.optionalKey(Schema.Number),
});
const BuildJson = Schema.Struct({
  id: Schema.String,
  buildStatus: Schema.Literals([
    "IN_PROGRESS",
    "SUCCEEDED",
    "FAILED",
    "FAULT",
    "STOPPED",
    "TIMED_OUT",
  ]),
  phases: Schema.optionalKey(Schema.Array(BuildPhaseJson)),
  logs: Schema.optionalKey(
    Schema.Struct({
      groupName: Schema.optionalKey(Schema.String),
      streamName: Schema.optionalKey(Schema.String),
    }),
  ),
  exportedEnvironmentVariables: Schema.optionalKey(
    Schema.Array(Schema.Struct({ name: Schema.String, value: Schema.optionalKey(Schema.String) })),
  ),
});
const StartBuildJson = Schema.Struct({ build: Schema.Struct({ id: Schema.String }) });
const BatchGetBuildsJson = Schema.Struct({ builds: Schema.Array(BuildJson) });
const DescribeServicesJson = Schema.Struct({
  services: Schema.Array(
    Schema.Struct({
      serviceName: Schema.String,
      desiredCount: Schema.Number,
      runningCount: Schema.Number,
      deployments: Schema.optionalKey(
        Schema.Array(
          Schema.Struct({ status: Schema.String, rolloutState: Schema.optionalKey(Schema.String) }),
        ),
      ),
    }),
  ),
});

/** A build as the recipe reads it (FD-GATE-123, FD-GATE-126, FD-GATE-131). */
export const buildStateOf = (build: typeof BuildJson.Type): BuildState => ({
  id: build.id,
  status: build.buildStatus as BuildStatusName,
  phases: (build.phases ?? []).map((p) => ({
    type: p.phaseType,
    ...(p.phaseStatus === undefined ? {} : { status: p.phaseStatus }),
    ...(p.durationInSeconds === undefined ? {} : { durationSec: p.durationInSeconds }),
  })),
  ...(build.logs?.groupName === undefined || build.logs.streamName === undefined
    ? {}
    : { logs: { group: build.logs.groupName, stream: build.logs.streamName } }),
  exported: Object.fromEntries(
    (build.exportedEnvironmentVariables ?? []).map((v) => [v.name, v.value ?? ""]),
  ),
});

/** Each named service's rollout; a name ECS does not answer is `Missing` (FD-GATE-139, FD-GATE-140). */
export const rolloutsOf = (
  answer: typeof DescribeServicesJson.Type,
  names: readonly string[],
): readonly ServiceRollout[] =>
  names.map((name): ServiceRollout => {
    const found = answer.services.find((s) => s.serviceName === name);
    if (found === undefined) return { _tag: "Missing", name };
    const primary = found.deployments?.find((d) => d.status === "PRIMARY");
    return {
      _tag: "Found",
      name,
      rolloutState: primary?.rolloutState,
      runningCount: found.runningCount,
      desiredCount: found.desiredCount,
    };
  });

const decodeAnswer =
  <S extends Schema.Top>(schema: S, service: ServiceName, operation: string) =>
  (body: unknown) =>
    Schema.decodeUnknownEffect(schema)(body).pipe(
      Effect.mapError(
        () => new AwsCallFailed({ service, operation, transient: false, code: "InvalidResponse" }),
      ),
    ) as Effect.Effect<S["Type"], AwsCallFailed>;

/**
 * `AwsBuilds` for the execution its `ExecutionLease` names. The audience comes from the lease's scope id, never from
 * the run's input; an unconfigured issuer, or a lease with no scope id, fails every call before any request leaves.
 */
export const awsBuildsLayer = (
  env: AwsEnv,
  options: AwsOptions,
): Layer.Layer<AwsBuilds, CloudLeaseMissing, ExecutionLease> =>
  Layer.effect(
    AwsBuilds,
    Effect.gen(function* () {
      const lease = yield* ExecutionLease;
      const scope = lease.scopeId;
      if (scope === undefined)
        return yield* new CloudLeaseMissing({ detail: "the lease names no scope id" });
      const now = options.now ?? Date.now;
      const keys = parseOidcKeys(env.OIDC_SIGNING_JWK);
      const issuer = env.PUBLIC_ORIGIN?.trim();
      const held = new Map<string, Assumed>();

      const credentialsFor = (
        target: AwsTarget,
      ): Effect.Effect<AwsCredentials, AwsAssumeRoleFailed> =>
        Effect.gen(function* () {
          const audience = awsAudience(scope, target.target);
          const key = `${target.region}\n${target.roleArn}\n${audience}`;
          const cached = held.get(key);
          if (cached !== undefined && now() < cached.expiresAt - REFRESH_BEFORE_EXPIRY_MS)
            return cached;
          if (keys === undefined || issuer === undefined || issuer === "")
            return yield* new AwsAssumeRoleFailed({ code: "OidcIssuerUnconfigured" });
          const token = yield* issueOidcToken(
            keys,
            issuer,
            {
              run: lease.run,
              executionId: lease.executionId,
              audience,
              ttlSec: OIDC_TOKEN_TTL_SEC,
            },
            now(),
          ).pipe(Effect.mapError(() => new AwsAssumeRoleFailed({ code: "OidcTokenRefused" })));
          const assumed = yield* assumeRoleWithWebIdentity({
            region: target.region,
            roleArn: target.roleArn,
            sessionName: roleSessionName(lease.executionId),
            token: token.jwt,
            fetch: options.fetch,
          });
          held.set(key, assumed);
          return assumed;
        });

      const call = (target: AwsTarget, service: ServiceName, operation: string, body: unknown) =>
        Effect.gen(function* () {
          const credentials = yield* credentialsFor(target);
          return yield* awsJson({
            service,
            operation,
            region: target.region,
            credentials,
            body,
            fetch: options.fetch,
            now: new Date(now()),
          });
        });

      return {
        start: (target, request) =>
          call(target, "codebuild", "StartBuild", {
            projectName: request.project,
            sourceVersion: request.sourceVersion,
            idempotencyToken: request.idempotencyToken,
            environmentVariablesOverride: Object.entries(request.env).map(([name, value]) => ({
              name,
              value,
              type: "PLAINTEXT",
            })),
          }).pipe(
            Effect.flatMap(decodeAnswer(StartBuildJson, "codebuild", "StartBuild")),
            Effect.map((answer) => answer.build.id),
          ),
        get: (target, buildId) =>
          call(target, "codebuild", "BatchGetBuilds", { ids: [buildId] }).pipe(
            Effect.flatMap(decodeAnswer(BatchGetBuildsJson, "codebuild", "BatchGetBuilds")),
            Effect.flatMap((answer) => {
              const build = answer.builds.find((b) => b.id === buildId);
              return build === undefined
                ? Effect.fail(
                    new AwsCallFailed({
                      service: "codebuild",
                      operation: "BatchGetBuilds",
                      transient: false,
                      code: "BuildNotFound",
                    }),
                  )
                : Effect.succeed(buildStateOf(build));
            }),
          ),
        stop: (target, buildId) =>
          call(target, "codebuild", "StopBuild", { id: buildId }).pipe(Effect.asVoid),
        services: (target, cluster, names) =>
          call(target, "ecs", "DescribeServices", { cluster, services: [...names] }).pipe(
            Effect.flatMap(decodeAnswer(DescribeServicesJson, "ecs", "DescribeServices")),
            Effect.map((answer) => rolloutsOf(answer, names)),
          ),
      };
    }),
  );
