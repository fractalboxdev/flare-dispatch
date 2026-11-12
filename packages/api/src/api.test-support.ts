// Test doubles for the router: real RS256 tokens from throwaway key pairs, a JWKS source that serves them, and
// in-memory ports. The router runs through `toFetchHandler`, the way the Worker calls it.
import type { webcrypto } from "node:crypto";
import type { OidcKeys } from "@fractalboxdev/flare-dispatch-cache/oidc";
import { statementSubjects } from "@fractalboxdev/flare-dispatch-cache/provenance-subjects";
import type { ConfidentialityMode } from "@fractalboxdev/flare-dispatch-profile";
import { Context, Effect, Layer } from "effect";
import { ApiConfig, type ApiConfigShape } from "./config.ts";
import { base64urlEncode, utf8 } from "./crypto.ts";
import { apiError } from "./errors.ts";
import { declaredGroups } from "./groups.ts";
import { ACTIONS_ISSUER, ACTIONS_JWKS, accessIssuer } from "./identity.ts";
import { JwksSource, JwksUnavailable, type Jwk } from "./jwt.ts";
import {
  Cancellation,
  DeviceRegistry,
  Executions,
  FailureSummaries,
  Intake,
  OidcKey,
  Operations,
  ProvenancePolicies,
  ProvenanceStatements,
  StatementVisibility,
  type DispatchSubmission,
  type InclusionProofRecord,
  type ExecutionRecord,
  type OperatorCall,
  type OperatorOperation,
  type StatementRecord,
} from "./ports.ts";
import { mount, toFetchHandler, type RouteGroup } from "./router.ts";

export const TEAM = "team.example.com";
export const AUD = "aud-tag";
export const OIDC_AUD = "https://dispatcher.example.com";
export const ORIGIN = "https://dispatcher.example.com";
export const OPERATOR = "ops@example.com";
export const DISPATCHER = "dev@example.com";
export const MEMBER = "member@example.com";

export interface Signer {
  readonly kid: string;
  readonly jwk: Jwk;
  readonly sign: (
    claims: Record<string, unknown>,
    header?: Record<string, unknown>,
  ) => Promise<string>;
}

export const makeSigner = async (kid: string): Promise<Signer> => {
  const keys = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as { readonly publicKey: webcrypto.CryptoKey; readonly privateKey: webcrypto.CryptoKey };
  const exported = (await crypto.subtle.exportKey("jwk", keys.publicKey)) as {
    readonly n?: string;
    readonly e?: string;
  };
  const segment = (value: unknown) => base64urlEncode(utf8(JSON.stringify(value)));
  return {
    kid,
    jwk: { kid, kty: "RSA", alg: "RS256", n: exported.n!, e: exported.e! },
    sign: async (claims, header = {}) => {
      const signing = `${segment({ alg: "RS256", typ: "JWT", kid, ...header })}.${segment(claims)}`;
      const signature = await crypto.subtle.sign(
        "RSASSA-PKCS1-v1_5",
        keys.privateKey,
        utf8(signing),
      );
      return `${signing}.${base64urlEncode(new Uint8Array(signature))}`;
    },
  };
};

export const now = () => Math.floor(Date.now() / 1000);

export const accessClaims = (email: string, extra: Record<string, unknown> = {}) => ({
  iss: accessIssuer(TEAM),
  aud: [AUD],
  email,
  exp: now() + 300,
  iat: now(),
  ...extra,
});

export const actionsClaims = (repository: string, extra: Record<string, unknown> = {}) => ({
  iss: ACTIONS_ISSUER,
  aud: OIDC_AUD,
  repository,
  ref: "refs/heads/main",
  workflow_ref: `${repository}/.github/workflows/ci.yml@refs/heads/main`,
  sha: "b".repeat(40),
  exp: now() + 300,
  iat: now(),
  ...extra,
});

export const jwksLayer = (byUrl: Readonly<Record<string, readonly Jwk[]>>) =>
  Layer.succeed(JwksSource)({
    keys: (url) =>
      byUrl[url] === undefined
        ? Effect.fail(new JwksUnavailable({ url }))
        : Effect.succeed(byUrl[url]),
  });

export const baseConfig = (overrides: Partial<ApiConfigShape> = {}): ApiConfigShape => ({
  access: { teamDomain: TEAM, aud: AUD },
  operators: [OPERATOR],
  dispatchers: [DISPATCHER],
  oidcAudience: OIDC_AUD,
  planeId: "flare-dispatch",
  publicOrigin: ORIGIN,
  linkLifetimeS: 86_400,
  linkKey: "link-key-for-tests",
  linkEpoch: 0,
  ...overrides,
});

