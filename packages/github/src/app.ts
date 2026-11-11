// The GitHub App's own authority: the App JWT, installation tokens and the
// repository-to-installation mapping (specs/github-output.md § Installation
// quota, FD-GH-002, FD-GH-065 to FD-GH-068). Every call goes through an
// injected `fetch`, so the same code runs on workerd and under test.
import { Clock, Context, Effect, Layer, Ref, Schema } from "effect";
import { InstallationDirectory } from "./applier.ts";
import { GithubHttpError, GithubNetworkError, type GithubError } from "./client.ts";

/** The App private key is not an RSA key in a PEM encoding `crypto.subtle` can import. */
export class AppKeyInvalid extends Schema.TaggedError<AppKeyInvalid>()("AppKeyInvalid", {
  message: Schema.String,
}) {}

/** `iat` sits this far before the current time to absorb clock skew (FD-GH-067). */
export const JWT_BACKDATE_SEC = 60;
/** `exp` is this far after `iat`; GitHub refuses a JWT that lives longer than 10 min (FD-GH-067). */
export const JWT_LIFETIME_SEC = 600;
/** A token within this margin of its `expires_at` is never used (FD-GH-065). */
export const TOKEN_MARGIN_MS = 60_000;

// ---------------------------------------------------------------------------
// PEM and DER

const base64ToBytes = (b64: string): Uint8Array => {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
};

export const base64url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};

const derLength = (n: number): number[] => {
  if (n < 0x80) return [n];
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v % 256);
  return [0x80 | bytes.length, ...bytes];
};

/** `AlgorithmIdentifier { rsaEncryption, NULL }`. */
const RSA_ALGORITHM = [
  0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
];

/** Wraps a PKCS#1 `RSAPrivateKey` in a PKCS#8 `PrivateKeyInfo`, the one form `crypto.subtle` imports. */
export const pkcs1ToPkcs8 = (pkcs1: Uint8Array): Uint8Array => {
  const octets = [0x04, ...derLength(pkcs1.length), ...pkcs1];
  const body = [0x02, 0x01, 0x00, ...RSA_ALGORITHM, ...octets];
  return new Uint8Array([0x30, ...derLength(body.length), ...body]);
};

const PEM = /-----BEGIN ([A-Z ]+)-----([\s\S]*?)-----END \1-----/;

/** The PKCS#8 DER of a PKCS#1 (`RSA PRIVATE KEY`) or PKCS#8 (`PRIVATE KEY`) PEM (FD-GH-068). */
export const privateKeyDer = (pem: string): Effect.Effect<Uint8Array, AppKeyInvalid> =>
  Effect.gen(function* () {
    const match = PEM.exec(pem.replaceAll("\\n", "\n"));
    if (match === null)
      return yield* new AppKeyInvalid({ message: "the App private key is not a PEM block" });
    const der = yield* Effect.try({
      try: () => base64ToBytes(match[2]!.replace(/\s+/g, "")),
      catch: () => new AppKeyInvalid({ message: "the App private key body is not base64" }),
    });
    if (match[1] === "RSA PRIVATE KEY") return pkcs1ToPkcs8(der);
    if (match[1] === "PRIVATE KEY") return der;
    return yield* new AppKeyInvalid({ message: `unsupported PEM type ${match[1]}` });
  });

const importKey = (pem: string): Effect.Effect<SigningKey, AppKeyInvalid> =>
  Effect.gen(function* () {
    const der = yield* privateKeyDer(pem);
    return yield* Effect.tryPromise({
      try: () =>
        crypto.subtle.importKey(
          "pkcs8",
          der.slice().buffer,
          { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
          false,
          ["sign"],
        ),
      catch: (e) => new AppKeyInvalid({ message: `the App private key does not import: ${e}` }),
    });
  });

/** The imported App key; the global `CryptoKey` type is not in every lib this package compiles under. */
type SigningKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

const text = (s: string) => base64url(new TextEncoder().encode(s));

/** An RS256 App JWT: `iat` 60 s before `nowSec`, `exp` 600 s after `iat` (FD-GH-067). */
export const signAppJwt = (key: SigningKey, appId: string, nowSec: number) =>
  Effect.promise(async () => {
    const iat = nowSec - JWT_BACKDATE_SEC;
    const input = `${text(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${text(
      JSON.stringify({ iat, exp: iat + JWT_LIFETIME_SEC, iss: appId }),
    )}`;
    const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      key,
      new TextEncoder().encode(input),
    );
    return `${input}.${base64url(new Uint8Array(signature))}`;
  });

// ---------------------------------------------------------------------------
// App calls

export interface AppOptions {
  readonly appId: string;
  readonly privateKeyPem: string;
  readonly fetch: typeof globalThis.fetch;
  readonly baseUrl?: string;
}

