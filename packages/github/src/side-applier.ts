// FlareDispatch's appliers for the side-output kinds (specs/github-output.md
// § Intents, § Side outputs). Each adoptable kind searches for its idempotency
// marker before it writes, so a repeat after a lost answer adopts the object the
// earlier attempt made; `lookup` answers from the same search (FD-GH-092).
import {
  AlarmPort,
  type ApplyAnswer,
  type IntentRow,
  type LookupAnswer,
} from "@fractalboxdev/mameko-ports";
import { Clock, Context, Effect, Match, Option, Schema } from "effect";
import { GithubApp } from "./app.ts";
import { classify, InstallationDirectory } from "./applier.ts";
import { GithubHttpError, GithubNetworkError, type GithubError } from "./client.ts";
import { commentWriteReceipt, commentWriteResource } from "./comment-writes.ts";
import {
  BlobStore,
  EmailSender,
  FollowOnSubmitter,
  NoticeChannel,
  SideOutputConfig,
  StagedWriteGate,
  type DeliveryAnswer,
} from "./side-ports.ts";
import { GithubWrites, type CommitAuthor, type IssueRef } from "./writes.ts";

/** Every write branch lives under this prefix (FD-GH-082, FD-AGT-028). */
export const WRITE_BRANCH_PREFIX = "flare-dispatch/";

const Mode = Schema.Literals(["100644", "100755"]);