export const record = (overrides: Partial<ExecutionRecord> = {}): ExecutionRecord => ({
  execution_id: "01JEXEC0000000000000000000",
  run: "check",
  repository: "acme/widgets",
  class: "batch",
  status: "done",
  verdict: "failure",
  reason: "step test failed",
  conclusion: "failure",
  advisory: false,
  placement: "accepted",
  executor_id: "exec-1",
  executor_kind: "device",
  epoch: 1,
  accepted_epoch: 1,
  reserved_micro_usd: 100,
  settled_micro_usd: 80,
  enqueued_at: 1,
  finished_at: 2,
  dispatchedBy: DISPATCHER,
  ...overrides,
});

/** What the doubles saw, so a test asserts on the calls a route made. */
export interface Calls {
  readonly submissions: DispatchSubmission[];
  readonly operations: { readonly operation: OperatorOperation; readonly call: OperatorCall }[];
  readonly cancels: { readonly executionId: string; readonly identity: string }[];
  readonly lookups: string[];
}

export interface Doubles {
  readonly executions: Map<string, ExecutionRecord>;
  readonly calls: Calls;
  /** The answer intake gives the next submission. */
  intake: (s: DispatchSubmission) => Effect.Effect<
    {
      readonly _tag: "Admitted" | "Duplicate";
      readonly executionId: string;
      readonly class: string;
    },
    ReturnType<typeof apiError>
  >;
  oidcKeys: OidcKeys | undefined;
  /** The error the next operator operation fails with, as the coordinator would answer. */
  opsFailure: ReturnType<typeof apiError> | undefined;
  /** Each repository's confidentiality mode; a repository absent here is `unclassified`. */
  readonly confidentiality: Map<string, ConfidentialityMode>;
  /** The verification policy's versions; a suite sets the publisher over in-memory stores. */
  provenancePolicies: ProvenancePolicies["Service"];
  /** The recorded statements the provenance lookups read; the subject lookup matches any digest a statement names. */
  readonly statements: StatementRecord[];
  /** The private log's inclusion proof of each leaf a published checkpoint covers. */
  readonly inclusionProofs: Map<number, InclusionProofRecord>;
  /** The repositories whose GitHub visibility is `public`; every other one is not. */
  readonly publicRepositories: Set<string>;
}

export const makeDoubles = (): Doubles => {
  const doubles: Doubles = {
    executions: new Map([[record().execution_id, record()]]),
    calls: { submissions: [], operations: [], cancels: [], lookups: [] },
    intake: (s) =>
      Effect.succeed({
        _tag: "Admitted",
        executionId: "01JNEW0000000000000000000",
        class: s.class ?? "batch",
      }),
    oidcKeys: undefined,
    opsFailure: undefined,
    confidentiality: new Map(),
    provenancePolicies: {
      served: () => Effect.fail(apiError("not_found", "no verification policy is published")),
      publish: () => Effect.fail(apiError("unavailable", "this harness publishes no policy")),
      keyHistory: Effect.fail(apiError("unavailable", "this harness records no key history")),
    },
    statements: [],
    inclusionProofs: new Map(),
    publicRepositories: new Set(),
  };
  return doubles;
};

