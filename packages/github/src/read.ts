// GitHub reads: what intake, the missed-webhook sweep and a run's `GithubRead`
// capability ask of a repository. Every read runs under the installation that
// serves the repository; a repository with none fails `GithubUncredentialed`
// rather than answering empty, so no caller decides on a read that never
// happened (FD-GH-003).
import { Context, Effect, Layer, Schema } from "effect";
import { InstallationDirectory } from "./applier.ts";
import {
  restRequest,
  type GithubClientOptions,
  type GithubError,
  GithubHttpError,
} from "./client.ts";
import { InstallationQuota } from "./rate-limit.ts";

/** No installation of the App serves the repository, so no read can be made for it. */
export class GithubUncredentialed extends Schema.TaggedError<GithubUncredentialed>()(
  "GithubUncredentialed",
  { repo: Schema.String },
) {}

/** GitHub answered `2xx` with a body this client does not decode. */
export class GithubUnexpected extends Schema.TaggedError<GithubUnexpected>()("GithubUnexpected", {
  message: Schema.String,
}) {}

export type GithubReadError = GithubError | GithubUncredentialed | GithubUnexpected;

export const RepoFile = Schema.Struct({ size: Schema.Number, text: Schema.String });
export type RepoFile = typeof RepoFile.Type;

export const PullSummary = Schema.Struct({
  number: Schema.Number,
  updated_at: Schema.String,
  head: Schema.Struct({
    sha: Schema.String,
    ref: Schema.String,
    repo: Schema.NullOr(Schema.Struct({ full_name: Schema.String })),
  }),
  base: Schema.Struct({
    ref: Schema.String,
    repo: Schema.Struct({ full_name: Schema.String }),
  }),
});
export type PullSummary = typeof PullSummary.Type;

export const CheckRunSummary = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  external_id: Schema.NullOr(Schema.String),
  app: Schema.NullOr(Schema.Struct({ id: Schema.Number })),
});
export type CheckRunSummary = typeof CheckRunSummary.Type;

export class GithubRead extends Context.Service<
  GithubRead,
  {
    /** The installation that serves the repository; `GithubUncredentialed` when none does. */
    readonly installation: (repo: string) => Effect.Effect<number, GithubReadError>;
    /** The file's bytes as UTF-8 at `ref`, or null when the path does not exist there. */
    readonly file: (
      repo: string,
      path: string,
      ref: string,
    ) => Effect.Effect<RepoFile | null, GithubReadError>;
    readonly defaultBranch: (repo: string) => Effect.Effect<string, GithubReadError>;
    /** The commit SHA at the head of `branch`. */
    readonly branchHead: (repo: string, branch: string) => Effect.Effect<string, GithubReadError>;
    /** Open pull requests, most recently updated first, at most 100. */
    readonly openPulls: (repo: string) => Effect.Effect<readonly PullSummary[], GithubReadError>;
    /** Every check run on the commit, at most 100. */
    readonly checkRuns: (
      repo: string,
      sha: string,
    ) => Effect.Effect<readonly CheckRunSummary[], GithubReadError>;
    /** The check names a ruleset or the branch protection of `branch` requires. */
    readonly requiredChecks: (
      repo: string,
      branch: string,
    ) => Effect.Effect<readonly string[], GithubReadError>;
  }
>()("@fractalboxdev/flare-dispatch-github/GithubRead") {}

const decode =
  <S extends Schema.Decoder<unknown>>(schema: S) =>
  (value: unknown) =>
    Schema.decodeUnknownEffect(schema)(value).pipe(
      Effect.mapError((e) => new GithubUnexpected({ message: e.message })),
    );