export const SidePayloads = {
  comment: Schema.Struct({
    issue_number: Schema.Number,
    body: Schema.String,
    /**
     * A marker the run keeps on one comment per issue or pull request: the comment carrying it is updated in place
     * instead of a new one being created (FD-AGT-053).
     */
    marker: Schema.optionalKey(Schema.NonEmptyString),
  }),
  review: Schema.Struct({
    pull_number: Schema.Number,
    body: Schema.String,
    commit_id: Schema.optionalKey(Schema.String),
  }),
  issue: Schema.Struct({
    /** Required to create or update an issue; a close carries neither. */
    title: Schema.optionalKey(Schema.String),
    body: Schema.optionalKey(Schema.String),
    labels: Schema.optionalKey(Schema.Array(Schema.String)),
    /** Updates this issue instead of creating one. */
    number: Schema.optionalKey(Schema.Number),
    /** Closes the issue `number` names with the state reason `duplicate`, in favour of this issue. */
    close_as_duplicate_of: Schema.optionalKey(Schema.Number),
  }),
  label: Schema.Struct({
    issue_number: Schema.Number,
    add: Schema.optionalKey(Schema.Array(Schema.String)),
    remove: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
  "pr.propose": Schema.Struct({
    branch: Schema.String,
    base: Schema.String,
    title: Schema.String,
    body: Schema.String,
    message: Schema.String,
    /** A draft unless the manifest sets false (FD-GH-083). */
    draft: Schema.optionalKey(Schema.Boolean),
    entries: Schema.Array(
      Schema.Struct({
        path: Schema.String,
        mode: Mode,
        digest: Schema.String,
        size: Schema.Number,
      }),
    ),
  }),
  "pr.close": Schema.Struct({ pull_number: Schema.Number }),
  "release.draft": Schema.Struct({
    tag: Schema.String,
    target: Schema.String,
    name: Schema.String,
    body: Schema.String,
    assets: Schema.optionalKey(
      Schema.Array(
        Schema.Struct({ name: Schema.String, digest: Schema.String, content_type: Schema.String }),
      ),
    ),
  }),
  "release.publish": Schema.Struct({ tag: Schema.String }),
  "dispatch.followOn": Schema.Struct({
    run: Schema.String,
    label: Schema.optionalKey(Schema.String),
    inputs: Schema.Unknown,
  }),
  "notify.email": Schema.Struct({
    to: Schema.Array(Schema.String),
    subject: Schema.String,
    text: Schema.String,
  }),
  "notify.slack": Schema.Struct({
    text: Schema.String,
    blocks: Schema.optionalKey(Schema.Unknown),
  }),
  "notice.publish": Schema.Struct({
    run: Schema.String,
    use_case: Schema.String,
    dedupe_key: Schema.String,
    title: Schema.String,
    body: Schema.String,
  }),
  "canary.push": Schema.Struct({ branch: Schema.String, tick_time: Schema.String }),
  "delivery.redeliver": Schema.Struct({ delivery_id: Schema.Number }),
} as const;

export type SideKind = keyof typeof SidePayloads;
type PayloadOf<K extends SideKind> = (typeof SidePayloads)[K]["Type"];

export const isSideKind = (kind: string): kind is SideKind => Object.hasOwn(SidePayloads, kind);

/** The hidden marker a comment, review or issue body carries (specs/github-output.md § Intents). */
export const intentMarker = (row: Pick<IntentRow, "executionId" | "intentKey">) =>
  `<!-- flare-dispatch:intent ${row.executionId ?? "ops"}/${row.intentKey} -->`;

const withMarker = (body: string, marker: string) => `${body}\n\n${marker}`;

/** The execution id in the footer we append; quoted markers in the run's body carry no ordering authority. */
const markedExecution = (body: string | null) => {
  const id = body?.match(/<!-- flare-dispatch:intent ([^\s/]+)\/[^\r\n]* -->\s*$/)?.[1];
  return id === undefined || id === "ops" ? null : id;
};

/** The row ends `refused` with this reason and no further GitHub call. */
export class Refusal extends Schema.TaggedError<Refusal>()("Refusal", { reason: Schema.String }) {}
const refuse = (reason: string) => Effect.fail(new Refusal({ reason }));

/** A non-GitHub delivery asks to be tried again. */
class Retry extends Schema.TaggedError<Retry>()("Retry", { reason: Schema.String }) {}

/** More than one object carries the marker, so a lookup proves nothing. */
class Ambiguous extends Schema.TaggedError<Ambiguous>()("Ambiguous", { count: Schema.Number }) {}

const applied = (ref: string | number): ApplyAnswer => ({
  _tag: "applied",
  externalRef: String(ref),
});

/** Found exactly once, absent, or more than once. */
const single = <A>(xs: readonly A[], ref: (a: A) => string | number) =>
  xs.length === 0
    ? Effect.succeed(Option.none<string>())
    : xs.length === 1
      ? Effect.succeed(Option.some(String(ref(xs[0]!))))
      : Effect.fail(new Ambiguous({ count: xs.length }));

interface Ctx {
  readonly row: IntentRow;
  readonly installation: number;
  readonly repo: string;
}

type Deps = GithubWrites | SideOutputConfig | GithubApp;
type Failure = GithubError | Refusal | Retry | Ambiguous;

interface Handler<K extends SideKind> {
  /** Whether the kind calls the repository's installation. */
  readonly github: boolean;
  readonly apply: (ctx: Ctx, p: PayloadOf<K>) => Effect.Effect<ApplyAnswer, Failure, Deps>;
  /** The object carrying the row's effect; absent for a replay-safe kind, which the drainer applies again. */
  readonly lookup: (
    ctx: Ctx,
    p: PayloadOf<K>,
  ) => Effect.Effect<Option.Option<string>, Failure, Deps>;
}

const writes = GithubWrites.use((s) => Effect.succeed(s));
const notLooked = () => Effect.succeed(Option.none<string>());

/** Whether every commit is the App's own, by account login or by the git author email it commits with. */
const allApp = (commits: readonly CommitAuthor[]) =>
  Effect.map(
    SideOutputConfig.use((s) => Effect.succeed(s)),
    ({ appBot }) => commits.every((c) => c.login === appBot.login || c.email === appBot.email),
  );

const humanCommits = "writeback: human-commits-present";

const deliveryAnswer = (a: DeliveryAnswer): Effect.Effect<ApplyAnswer, Refusal | Retry> =>
  Match.value(a).pipe(
    Match.tag("sent", ({ ref }) => Effect.succeed(applied(ref))),
    Match.tag("refused", ({ reason }) => refuse(reason)),
    Match.tag("retryable", ({ reason }) => Effect.fail(new Retry({ reason }))),
    Match.exhaustive,
  );

const hex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");

/** `v1=<hex HMAC-SHA256 over "<timestamp>.<body>">`, the signature a Slack verdict POST carries (FD-GH-079). */
export const slackSignature = (secret: string, timestamp: string, body: string) =>
  Effect.promise(async () => {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    return `v1=${hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${body}`)))}`;
  });

const base64 = (bytes: Uint8Array) => {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
};

const optional = <I, S>(tag: Context.Key<I, S>, kind: string) =>
  Effect.flatMap(Effect.serviceOption(tag), (s) =>
    Option.match(s, {
      onNone: () => refuse(`applier: ${kind} is not configured on this deployment`),
      onSome: (v) => Effect.succeed(v),
    }),
  );

const releaseFor = (ctx: Ctx, tag: string) =>
  Effect.gen(function* () {
    const w = yield* writes;
    return (yield* w.releases(ctx)).find((r) => r.tag_name === tag) ?? null;
  });

/** Issue list pages the marker search reads before it stops without an answer. */
export const ISSUE_PAGES = 50;

/**
 * Every issue whose body carries the marker, read page by page until GitHub's list ends. A search that cannot reach
 * the end, a failed page included, fails rather than answering empty: an empty answer creates the issue again.
 */
const issuesWithMarker = (ctx: Ctx, marker: string) =>
  Effect.gen(function* () {
    const w = yield* writes;
    const found: IssueRef[] = [];
    for (let page = 1; page <= ISSUE_PAGES; page++) {
      const batch = yield* w.issuesPage({ ...ctx, page });
      found.push(...batch.filter((i) => i.pull_request === undefined && i.body?.includes(marker)));
      if (batch.length < 100) return found;
    }
    return yield* new Retry({
      reason: `issue: the marker search read ${ISSUE_PAGES} pages without reaching the end`,
    });
  });

const owner = (repo: string) => repo.slice(0, repo.indexOf("/"));

/** Serialization covers the external object, independently of the drainer's expiring per-row claim. */
const orderedComment = (ctx: Ctx, p: PayloadOf<"comment"> & { readonly marker: string }) =>
  Effect.gen(function* () {
    const w = yield* writes;
    const { appBot, commentWrites: store } = yield* SideOutputConfig;
    if (store === undefined)
      return yield* refuse("comment: durable write ownership is not configured");
    const resource = commentWriteResource(ctx.repo, p.issue_number);
    const pending = yield* store.read(resource);
    if (pending !== null) {
      const comments = yield* w.listComments({ ...ctx, issue: p.issue_number });
      const receipts = comments.filter(
        (c) => c.user?.login === appBot.login && c.body?.trimEnd().endsWith(pending.receipt),
      );
      if (receipts.length !== 1)
        return yield* Effect.fail(
          new Retry({ reason: "comment: an earlier external write is unresolved" }),
        );
      // This unpredictable attempt receipt could only appear after the sole authorized mutation took effect.
      yield* store.release(resource, pending.token);
    }
    const token = crypto.randomUUID();
    const receipt = commentWriteReceipt(token, intentMarker(ctx.row));
    if (!(yield* store.claim(resource, { token, receipt })))
      return yield* Effect.fail(
        new Retry({ reason: "comment: another external write owns this pull request" }),
      );
    let dispatched = false;
    return yield* Effect.gen(function* () {
      // Re-read under durable ownership: a pre-claim snapshot cannot authorize an older PATCH.
      const comments = yield* w.listComments({ ...ctx, issue: p.issue_number });
      const existing = yield* single(
        comments.filter(
          (c) => c.user?.login === appBot.login && c.body?.includes(intentMarker(ctx.row)),
        ),
        (c) => c.id,
      );
      if (Option.isSome(existing)) return applied(existing.value);
      const kept = comments.find(
        (c) => c.user?.login === appBot.login && c.body?.includes(p.marker),
      );
      if (kept !== undefined) {
        const holder = markedExecution(kept.body);
        if (holder !== null && ctx.row.executionId !== null && holder > ctx.row.executionId)
          return applied(kept.id);
      }
      const body = withMarker(
        p.body.includes(p.marker) ? p.body : withMarker(p.body, p.marker),
        receipt,
      );
      const mutation =
        kept === undefined
          ? w.createComment({ ...ctx, issue: p.issue_number, body })
          : w.updateComment({ ...ctx, comment: kept.id, body });
      dispatched = true;
      const written = yield* mutation.pipe(
        Effect.catchTags({
          GithubHttpError: (e) =>
            [401, 403, 404, 422, 429].includes(e.status)
              ? Effect.andThen(store.release(resource, token), Effect.fail(e))
              : Effect.fail(e),
          GithubNetworkError: (e) =>
            e.sent
              ? Effect.fail(e)
              : Effect.andThen(store.release(resource, token), Effect.fail(e)),
        }),
      );
      // An acknowledged mutation has settled; an ambiguous/erroring mutation retains ownership without a TTL.
      yield* store.release(resource, token);
      return applied(written.id);
    }).pipe(
      Effect.onExit(() =>
        dispatched
          ? Effect.void
          : store
              .release(resource, token)
              .pipe(
                Effect.catchTag("GithubNetworkError", () =>
                  Effect.logWarning("comment presend ownership release unavailable"),
                ),
              ),
      ),
    );
  });

const handlers: { readonly [K in SideKind]: Handler<K> } = {
  comment: {
    github: true,
    apply: (ctx, p) =>
      Effect.gen(function* () {
        if (p.marker !== undefined) return yield* orderedComment(ctx, { ...p, marker: p.marker });
        const w = yield* writes;
        const marker = intentMarker(ctx.row);
        const comments = yield* w.listComments({ ...ctx, issue: p.issue_number });
        const existing = yield* single(
          comments.filter((c) => c.body?.includes(marker)),
          (c) => c.id,
        );
        if (Option.isSome(existing)) return applied(existing.value);
        return applied(
          (yield* w.createComment({
            ...ctx,
            issue: p.issue_number,
            body: withMarker(p.body, marker),
          })).id,
        );
      }),
    lookup: (ctx, p) =>
      Effect.flatMap(writes, (w) =>
        Effect.flatMap(w.listComments({ ...ctx, issue: p.issue_number }), (cs) =>
          single(
            cs.filter((c) => c.body?.includes(intentMarker(ctx.row))),
            (c) => c.id,
          ),
        ),
      ),
  },
  review: {
    github: true,
    apply: (ctx, p) =>
      Effect.gen(function* () {
        const w = yield* writes;
        const marker = intentMarker(ctx.row);
        const existing = yield* single(
          (yield* w.listReviews({ ...ctx, pull: p.pull_number })).filter((c) =>
            c.body?.includes(marker),
          ),
          (c) => c.id,
        );
        if (Option.isSome(existing)) return applied(existing.value);
        const created = yield* w.createReview({
          ...ctx,
          pull: p.pull_number,
          body: withMarker(p.body, marker),
          ...(p.commit_id === undefined ? {} : { commitId: p.commit_id }),
        });
        return applied(created.id);
      }),
    lookup: (ctx, p) =>
      Effect.flatMap(writes, (w) =>
        Effect.flatMap(w.listReviews({ ...ctx, pull: p.pull_number }), (cs) =>
          single(
            cs.filter((c) => c.body?.includes(intentMarker(ctx.row))),
            (c) => c.id,
          ),
        ),
      ),
  },
  issue: {
    github: true,
    apply: (ctx, p) =>
      Effect.gen(function* () {
        const w = yield* writes;
        if (p.close_as_duplicate_of !== undefined)
          return p.number === undefined
            ? yield* refuse("issue: a close names no issue")
            : applied((yield* w.closeIssue({ ...ctx, issue: p.number, reason: "duplicate" })).id);
        if (p.title === undefined || p.body === undefined)
          return yield* refuse("issue: a title and a body are required");
        const marker = intentMarker(ctx.row);
        const body = withMarker(p.body, marker);
        if (p.number !== undefined)
          return applied(
            (yield* w.updateIssue({ ...ctx, issue: p.number, title: p.title, body })).id,
          );
        const existing = yield* single(yield* issuesWithMarker(ctx, marker), (i) => i.id);
        if (Option.isSome(existing)) return applied(existing.value);
        return applied(
          (yield* w.createIssue({ ...ctx, title: p.title, body, labels: p.labels ?? [] })).id,
        );
      }),
    // A close carries no marker; closing a closed issue again changes nothing, so the drainer applies it again.
    lookup: (ctx, p) =>
      p.close_as_duplicate_of !== undefined
        ? notLooked()
        : Effect.flatMap(issuesWithMarker(ctx, intentMarker(ctx.row)), (is) =>
            single(is, (i) => i.id),
          ),
  },
  label: {
    github: true,
    apply: (ctx, p) =>
      Effect.gen(function* () {
        const w = yield* writes;
        if ((p.add ?? []).length > 0)
          yield* w.addLabels({ ...ctx, issue: p.issue_number, labels: p.add ?? [] });
        for (const label of p.remove ?? [])
          yield* w.removeLabel({ ...ctx, issue: p.issue_number, label });
        return applied(`${ctx.repo}#${p.issue_number}`);
      }),
    lookup: notLooked,
  },
  "pr.propose": {
    github: true,
    apply: (ctx, p) =>
      Effect.gen(function* () {
        // The staged-write gate runs before any GitHub call (FD-GH-080, FD-AGT-016, FD-AGT-018).
        const gate = yield* optional(StagedWriteGate, "pr.propose");
        yield* Match.value(yield* gate.check(ctx.row.payload)).pipe(
          Match.tag("accepted", () => Effect.void),
          Match.tag("rejected", ({ reasons }) => {
            const all = reasons.map((r) =>
              [r.kind, r.path, r.detail].filter((x) => x !== undefined).join(" "),
            );
            return refuse(`writeback: ${reasons[0]?.kind ?? "rejected"}; ${all.join("; ")}`);
          }),
          Match.exhaustive,
        );
        if (!p.branch.startsWith(WRITE_BRANCH_PREFIX) || p.branch === p.base)
          return yield* refuse("writeback: branch-invalid");
        const blobs = yield* optional(BlobStore, "pr.propose");
        const w = yield* writes;
        const { appBot } = yield* SideOutputConfig.use((s) => Effect.succeed(s));
        const target = yield* w.branch({ ...ctx, branch: p.branch });
        // A protected branch is never written (FD-GH-082).
        if (target?.protected === true) return yield* refuse("writeback: branch-protected");
        const base = yield* w.branch({ ...ctx, branch: p.base });
        if (base === null) return yield* refuse(`writeback: base branch ${p.base} not found`);
        if (
          target !== null &&
          !(yield* allApp(yield* w.commitsBetween({ ...ctx, base: p.base, head: p.branch })))
        )
          return yield* refuse(humanCommits);
        const entries = [];
        for (const e of p.entries) {
          const bytes = yield* blobs.read(e.digest);
          if (bytes === null) return yield* refuse(`writeback: blob-missing ${e.path}`);
          // Each blob is the file's raw bytes in base64, so a binary file arrives unchanged (FD-GH-081).
          entries.push({
            path: e.path,
            mode: e.mode,
            sha: (yield* w.createBlob({ ...ctx, base64: base64(bytes) })).sha,
          });
        }
        const baseCommit = yield* w.commit({ ...ctx, sha: base.sha });
        const tree = yield* w.createTree({ ...ctx, baseTree: baseCommit.tree.sha, entries });
        const commit = yield* w.createCommit({
          ...ctx,
          message: p.message,
          tree: tree.sha,
          parents: [base.sha],
          author: { name: appBot.name, email: appBot.email },
        });
        yield* w.setBranch({ ...ctx, branch: p.branch, sha: commit.sha, exists: target !== null });
        const open = yield* w.openPulls({ ...ctx, head: `${owner(ctx.repo)}:${p.branch}` });
        if (open[0] !== undefined) return applied(open[0].number);
        const pr = yield* w.createPull({
          ...ctx,
          title: p.title,
          body: p.body,
          head: p.branch,
          base: p.base,
          draft: p.draft ?? true,
        });
        return applied(pr.number);
      }),
    lookup: (ctx, p) =>
      Effect.flatMap(writes, (w) =>
        Effect.flatMap(w.openPulls({ ...ctx, head: `${owner(ctx.repo)}:${p.branch}` }), (prs) =>
          single(prs, (pr) => pr.number),
        ),
      ),
  },
  "pr.close": {
    github: true,
    apply: (ctx, p) =>
      Effect.gen(function* () {
        const w = yield* writes;
        const pr = yield* w.pull({ ...ctx, pull: p.pull_number });
        if (!pr.head.ref.startsWith(WRITE_BRANCH_PREFIX)) return yield* refuse(humanCommits);
        if (!(yield* allApp(yield* w.pullCommits({ ...ctx, pull: p.pull_number }))))
          return yield* refuse(humanCommits);
        if (pr.state === "closed") return applied(pr.number);
        return applied((yield* w.closePull({ ...ctx, pull: p.pull_number })).number);
      }),
    lookup: notLooked,
  },
  "release.draft": {
    github: true,
    apply: (ctx, p) =>
      Effect.gen(function* () {
        const w = yield* writes;
        const existing = yield* releaseFor(ctx, p.tag);
        // A published release is never modified (FD-GH-085).
        if (existing !== null && !existing.draft)
          return yield* refuse(`release: ${p.tag} is already published`);
        const release =
          existing ??
          (yield* w.createDraftRelease({
            ...ctx,
            tag: p.tag,
            target: p.target,
            name: p.name,
            body: p.body,
          }));
        const missing = (p.assets ?? []).filter(
          (a) => !release.assets.some((x) => x.name === a.name),
        );
        if (missing.length > 0) {
          const blobs = yield* optional(BlobStore, "release.draft");
          for (const a of missing) {
            const bytes = yield* blobs.read(a.digest);
            if (bytes === null)
              return yield* refuse(`release: asset ${a.name} missing from the blob store`);
            yield* w.uploadAsset({
              ...ctx,
              release: release.id,
              name: a.name,
              contentType: a.content_type,
              bytes,
            });
          }
        }
        return applied(release.id);
      }),
    lookup: (ctx, p) =>
      Effect.map(releaseFor(ctx, p.tag), (r) =>
        Option.map(Option.fromNullOr(r), (x) => String(x.id)),
      ),
  },
  "release.publish": {
    github: true,
    apply: (ctx, p) =>
      Effect.gen(function* () {
        const w = yield* writes;
        const release = yield* releaseFor(ctx, p.tag);
        if (release === null) return yield* refuse(`release: no draft release for ${p.tag}`);
        // A published release stays as it is (FD-GH-086).
        if (!release.draft) return applied(release.id);
        return applied((yield* w.publishRelease({ ...ctx, release: release.id })).id);
      }),
    lookup: (ctx, p) =>
      Effect.map(releaseFor(ctx, p.tag), (r) =>
        r === null || r.draft ? Option.none<string>() : Option.some(String(r.id)),
      ),
  },
  "canary.push": {
    github: true,
    apply: (ctx, p) =>
      Effect.gen(function* () {
        const w = yield* writes;
        const { appBot } = yield* SideOutputConfig.use((s) => Effect.succeed(s));
        const head = yield* w.branch({ ...ctx, branch: p.branch });
        if (head === null) return yield* refuse(`canary: branch ${p.branch} not found`);
        const tip = yield* w.commit({ ...ctx, sha: head.sha });
        if (tip.message.includes(p.tick_time)) return applied(tip.sha);
        const commit = yield* w.createCommit({
          ...ctx,
          message: `flare-dispatch canary ${p.tick_time}`,
          tree: tip.tree.sha,
          parents: [tip.sha],
          author: { name: appBot.name, email: appBot.email },
        });
        yield* w.setBranch({ ...ctx, branch: p.branch, sha: commit.sha, exists: true });
        return applied(commit.sha);
      }),
    lookup: (ctx, p) =>
      Effect.gen(function* () {
        const w = yield* writes;
        const head = yield* w.branch({ ...ctx, branch: p.branch });
        if (head === null) return Option.none<string>();
        const tip = yield* w.commit({ ...ctx, sha: head.sha });
        return tip.message.includes(p.tick_time) ? Option.some(tip.sha) : Option.none<string>();
      }),
  },
  "delivery.redeliver": {
    github: false,
    // The App JWT, not an installation token, authorises a redelivery (FD-GH-089).
    apply: (ctx, p) =>
      Effect.gen(function* () {
        const app = yield* GithubApp.use((s) => Effect.succeed(s));
        const existing = yield* redeliveries(p.delivery_id);
        if (Option.isSome(existing)) return applied(existing.value);
        const { status, json } = yield* app
          .rest("POST", `/app/hook/deliveries/${p.delivery_id}/attempts`)
          .pipe(Effect.catchTag("AppKeyInvalid", (e) => refuse(`app key: ${e.message}`)));
        if (status >= 200 && status < 300) return applied(`redelivery:${p.delivery_id}`);
        return yield* httpFailure(status, json);
      }),
    lookup: (_, p) => redeliveries(p.delivery_id),
  },
  "dispatch.followOn": {
    github: false,
    apply: (ctx, p) =>
      Effect.gen(function* () {
        const submitter = yield* optional(FollowOnSubmitter, "dispatch.followOn");
        if (ctx.row.executionId === null)
          return yield* refuse("dispatch.followOn belongs to an execution");
        const answer = yield* submitter.submit({
          executionId: ctx.row.executionId,
          intentKey: ctx.row.intentKey,
          run: p.run,
          label: p.label ?? null,
          inputs: p.inputs,
        });
        return yield* Match.value(answer).pipe(
          Match.tag("admitted", ({ executionId }) => Effect.succeed(applied(executionId))),
          Match.tag("refused", ({ reason }) => refuse(reason)),
          Match.tag("unavailable", ({ reason }) => Effect.fail(new Retry({ reason }))),
          Match.exhaustive,
        );
      }),
    lookup: notLooked,
  },
  "notify.email": {
    github: false,
    apply: (ctx, p) =>
      Effect.gen(function* () {
        const email = yield* optional(EmailSender, "notify.email");
        const messageId = `<${ctx.row.executionId ?? "ops"}.${ctx.row.intentKey.replaceAll(":", ".")}@flare-dispatch>`;
        return yield* deliveryAnswer(
          yield* email.send({ messageId, to: p.to, subject: p.subject, text: p.text }),
        );
      }),
    lookup: notLooked,
  },
  "notify.slack": {
    github: false,
    apply: (ctx, p) =>
      Effect.gen(function* () {
        const { slack, fetch } = yield* SideOutputConfig.use((s) => Effect.succeed(s));
        if (slack === undefined)
          return yield* refuse("notify.slack: no Slack endpoint is configured");
        const body = JSON.stringify(p);
        const timestamp = String(Math.floor((yield* Clock.currentTimeMillis) / 1000));
        const signature = yield* slackSignature(slack.secret, timestamp, body);
        const response = yield* Effect.tryPromise({
          try: (signal) =>
            fetch(slack.url, {
              method: "POST",
              signal,
              headers: {
                "content-type": "application/json",
                "x-flare-dispatch-timestamp": timestamp,
                "x-flare-dispatch-signature": signature,
                "x-flare-dispatch-delivery": `${ctx.row.executionId ?? "ops"}/${ctx.row.intentKey}`,
              },
              body,
            }),
          catch: (e) => new GithubNetworkError({ sent: true, message: String(e) }),
        });
        if (response.ok) return applied(`slack:${timestamp}`);
        return yield* httpFailure(response.status, { message: response.statusText });
      }),
    lookup: notLooked,
  },
  "notice.publish": {
    github: false,
    apply: (_, p) =>
      Effect.gen(function* () {
        const notices = yield* optional(NoticeChannel, "notice.publish");
        return yield* deliveryAnswer(
          yield* notices.publish({
            deliveryId: `${p.run}:${p.use_case}:${p.dedupe_key}`,
            title: p.title,
            body: p.body,
          }),
        );
      }),
    lookup: notLooked,
  },
};