/** The read permissions a per-lease token carries, and nothing else (FD-GH-002). */
export const LEASE_READ_PERMISSIONS = {
  metadata: "read",
  contents: "read",
  pull_requests: "read",
  issues: "read",
  checks: "read",
  actions: "read",
} as const;

export interface InstallationToken {
  readonly token: string;
  /** Epoch ms. */
  readonly expiresAt: number;
}

/** A token restricted to repositories and permissions; omitted fields take the installation's own. */
export interface TokenScope {
  /** Repository names without the owner. */
  readonly repositories: readonly string[];
  readonly permissions: Readonly<Record<string, "read" | "write">>;
}

export class GithubApp extends Context.Service<
  GithubApp,
  {
    /** A fresh App JWT, for `/app/*` and delivery calls. */
    readonly jwt: Effect.Effect<string, AppKeyInvalid>;
    /**
     * The installation's token, from the cache unless it is within 60 s of `expires_at` or `fresh` asks for a new
     * one (FD-GH-065). A scoped token is minted for its caller and never cached.
     */
    readonly token: (
      installation: number,
      options?: { readonly fresh?: boolean; readonly scope?: TokenScope },
    ) => Effect.Effect<InstallationToken, GithubError | AppKeyInvalid>;
    /** The installation that covers `<owner>/<repo>`, or null when none does; cached until evicted. */
    readonly installationFor: (
      repo: string,
    ) => Effect.Effect<number | null, GithubError | AppKeyInvalid>;
    /** Drops the installation's cached token and every repository mapping that names it (FD-GH-066). */
    readonly evictInstallation: (installation: number) => Effect.Effect<void>;
    /** Drops the repository mappings of removed repositories (FD-GH-066). */
    readonly evictRepositories: (repos: readonly string[]) => Effect.Effect<void>;
    /** One call under the App JWT, for `/app/*` endpoints such as webhook deliveries (FD-GH-089). */
    readonly rest: (
      method: string,
      path: string,
      body?: unknown,
    ) => Effect.Effect<
      { readonly status: number; readonly json: unknown },
      GithubError | AppKeyInvalid
    >;
    /** The App's installation ids, at most 100. */
    readonly installations: Effect.Effect<readonly number[], GithubError | AppKeyInvalid>;
  }
>()("@fractalboxdev/flare-dispatch-github/GithubApp") {}

interface AppState {
  readonly tokens: ReadonlyMap<number, InstallationToken>;
  readonly repos: ReadonlyMap<string, number>;
}

/** GitHub routes owner and repository names case-insensitively, so the mapping does too. */
const repoKey = (repo: string) => repo.toLowerCase();

/** One call to the GitHub API under `authorization`, through the App's injected `fetch`. */
export const appCall = (
  options: Pick<AppOptions, "fetch" | "baseUrl">,
  authorization: string,
  method: string,
  path: string,
  body?: unknown,
): Effect.Effect<{ readonly status: number; readonly json: unknown }, GithubError> =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: (signal) =>
        options.fetch(`${options.baseUrl ?? "https://api.github.com"}${path}`, {
          method,
          signal,
          headers: {
            accept: "application/vnd.github+json",
            authorization,
            "x-github-api-version": "2022-11-28",
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      catch: (e) => new GithubNetworkError({ sent: method !== "GET", message: String(e) }),
    });
    // A `202` or `204` may carry no body.
    const json: unknown = yield* Effect.tryPromise({
      try: async () => {
        const text = await response.text();
        return text === "" ? null : (JSON.parse(text) as unknown);
      },
      catch: (e) => new GithubNetworkError({ sent: true, message: String(e) }),
    });
    return { status: response.status, json };
  });

const httpError = (status: number, json: unknown) =>
  new GithubHttpError({
    status,
    message:
      typeof json === "object" && json !== null && "message" in json
        ? String(json.message)
        : `status ${status}`,
    rateLimited: status === 429,
  });

const AccessToken = Schema.Struct({ token: Schema.String, expires_at: Schema.String });
const RepoInstallation = Schema.Struct({ id: Schema.Number });