export const portsContext = (doubles: Doubles) =>
  Context.make(Intake, {
    submit: (s) => {
      doubles.calls.submissions.push(s);
      return doubles.intake(s);
    },
  }).pipe(
    Context.add(Executions, {
      list: (filter) =>
        Effect.sync(() => {
          const rows = [...doubles.executions.values()]
            .filter((r) => filter.run === undefined || r.run === filter.run)
            .filter((r) => filter.status === undefined || r.status === filter.status)
            .filter((r) => filter.before === undefined || r.execution_id < filter.before)
            .filter(
              (r) =>
                filter.finishedSince === undefined ||
                (r.finished_at !== null && r.finished_at >= filter.finishedSince),
            )
            .sort((a, b) => (a.execution_id < b.execution_id ? 1 : -1));
          return { rows: rows.slice(0, filter.limit), more: rows.length > filter.limit };
        }),
      get: (id) =>
        Effect.sync(() => {
          doubles.calls.lookups.push(id);
          return doubles.executions.get(id);
        }),
    }),
    Context.add(Cancellation, {
      cancel: ({ executionId, identity }) =>
        Effect.sync(() => {
          doubles.calls.cancels.push({ executionId, identity });
          const r = doubles.executions.get(executionId);
          if (r !== undefined)
            doubles.executions.set(executionId, { ...r, status: "done", verdict: "cancelled" });
        }),
    }),
    Context.add(FailureSummaries, {
      pack: (r) =>
        Effect.succeed({
          contractVersion: "v1" as const,
          incidentId: r.execution_id,
          class: "ci" as const,
          repo: r.repository,
          suspectRef: { base: "refs/heads/main", head: "refs/pull/7/head" },
          diagnosis: {
            title: "test fails",
            area: "src/secret.ts",
            diagnosis: "const key = readKey()",
            suggestedFix: "edit src/secret.ts",
          },
          signals: [{ source: "sentry", title: "crash", detail: "at src/secret.ts:4" }],
          ciFailures: [
            {
              kind: "run-step" as const,
              name: "test",
              conclusion: "failure",
              command: "pnpm test src/secret.test.ts",
              logTail: "x".repeat(50_000),
              url: "https://ci.example/logs/1",
            },
          ],
          suspectFiles: ["src/secret.ts"],
          repro: { kind: "command" as const, command: "pnpm test", note: "see src/secret.ts" },
        }),
      confidentiality: (repository) =>
        Effect.sync(() => doubles.confidentiality.get(repository) ?? "unclassified"),
    }),
    Context.add(Operations, {
      apply: (operation, call) =>
        doubles.opsFailure !== undefined
          ? Effect.fail(doubles.opsFailure)
          : call.reason.length < 1 || call.reason.length > 500
            ? Effect.fail(apiError("reason_required", "reason must be 1 to 500 characters"))
            : Effect.sync(() => {
                doubles.calls.operations.push({ operation, call });
                return { target: "target" };
              }),
      health: Effect.succeed({ liveness: "ok" }),
    }),
    Context.add(DeviceRegistry, {
      register: (body) =>
        Effect.succeed({ executorId: body.executor_id, postureTier: "unmanaged" }),
    }),
    Context.add(OidcKey, { keys: Effect.sync(() => doubles.oidcKeys) }),
    Context.add(ProvenancePolicies, {
      served: (version) => doubles.provenancePolicies.served(version),
      publish: (envelope, now) => doubles.provenancePolicies.publish(envelope, now),
      keyHistory: Effect.suspend(() => doubles.provenancePolicies.keyHistory),
    }),
    Context.add(ProvenanceStatements, {
      byExecution: (executionId) =>
        Effect.sync(() => doubles.statements.filter((s) => s.executionId === executionId)),
      bySubject: (digest) =>
        Effect.sync(() =>
          doubles.statements.filter((s) =>
            statementSubjects(s.envelope).some((subject) => subject.digest === digest),
          ),
        ),
      inclusionProof: (leafIndex) =>
        Effect.sync(() => doubles.inclusionProofs.get(leafIndex) ?? null),
    }),
    Context.add(StatementVisibility, {
      isPublic: (repository) => Effect.sync(() => doubles.publicRepositories.has(repository)),
    }),
  );

export interface Harness {
  readonly access: Signer;
  readonly actions: Signer;
  readonly doubles: Doubles;
  readonly fetch: (
    path: string,
    init?: RequestInit & { readonly config?: ApiConfigShape },
  ) => Promise<Response>;
  readonly asAccess: (email: string, init?: RequestInit) => Promise<RequestInit>;
  /** A `fetch` over the router in process, for a client that sends whole requests. */
  readonly asFetch: (config?: ApiConfigShape) => typeof globalThis.fetch;
}

export const makeHarness = async (extra: readonly RouteGroup<any>[] = []): Promise<Harness> => {
  const access = await makeSigner("access-kid");
  const actions = await makeSigner("actions-kid");
  const doubles = makeDoubles();
  const router = mount(...declaredGroups, ...extra);
  const handler = toFetchHandler(router, {
    shared: jwksLayer({
      [`${accessIssuer(TEAM)}/cdn-cgi/access/certs`]: [access.jwk],
      [ACTIONS_JWKS]: [actions.jwk],
    }),
  });
  return {
    access,
    actions,
    doubles,
    fetch: (path, init = {}) => {
      const { config, ...rest } = init;
      const services = portsContext(doubles).pipe(Context.add(ApiConfig, config ?? baseConfig()));
      return handler.fetch(new Request(`${ORIGIN}${path}`, rest), services as never);
    },
    asFetch: (config) =>
      ((input: Request | string | URL, init?: RequestInit) => {
        const services = portsContext(doubles).pipe(Context.add(ApiConfig, config ?? baseConfig()));
        return handler.fetch(new Request(input, init), services as never);
      }) as typeof globalThis.fetch,
    asAccess: async (email, init = {}) => ({
      ...init,
      headers: {
        ...(init.headers as Record<string, string>),
        "cf-access-jwt-assertion": await access.sign(accessClaims(email)),
      },
    }),
  };
};