const ContentFile = Schema.Struct({
  type: Schema.String,
  size: Schema.Number,
  encoding: Schema.optionalKey(Schema.String),
  content: Schema.optionalKey(Schema.String),
});
const Repository = Schema.Struct({ default_branch: Schema.String });
const Branch = Schema.Struct({ commit: Schema.Struct({ sha: Schema.String }) });
const BranchRules = Schema.Array(
  Schema.Struct({
    type: Schema.String,
    parameters: Schema.optionalKey(
      Schema.Struct({
        required_status_checks: Schema.optionalKey(
          Schema.Array(Schema.Struct({ context: Schema.String })),
        ),
      }),
    ),
  }),
);
const ProtectionChecks = Schema.Struct({
  contexts: Schema.optionalKey(Schema.Array(Schema.String)),
  checks: Schema.optionalKey(Schema.Array(Schema.Struct({ context: Schema.String }))),
});

const utf8FromBase64 = (b64: string) => {
  const binary = atob(b64.replace(/\s+/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
};

const notFound = <A>(
  effect: Effect.Effect<A, GithubReadError>,
): Effect.Effect<A | null, GithubReadError> =>
  effect.pipe(
    Effect.catchTag("GithubHttpError", (e: GithubHttpError) =>
      e.status === 404 ? Effect.succeed(null) : Effect.fail(e),
    ),
  );

const enc = (s: string) => s.split("/").map(encodeURIComponent).join("/");

export const githubReadLayer = (options: GithubClientOptions) =>
  Layer.effect(
    GithubRead,
    Effect.gen(function* () {
      const request = restRequest(options, yield* InstallationQuota);
      const directory = yield* InstallationDirectory;
      const installation = (repo: string) =>
        Effect.gen(function* () {
          const id = yield* directory.installationFor(repo);
          if (id === null) return yield* new GithubUncredentialed({ repo });
          return id;
        });
      const get = (repo: string, path: string) =>
        Effect.flatMap(installation(repo), (id) => request<unknown>(id, "GET", path));

      return {
        installation,
        file: (repo, path, ref) =>
          Effect.gen(function* () {
            const raw = yield* notFound(
              get(repo, `/repos/${repo}/contents/${enc(path)}?ref=${encodeURIComponent(ref)}`),
            );
            if (raw === null) return null;
            const body = yield* decode(ContentFile)(raw);
            if (body.type !== "file") return null;
            // GitHub leaves `content` empty above 1 MB; the size still answers a bound check.
            const text =
              body.encoding === "base64" && body.content !== undefined
                ? utf8FromBase64(body.content)
                : "";
            return { size: body.size, text };
          }),
        defaultBranch: (repo) =>
          Effect.map(
            Effect.flatMap(get(repo, `/repos/${repo}`), decode(Repository)),
            (r) => r.default_branch,
          ),
        branchHead: (repo, branch) =>
          Effect.map(
            Effect.flatMap(get(repo, `/repos/${repo}/branches/${enc(branch)}`), decode(Branch)),
            (b) => b.commit.sha,
          ),
        openPulls: (repo) =>
          Effect.flatMap(
            get(repo, `/repos/${repo}/pulls?state=open&sort=updated&direction=desc&per_page=100`),
            decode(Schema.Array(PullSummary)),
          ),
        checkRuns: (repo, sha) =>
          Effect.map(
            Effect.flatMap(
              get(repo, `/repos/${repo}/commits/${sha}/check-runs?filter=latest&per_page=100`),
              decode(Schema.Struct({ check_runs: Schema.Array(CheckRunSummary) })),
            ),
            (r) => r.check_runs,
          ),
        requiredChecks: (repo, branch) =>
          Effect.gen(function* () {
            const rules = yield* Effect.flatMap(
              get(repo, `/repos/${repo}/rules/branches/${enc(branch)}`),
              decode(BranchRules),
            );
            const classic = yield* notFound(
              get(repo, `/repos/${repo}/branches/${enc(branch)}/protection/required_status_checks`),
            );
            const protection = classic === null ? null : yield* decode(ProtectionChecks)(classic);
            const names = new Set<string>([
              ...rules.flatMap((r) =>
                r.type === "required_status_checks"
                  ? (r.parameters?.required_status_checks ?? []).map((c) => c.context)
                  : [],
              ),
              ...(protection?.contexts ?? []),
              ...(protection?.checks ?? []).map((c) => c.context),
            ]);
            return [...names].sort();
          }),
      };
    }),
  );