export const githubAppLayer = (options: AppOptions) =>
  Layer.effect(
    GithubApp,
    Effect.gen(function* () {
      const state = yield* Ref.make<AppState>({ tokens: new Map(), repos: new Map() });
      const keyRef = yield* Ref.make<SigningKey | null>(null);
      const key = Effect.gen(function* () {
        const cached = yield* Ref.get(keyRef);
        if (cached !== null) return cached;
        const imported = yield* importKey(options.privateKeyPem);
        yield* Ref.set(keyRef, imported);
        return imported;
      });
      const jwt = Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        return yield* signAppJwt(yield* key, options.appId, Math.floor(now / 1000));
      });

      const mint = (installation: number, scope: TokenScope | undefined) =>
        Effect.gen(function* () {
          const bearer = `Bearer ${yield* jwt}`;
          const { status, json } = yield* appCall(
            options,
            bearer,
            "POST",
            `/app/installations/${installation}/access_tokens`,
            scope === undefined
              ? undefined
              : { repositories: scope.repositories, permissions: scope.permissions },
          );
          if (status < 200 || status >= 300) return yield* httpError(status, json);
          const body = yield* Schema.decodeUnknownEffect(AccessToken)(json).pipe(
            Effect.mapError(
              (e) => new GithubNetworkError({ sent: true, message: `access token: ${e.message}` }),
            ),
          );
          const expiresAt = Date.parse(body.expires_at);
          return { token: body.token, expiresAt: Number.isNaN(expiresAt) ? 0 : expiresAt };
        });

      return {
        jwt,
        token: (installation, opts = {}) =>
          Effect.gen(function* () {
            if (opts.scope !== undefined) return yield* mint(installation, opts.scope);
            const now = yield* Clock.currentTimeMillis;
            const cached = (yield* Ref.get(state)).tokens.get(installation);
            if (
              opts.fresh !== true &&
              cached !== undefined &&
              cached.expiresAt - TOKEN_MARGIN_MS > now
            )
              return cached;
            const minted = yield* mint(installation, undefined);
            yield* Ref.update(state, (s) => ({
              ...s,
              tokens: new Map(s.tokens).set(installation, minted),
            }));
            return minted;
          }),
        installationFor: (repo) =>
          Effect.gen(function* () {
            const cached = (yield* Ref.get(state)).repos.get(repoKey(repo));
            if (cached !== undefined) return cached;
            const { status, json } = yield* appCall(
              options,
              `Bearer ${yield* jwt}`,
              "GET",
              `/repos/${repo}/installation`,
            );
            if (status === 404) return null;
            if (status < 200 || status >= 300) return yield* httpError(status, json);
            const { id } = yield* Schema.decodeUnknownEffect(RepoInstallation)(json).pipe(
              Effect.mapError(
                (e) =>
                  new GithubNetworkError({ sent: false, message: `installation: ${e.message}` }),
              ),
            );
            yield* Ref.update(state, (s) => ({
              ...s,
              repos: new Map(s.repos).set(repoKey(repo), id),
            }));
            return id;
          }),
        evictInstallation: (installation) =>
          Ref.update(state, (s) => {
            const tokens = new Map(s.tokens);
            tokens.delete(installation);
            return {
              tokens,
              repos: new Map([...s.repos].filter(([, id]) => id !== installation)),
            };
          }),
        rest: (method, path, body) =>
          Effect.flatMap(jwt, (token) => appCall(options, `Bearer ${token}`, method, path, body)),
        installations: Effect.gen(function* () {
          const { status, json } = yield* appCall(
            options,
            `Bearer ${yield* jwt}`,
            "GET",
            "/app/installations?per_page=100",
          );
          if (status < 200 || status >= 300) return yield* httpError(status, json);
          const list = yield* Schema.decodeUnknownEffect(Schema.Array(RepoInstallation))(json).pipe(
            Effect.mapError(
              (e) =>
                new GithubNetworkError({ sent: false, message: `installations: ${e.message}` }),
            ),
          );
          return list.map((i) => i.id);
        }),
        evictRepositories: (repos) =>
          Ref.update(state, (s) => {
            const gone = new Set(repos.map(repoKey));
            return { ...s, repos: new Map([...s.repos].filter(([r]) => !gone.has(r))) };
          }),
      };
    }),
  );

/** The applier's installation lookup, answered by the App; a key or GitHub failure is a failed lookup. */
export const InstallationDirectoryFromApp = Layer.effect(
  InstallationDirectory,
  Effect.gen(function* () {
    const app = yield* GithubApp;
    return {
      installationFor: (scopeId) =>
        app
          .installationFor(scopeId)
          .pipe(
            Effect.catchTag("AppKeyInvalid", (e) =>
              Effect.fail(new GithubNetworkError({ sent: false, message: e.message })),
            ),
          ),
    };
  }),
);

/** The live client's token source: the App's cached installation token, a new one on `fresh`. */
export const tokenFromApp =
  (app: GithubApp["Service"]) =>
  (installation: number, fresh: boolean): Effect.Effect<string, GithubError> =>
    app.token(installation, { fresh }).pipe(
      Effect.map((t) => t.token),
      Effect.catchTag("AppKeyInvalid", (e) =>
        Effect.fail(new GithubNetworkError({ sent: false, message: e.message })),
      ),
    );
