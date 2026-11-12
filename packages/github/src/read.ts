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

export const RepoPermission = Schema.Literals(["admin", "write", "read", "none"]);
export type RepoPermission = typeof RepoPermission.Type;

/** Whether a permission lets its principal push, merge and manage labels: `write` or `admin`. */
export const canWrite = (p: RepoPermission) => p === "admin" || p === "write";

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
    /** The repository's visibility as GitHub reports it: `public`, `private` or `internal`. */
    readonly visibility: (repo: string) => Effect.Effect<string, GithubReadError>;
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
    /**
     * Whether an active ruleset with at least one rule targets `ref` (`refs/heads/<branch>` or `refs/tags/<tag>`), or
     * branch protection guards the branch; false for any other ref.
     */
    readonly refProtected: (repo: string, ref: string) => Effect.Effect<boolean, GithubReadError>;
    /**
     * The principal's permission on the repository as GitHub's collaborator permission reports it: `admin`, `write`
     * (which `maintain` reports as), `read` (which `triage` reports as) or `none`; `none` for a login GitHub does not
     * know as a collaborator.
     */
    readonly permission: (
      repo: string,
      login: string,
    ) => Effect.Effect<RepoPermission, GithubReadError>;
    /** The `<owner>/<repo>` names an installation covers, at most 100. */
    readonly repositories: (
      installation: number,
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
const RepositoryVisibility = Schema.Struct({ visibility: Schema.String });
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

const Rules = Schema.Array(Schema.Struct({ type: Schema.String }));
const BranchProtected = Schema.Struct({ protected: Schema.Boolean });
const RulesetSummaries = Schema.Array(
  Schema.Struct({
    id: Schema.Number,
    target: Schema.optionalKey(Schema.String),
    enforcement: Schema.String,
  }),
);
const RulesetDetail = Schema.Struct({
  enforcement: Schema.String,
  conditions: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        ref_name: Schema.optionalKey(
          Schema.Struct({
            include: Schema.optionalKey(Schema.Array(Schema.String)),
            exclude: Schema.optionalKey(Schema.Array(Schema.String)),
          }),
        ),
      }),
    ),
  ),
  rules: Schema.optionalKey(Rules),
});

const globSource = (pattern: string) =>
  pattern
    .split("**")
    .map((part) =>
      part
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replaceAll("*", "[^/]*")
        .replaceAll("?", "[^/]"),
    )
    .join(".*");

/**
 * Whether a ruleset `ref_name` pattern names `ref`: `~ALL` names every ref; otherwise `**` spans `/`, `*` and `?` do
 * not, and a pattern without the `refs/` prefix matches the ref's short name.
 */
export const refPatternMatches = (pattern: string, ref: string): boolean => {
  if (pattern === "~ALL") return true;
  if (pattern.startsWith("~")) return false;
  const short = ref.replace(/^refs\/(heads|tags)\//, "");
  return new RegExp(`^${globSource(pattern)}$`).test(pattern.startsWith("refs/") ? ref : short);
};

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
        visibility: (repo) =>
          Effect.map(
            Effect.flatMap(get(repo, `/repos/${repo}`), decode(RepositoryVisibility)),
            (r) => r.visibility,
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
        permission: (repo, login) =>
          Effect.gen(function* () {
            const raw = yield* notFound(
              get(repo, `/repos/${repo}/collaborators/${encodeURIComponent(login)}/permission`),
            );
            if (raw === null) return "none" as const;
            return (yield* decode(Schema.Struct({ permission: RepoPermission }))(raw)).permission;
          }),
        repositories: (id) =>
          Effect.map(
            Effect.flatMap(
              request<unknown>(id, "GET", "/installation/repositories?per_page=100"),
              decode(
                Schema.Struct({
                  repositories: Schema.Array(Schema.Struct({ full_name: Schema.String })),
                }),
              ),
            ),
            (r) => r.repositories.map((x) => x.full_name),
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
        refProtected: (repo, ref) =>
          Effect.gen(function* () {
            if (ref.startsWith("refs/heads/")) {
              const branch = enc(ref.slice("refs/heads/".length));
              const rules = yield* Effect.flatMap(
                get(repo, `/repos/${repo}/rules/branches/${branch}`),
                decode(Rules),
              );
              if (rules.length > 0) return true;
              const raw = yield* notFound(get(repo, `/repos/${repo}/branches/${branch}`));
              return raw === null ? false : (yield* decode(BranchProtected)(raw)).protected;
            }
            if (!ref.startsWith("refs/tags/")) return false;
            // GitHub answers the rules of a branch but not of a tag, so each active tag ruleset's conditions decide.
            const summaries = yield* Effect.flatMap(
              get(repo, `/repos/${repo}/rulesets?targets=tag&includes_parents=true&per_page=100`),
              decode(RulesetSummaries),
            );
            for (const s of summaries) {
              if (s.enforcement !== "active" || (s.target !== undefined && s.target !== "tag"))
                continue;
              const detail = yield* Effect.flatMap(
                get(repo, `/repos/${repo}/rulesets/${s.id}?includes_parents=true`),
                decode(RulesetDetail),
              );
              const names = detail.conditions?.ref_name;
              const included = (names?.include ?? []).some((p) => refPatternMatches(p, ref));
              const excluded = (names?.exclude ?? []).some((p) => refPatternMatches(p, ref));
              if (
                detail.enforcement === "active" &&
                included &&
                !excluded &&
                (detail.rules ?? []).length > 0
              )
                return true;
            }
            return false;
          }),
      };
    }),
  );
