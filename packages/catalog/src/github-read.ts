// `GithubRead`: FlareDispatch's application capability for reads of a repository (specs/run-model.md § `GithubRead`).
// A failed read is an error, never an empty answer (FD-RUN-017, MAMEKO-RUN-023). On an executor the egress proxy attaches
// the per-lease token, and in the control pool the control plane's GET carries the App installation token, so this
// module holds no credential.
import { Context, Effect, Layer, Schema } from "effect";

/** GitHub answered, but not with the value asked for. */
export class GithubReadFailed extends Schema.TaggedError<GithubReadFailed>()("GithubReadFailed", {
  what: Schema.String,
  status: Schema.optionalKey(Schema.Number),
  detail: Schema.String,
}) {}

/** The request carried no credential GitHub accepts. */
export class GithubUncredentialed extends Schema.TaggedError<GithubUncredentialed>()(
  "GithubUncredentialed",
  { what: Schema.String },
) {}

export type GithubReadError = GithubReadFailed | GithubUncredentialed;

export class GithubRead extends Context.Service<
  GithubRead,
  {
    /** The commit a branch points at. */
    readonly branchHead: (repo: string, branch: string) => Effect.Effect<string, GithubReadError>;
    /** The commit a tag points at, an annotated tag peeled. */
    readonly tagCommit: (repo: string, tag: string) => Effect.Effect<string, GithubReadError>;
    /** Whether `sha` is reachable from `branch`'s head. */
    readonly reachableFrom: (
      repo: string,
      sha: string,
      branch: string,
    ) => Effect.Effect<boolean, GithubReadError>;
  }
>()("@fractalboxdev/flare-dispatch-catalog/GithubRead") {}

export interface GithubReadOptions {
  /** `https://api.github.com` unless the deployment names an Enterprise host. */
  readonly apiBase: string;
  readonly fetch: typeof globalThis.fetch;
}

const Ref = Schema.Struct({
  object: Schema.Struct({ sha: Schema.String, type: Schema.String }),
});
const Tag = Schema.Struct({ object: Schema.Struct({ sha: Schema.String, type: Schema.String }) });
const Compare = Schema.Struct({ status: Schema.String });

const enc = (part: string) => part.split("/").map(encodeURIComponent).join("/");

/** One GET of a repository's REST resource: the JSON body GitHub answered, or the read's error. */
export type GithubGet = (
  what: string,
  repo: string,
  path: string,
) => Effect.Effect<unknown, GithubReadError>;

/** `GithubRead` over one GET of the REST API; a body that does not decode fails `GithubReadFailed`. */
export const githubReadOver = (get: GithubGet): Layer.Layer<GithubRead> => {
  const read = <S extends Schema.Top>(what: string, repo: string, path: string, schema: S) =>
    get(what, repo, path).pipe(
      Effect.flatMap((body) =>
        Schema.decodeUnknownEffect(schema)(body).pipe(
          Effect.mapError((e) => new GithubReadFailed({ what, detail: `body: ${e.message}` })),
        ),
      ),
    ) as Effect.Effect<S["Type"], GithubReadError, S["DecodingServices"]>;

  return Layer.succeed(GithubRead, {
    branchHead: (repo, branch) =>
      read(`branch ${branch}`, repo, `/repos/${repo}/git/ref/heads/${enc(branch)}`, Ref).pipe(
        Effect.map((r) => r.object.sha),
      ),
    tagCommit: (repo, tag) =>
      Effect.gen(function* () {
        const ref = yield* read(`tag ${tag}`, repo, `/repos/${repo}/git/ref/tags/${enc(tag)}`, Ref);
        if (ref.object.type !== "tag") return ref.object.sha;
        const annotated = yield* read(
          `tag ${tag}`,
          repo,
          `/repos/${repo}/git/tags/${ref.object.sha}`,
          Tag,
        );
        return annotated.object.sha;
      }),
    reachableFrom: (repo, sha, branch) =>
      read(
        `compare ${branch}...${sha}`,
        repo,
        `/repos/${repo}/compare/${enc(branch)}...${sha}`,
        Compare,
      ).pipe(Effect.map((c) => c.status === "identical" || c.status === "behind")),
  });
};

/** One executor kind's Layer: requests leave through `fetch`, which the egress proxy credentials. */
export const githubReadLayer = (options: GithubReadOptions): Layer.Layer<GithubRead> =>
  githubReadOver((what, _repo, path) =>
    Effect.gen(function* () {
      const response = yield* Effect.tryPromise({
        try: () =>
          options.fetch(`${options.apiBase}${path}`, {
            headers: {
              accept: "application/vnd.github+json",
              "x-github-api-version": "2022-11-28",
            },
          }),
        catch: (cause) => new GithubReadFailed({ what, detail: String(cause) }),
      });
      if (response.status === 401) return yield* new GithubUncredentialed({ what });
      if (!response.ok)
        return yield* new GithubReadFailed({
          what,
          status: response.status,
          detail: response.statusText,
        });
      return yield* Effect.tryPromise({
        try: () => response.json() as Promise<unknown>,
        catch: (cause) => new GithubReadFailed({ what, detail: `body: ${String(cause)}` }),
      });
    }),
  );