const httpFailure = (status: number, json: unknown) =>
  Effect.fail(
    new GithubHttpError({
      status,
      message:
        typeof json === "object" && json !== null && "message" in json
          ? String(json.message)
          : `status ${status}`,
      rateLimited: status === 429,
    }),
  );

const Delivery = Schema.Struct({
  id: Schema.Number,
  guid: Schema.String,
  redelivery: Schema.Boolean,
});

/** A redelivery of the delivery's event, read back from the App's delivery list (FD-GH-092). */
const redeliveries = (deliveryId: number) =>
  Effect.gen(function* () {
    const app = yield* GithubApp.use((s) => Effect.succeed(s));
    const read = (path: string) =>
      app.rest("GET", path).pipe(
        Effect.catchTag("AppKeyInvalid", (e) =>
          Effect.fail(new GithubNetworkError({ sent: false, message: e.message })),
        ),
        Effect.flatMap(({ status, json }) =>
          status >= 200 && status < 300 ? Effect.succeed(json) : httpFailure(status, json),
        ),
      );
    const original = Schema.decodeUnknownOption(Delivery)(
      yield* read(`/app/hook/deliveries/${deliveryId}`),
    );
    if (Option.isNone(original))
      return yield* new GithubNetworkError({ sent: false, message: "delivery unreadable" });
    const list = Schema.decodeUnknownOption(Schema.Array(Delivery))(
      yield* read("/app/hook/deliveries?per_page=100"),
    );
    const attempts = Option.getOrElse(list, () => []).filter(
      (d) => d.redelivery && d.guid === original.value.guid && d.id !== deliveryId,
    );
    return yield* single(attempts, (d) => d.id);
  });

