// The clients `fd deploy` and `fd doctor` run with on a workstation or in the deploy workflow: the Cloudflare API, the
// GitHub API with the App JWT, and `wrangler` as a subprocess. Each takes its transport, so tests run them on fakes.
import { execFile } from "node:child_process";
import { createSign } from "node:crypto";
import { Effect } from "effect";
import { TargetFailed } from "../deploy.ts";

/** The Cloudflare API over one account-scoped token. */
export interface CloudflareClient {
  /** The `result` of a JSON API call; null for a 404. */
  readonly json: (
    method: string,
    path: string,
    body?: unknown,
  ) => Effect.Effect<unknown, TargetFailed>;
  /** A raw object body (R2 objects), or null for a 404. */
  readonly raw: (
    method: string,
    path: string,
    body?: string,
  ) => Effect.Effect<string | null, TargetFailed>;
}

export const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";

export const cloudflareClient = (
  token: string,
  fetcher: typeof fetch = fetch,
): CloudflareClient => {
  const call = (method: string, path: string, body: string | undefined, contentType: string) =>
    Effect.tryPromise({
      try: () =>
        fetcher(`${CLOUDFLARE_API}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            ...(body === undefined ? {} : { "content-type": contentType }),
          },
          ...(body === undefined ? {} : { body }),
        }),
      catch: (e) => new TargetFailed({ operation: `${method} ${path}`, message: String(e) }),
    });
  return {
    json: (method, path, body) =>
      Effect.gen(function* () {
        const res = yield* call(
          method,
          path,
          body === undefined ? undefined : JSON.stringify(body),
          "application/json",
        );
        if (res.status === 404) return null;
        const envelope = (yield* Effect.promise(() => res.json().catch(() => null))) as {
          success?: boolean;
          result?: unknown;
          errors?: { message?: string }[];
        } | null;
        if (!res.ok || envelope?.success === false)
          return yield* new TargetFailed({
            operation: `${method} ${path}`,
            message:
              `${res.status} ${(envelope?.errors ?? []).map((e) => e.message).join("; ")}`.trim(),
          });
        return envelope?.result ?? null;
      }),
    raw: (method, path, body) =>
      Effect.gen(function* () {
        const res = yield* call(method, path, body, "application/json");
        if (res.status === 404) return null;
        if (!res.ok)
          return yield* new TargetFailed({
            operation: `${method} ${path}`,
            message: `${res.status}`,
          });
        return yield* Effect.promise(() => res.text());
      }),
  };
};

const b64url = (data: string | Buffer) =>
  Buffer.from(data).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** An App JWT: RS256 over `iss` = the App id, issued 60 s back for clock skew and valid for 9 min. */
export const appJwt = (appId: string, privateKeyPem: string, nowSeconds: number): string => {
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = b64url(JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 540, iss: appId }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${head}.${body}`);
  return `${head}.${body}.${b64url(signer.sign(privateKeyPem))}`;
};

/** The GitHub REST API. */
export interface GithubClient {
  readonly json: (
    method: string,
    path: string,
    auth: string,
    body?: unknown,
  ) => Effect.Effect<unknown, TargetFailed>;
}

export const GITHUB_API = "https://api.github.com";

export const githubClient = (fetcher: typeof fetch = fetch): GithubClient => ({
  json: (method, path, auth, body) =>
    Effect.gen(function* () {
      const res = yield* Effect.tryPromise({
        try: () =>
          fetcher(`${GITHUB_API}${path}`, {
            method,
            headers: {
              authorization: `Bearer ${auth}`,
              accept: "application/vnd.github+json",
              "x-github-api-version": "2022-11-28",
              "user-agent": "flare-dispatch-fd",
              ...(body === undefined ? {} : { "content-type": "application/json" }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          }),
        catch: (e) => new TargetFailed({ operation: `${method} ${path}`, message: String(e) }),
      });
      if (!res.ok)
        return yield* new TargetFailed({
          operation: `${method} ${path}`,
          message: `${res.status}`,
        });
      return yield* Effect.promise(() => res.json());
    }),
});

/** A subprocess run: its exit code and output. */
export interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs a command; the deploy uses it for `wrangler`. */
export type CommandRunner = (
  command: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly env?: Readonly<Record<string, string>> },
) => Promise<CommandResult>;

export const nodeRunner: CommandRunner = (command, args, options) =>
  new Promise((resolve) => {
    execFile(
      command,
      [...args],
      { cwd: options.cwd, env: { ...process.env, ...options.env }, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) =>
        resolve({
          code: error === null ? 0 : typeof error.code === "number" ? error.code : 1,
          stdout: String(stdout),
          stderr: String(stderr),
        }),
    );
  });

/** Runs `wrangler` and fails with its output on a non-zero exit. */
export const wrangler = (
  runner: CommandRunner,
  cwd: string,
  args: readonly string[],
  env?: Record<string, string>,
) =>
  Effect.gen(function* () {
    const result = yield* Effect.promise(() =>
      runner("pnpm", ["exec", "wrangler", ...args], { cwd, ...(env === undefined ? {} : { env }) }),
    );
    if (result.code !== 0)
      return yield* new TargetFailed({
        operation: `wrangler ${args[0] ?? ""}`,
        message: (result.stderr || result.stdout).trim().split("\n").slice(-5).join("\n"),
      });
    return result.stdout;
  });

/** The version id `wrangler deploy` prints. */
export const deployedVersion = (stdout: string): string | null =>
  /Current Version ID:\s*([0-9a-f-]{8,})/i.exec(stdout)?.[1] ?? null;

/** The migration names `wrangler d1 migrations apply` reports applied. */
export const appliedMigrations = (stdout: string): readonly string[] =>
  [...stdout.matchAll(/([0-9]{4}_[\w-]+\.sql)\s*│\s*✅/g)].map((m) => m[1]!);