const reasonOf = (e: Failure): string =>
  Match.value(e).pipe(
    Match.tag("GithubHttpError", ({ status, message }) => `github ${status}: ${message}`),
    Match.tag("GithubNetworkError", ({ message }) => `network: ${message}`),
    Match.tag("Refusal", ({ reason }) => reason),
    Match.tag("Retry", ({ reason }) => reason),
    Match.tag("Ambiguous", ({ count }) => `${count} objects carry the marker`),
    Match.exhaustive,
  );

/** The side-output applier's service; the router sends it every kind of `SidePayloads`. */
export const makeSideOutputApplier = Effect.gen(function* () {
  const context = yield* Effect.context<
    GithubWrites | SideOutputConfig | GithubApp | InstallationDirectory | AlarmPort
  >();
  const directory = yield* InstallationDirectory;
  const alarms = yield* AlarmPort;
  const w = yield* GithubWrites;

  const installationLost = (row: IntentRow, reason: string) =>
    alarms
      .deliver({
        name: "installation-lost",
        severity: "page",
        dedupeKey: `installation-lost:${row.scopeId}`,
        state: "raised",
        detail: { scopeId: row.scopeId, kind: row.kind, reason },
      })
      .pipe(
        Effect.catchTag("AlarmDeliveryFailed", (e) =>
          Effect.logWarning("alarm not delivered", e.reason),
        ),
      );

  const resolve = (row: IntentRow) =>
    Effect.gen(function* () {
      const kind = row.kind;
      if (!isSideKind(kind)) return yield* refuse(`applier: ${kind} is not a side-output kind`);
      const payload = yield* Schema.decodeUnknownEffect(SidePayloads[kind])(row.payload).pipe(
        Effect.catchTag("SchemaError", (e) => refuse(`payload: ${e.message}`)),
      );
      const handler = handlers[kind] as unknown as Handler<SideKind>;
      let installation = 0;
      if (handler.github) {
        const found = yield* directory.installationFor(row.scopeId);
        if (found === null) {
          yield* installationLost(row, "installation: not found");
          return yield* refuse("installation: not found");
        }
        installation = found;
      }
      return { ctx: { row, installation, repo: row.scopeId }, payload: payload as never, handler };
    });

  /** One `401` mints a new token and retries once (FD-GH-047). */
  const retry401 = <A>(ctx: Ctx, github: boolean, effect: Effect.Effect<A, Failure, Deps>) =>
    github
      ? effect.pipe(
          Effect.catchTag("GithubHttpError", (e: GithubHttpError) =>
            e.status === 401
              ? Effect.andThen(w.refreshToken(ctx.installation), effect)
              : Effect.fail(e),
          ),
        )
      : effect;

  const apply = (row: IntentRow): Effect.Effect<ApplyAnswer> =>
    Effect.gen(function* () {
      const { ctx, payload, handler } = yield* resolve(row);
      return yield* retry401(ctx, handler.github, handler.apply(ctx, payload));
    }).pipe(
      Effect.catchTags({
        Refusal: ({ reason }) => Effect.succeed<ApplyAnswer>({ _tag: "refused", reason }),
        Retry: ({ reason }) => Effect.succeed<ApplyAnswer>({ _tag: "retryable", reason }),
        Ambiguous: ({ count }) =>
          Effect.succeed<ApplyAnswer>({
            _tag: "refused",
            reason: `${count} objects carry the marker`,
          }),
        GithubHttpError: (e) =>
          e.status === 401
            ? Effect.as(installationLost(row, "installation: unauthorized"), classify(e))
            : Effect.succeed(classify(e)),
        GithubNetworkError: (e) => Effect.succeed(classify(e)),
      }),
      Effect.provide(context),
    );

  const lookup = (row: IntentRow): Effect.Effect<LookupAnswer> =>
    Effect.gen(function* () {
      const { ctx, payload, handler } = yield* resolve(row);
      return yield* retry401(ctx, handler.github, handler.lookup(ctx, payload));
    }).pipe(
      Effect.match({
        onFailure: (e): LookupAnswer => ({ _tag: "undetermined", reason: reasonOf(e) }),
        onSuccess: (found): LookupAnswer =>
          Option.match(found, {
            onNone: () => ({ _tag: "absent" }),
            onSome: (externalRef) => ({ _tag: "found", externalRef }),
          }),
      }),
      Effect.provide(context),
    );

  return { apply, lookup, reconcile: lookup };
});
