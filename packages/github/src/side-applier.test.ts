import { testCommentWrites } from "./comment-writes.test-support.ts";
// The side-output appliers over an in-memory repository: each kind's write, its idempotency marker, its refusals
// and its lookup.
import { createHmac } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { deliveryLimitKey, RECORD_KINDS } from "@fractalboxdev/flare-dispatch-profile";
import {
  ActuatorRateLimit,
  Actuators,
  AlarmPort,
  type Alarm,
  type IntentRow,
} from "@fractalboxdev/mameko-ports";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { GithubApp } from "./app.ts";
import { InstallationDirectory } from "./applier.ts";
import { GithubHttpError, GithubNetworkError } from "./client.ts";
import {
  BOT,
  commitOn,
  fakeSide,
  fakeWritesLayer,
  type FakeSide,
} from "./fake-writes.test-support.ts";
import { fakeConcludeFacts, fakeGithub } from "./fake.test-support.ts";
import { GithubApplierLive } from "./github-applier.ts";
import { ActuatorRateLimitLive, InstallationQuota, RECORDS_LIMIT_KEY } from "./rate-limit.ts";
import { JOB_RECORD_SCHEMA, VERDICT_RECORD_SCHEMA } from "./records.ts";
import { intentMarker, ISSUE_PAGES, recordDeliveryId } from "./side-applier.ts";
import {
  BlobStore,
  EmailSender,
  FollowOnSubmitter,
  NoticeChannel,
  ReleaseProvenance,
  SideOutputConfig,
  StagedWriteGate,
  type GateResult,
  type ReleaseGateAnswer,
  type ReleasePublishArtifact,
} from "./side-ports.ts";
import { GithubClient } from "./client.ts";

const REPO = "acme/app";
const RECORDS_URL = "https://records.example.com/hook";
const RECORDS_SECRET = "records-secret";

interface World {
  readonly side: FakeSide;
  readonly alarms: Alarm[];
  readonly slackPosts: { headers: Headers; body: string }[];
  /** Each `POST` to `records.url`, with its URL and redirect mode. */
  readonly recordPosts: {
    url: string;
    redirect: string | undefined;
    headers: Headers;
    body: string;
  }[];
  /** What the records endpoint answers each `POST`, in order: a status, or `lost` for a dropped answer; then `200`. */
  readonly recordAnswers: (number | "lost")[];
  /** Whether the deploy names a records endpoint. */
  records: boolean;
  readonly emails: unknown[];
  readonly notices: unknown[];
  readonly followOns: unknown[];
  readonly appCalls: string[];
  gate: GateResult;
  /** What the release provenance gate answers; absent on a deploy without the gate. */
  releaseGate: ReleaseGateAnswer | undefined;
  /** Each release the provenance gate was asked about. */
  readonly releaseGated: { assets: readonly string[]; artifacts: readonly ReleasePublishArtifact[] }[];
  readonly blobs: Map<string, Uint8Array>;
  /** The App's webhook deliveries, for `delivery.redeliver`. */
  readonly deliveries: { id: number; guid: string; redelivery: boolean }[];
}

const world = (): World => ({
  side: fakeSide(),
  alarms: [],
  slackPosts: [],
  recordPosts: [],
  recordAnswers: [],
  records: true,
  emails: [],
  notices: [],
  followOns: [],
  appCalls: [],
  gate: { _tag: "accepted" },
  releaseGate: { _tag: "admitted" },
  releaseGated: [],
  blobs: new Map(),
  deliveries: [{ id: 10, guid: "g-1", redelivery: false }],
});

const withoutWriteReceipt = (body: string | undefined) =>
  body?.replace(/<!-- flare-dispatch:comment-write [a-f0-9-]+ -->\n\n/g, "");

const unused = () => Effect.die("not used by the side-output applier");

const layers = (w: World, installations: Record<string, number> = { [REPO]: 7 }, withGate = true) =>
  Layer.mergeAll(
    fakeWritesLayer(w.side),
    Layer.succeed(InstallationDirectory, {
      installationFor: (scope) => Effect.succeed(installations[scope] ?? null),
    }),
    Layer.succeed(AlarmPort, { deliver: (a) => Effect.sync(() => void w.alarms.push(a)) }),
    fakeConcludeFacts(fakeGithub()),
    Layer.succeed(SideOutputConfig, {
      commentWrites: testCommentWrites(w),
      appBot: BOT,
      slack: { url: "https://hooks.example.com/verdicts", secret: "slack-secret" },
      ...(w.records ? { records: { url: RECORDS_URL, secret: RECORDS_SECRET } } : {}),
      fetch: (async (url: unknown, init?: RequestInit) => {
        if (String(url) === RECORDS_URL) {
          w.recordPosts.push({
            url: String(url),
            redirect: init?.redirect,
            headers: new Headers(init?.headers),
            body: String(init?.body),
          });
          const answer = w.recordAnswers.shift() ?? 200;
          if (answer === "lost") throw new TypeError("connection reset");
          return new Response(null, { status: answer });
        }
        w.slackPosts.push({ headers: new Headers(init?.headers), body: String(init?.body) });
        return new Response("ok");
      }) as typeof fetch,
    }),
    Layer.succeed(GithubApp, {
      jwt: Effect.succeed("app-jwt"),
      token: unused,
      installationFor: unused,
      evictInstallation: unused,
      evictRepositories: unused,
      installations: unused(),
      rest: (method, path) =>
        Effect.sync(() => {
          w.appCalls.push(`${method} ${path}`);
          if (method === "POST") {
            w.deliveries.push({ id: 11, guid: "g-1", redelivery: true });
            return { status: 202, json: null };
          }
          if (path === "/app/hook/deliveries?per_page=100")
            return { status: 200, json: w.deliveries };
          const id = Number(path.split("/").pop());
          const d = w.deliveries.find((x) => x.id === id);
          return d === undefined
            ? { status: 404, json: { message: "Not Found" } }
            : { status: 200, json: d };
        }),
    }),
    withGate
      ? Layer.succeed(StagedWriteGate, { check: () => Effect.sync(() => w.gate) })
      : Layer.empty,
    Layer.succeed(BlobStore, { read: (d) => Effect.succeed(w.blobs.get(d) ?? null) }),
    w.releaseGate === undefined
      ? Layer.empty
      : Layer.succeed(ReleaseProvenance, {
          gate: (release) =>
            Effect.sync(() => {
              w.releaseGated.push(release);
              return w.releaseGate!;
            }),
        }),
    Layer.succeed(FollowOnSubmitter, {
      submit: (i) =>
        Effect.sync(() => {
          w.followOns.push(i);
          return { _tag: "admitted" as const, executionId: `child-of-${i.executionId}` };
        }),
    }),
    Layer.succeed(EmailSender, {
      send: (m) =>
        Effect.sync(() => (w.emails.push(m), { _tag: "sent" as const, ref: m.messageId })),
    }),
    Layer.succeed(NoticeChannel, {
      publish: (n) =>
        Effect.sync(() => (w.notices.push(n), { _tag: "sent" as const, ref: n.deliveryId })),
    }),
    Layer.succeed(GithubClient, {
      createCheckRun: unused,
      updateCheckRun: unused,
      listCheckRuns: unused,
      listAnnotations: unused,
      refreshToken: unused,
    }),
  );

const row = (kind: string, payload: unknown, overrides: Partial<IntentRow> = {}): IntentRow => ({
  executionId: "exec-1",
  scopeId: REPO,
  intentKey: `run:step:0`,
  kind,
  payload,
  payloadDigest: "digest",
  effectClass: "adoptable",
  attempts: 0,
  ...overrides,
});

/** The actuator binding the profile names for each kind these tests apply; an undeclared kind takes `pullRequest`. */
const BINDING: Readonly<Record<string, string>> = {
  comment: "issueComment",
  review: "pullReview",
  issue: "issue",
  label: "labels",
  "pr.propose": "pullRequest",
  "pr.close": "pullRequest",
  "release.draft": "release",
  "release.publish": "release",
  "dispatch.followOn": "followOn",
  "notice.publish": "notice",
  "notify.slack": "notifySlack",
  "job.record": "verdictRecord",
  "verdict.record": "verdictRecord",
};
const actuatorFor = (r: IntentRow) =>
  Actuators.use((registry) => Effect.succeed(registry.get(BINDING[r.kind] ?? "pullRequest")!));

const apply = (w: World, r: IntentRow, installations?: Record<string, number>) =>
  Effect.runPromise(
    actuatorFor(r).pipe(
      Effect.flatMap((a) => a.apply(r)),
      Effect.provide(GithubApplierLive),
      Effect.provide(layers(w, installations)),
    ),
  );
const lookup = (w: World, r: IntentRow) =>
  Effect.runPromise(
    actuatorFor(r).pipe(
      Effect.flatMap((a) => a.lookup!(r)),
      Effect.provide(GithubApplierLive),
      Effect.provide(layers(w)),
    ),
  );

const writes = (w: World) =>
  w.side.calls.filter((c) => /^(create|update|add|remove|set|close|publish|upload)/.test(c));

describe("comment, review and issue", () => {
  it("[FD-GH-092] a comment carries the hidden marker; a repeat adopts it and lookup finds it once", async () => {
    const w = world();
    const r = row("comment", { issue_number: 3, body: "hello" });
    const first = await apply(w, r);
    const again = await apply(w, r);
    expect(first).toEqual(again);
    expect(w.side.comments.get(3)).toEqual([
      {
        id: expect.any(Number),
        body: `hello\n\n<!-- flare-dispatch:intent exec-1/run:step:0 -->`,
        user: { login: BOT.login },
      },
    ]);
    expect(await lookup(w, r)).toEqual({
      _tag: "found",
      externalRef: (first as { externalRef: string }).externalRef,
    });
    expect(await lookup(w, row("comment", { issue_number: 4, body: "x" }))).toEqual({
      _tag: "absent",
    });
    w.side.failures.push(
      new GithubHttpError({ status: 502, message: "bad gateway", rateLimited: false }),
    );
    expect(await lookup(w, r)).toMatchObject({ _tag: "undetermined" });
  });

  it("[FD-GH-092] more than one object carrying the marker is undetermined", async () => {
    const w = world();
    const r = row("review", { pull_number: 5, body: "lgtm" });
    const marker = intentMarker(r);
    w.side.reviews.set(5, [
      { id: 1, body: `a\n\n${marker}` },
      { id: 2, body: `b\n\n${marker}` },
    ]);
    expect(await lookup(w, r)).toMatchObject({ _tag: "undetermined" });
  });

  it("[FD-GH-092] a review is a COMMENT review with the marker; an issue is created once and found by marker", async () => {
    const w = world();
    await apply(w, row("review", { pull_number: 5, body: "notes" }));
    expect(w.side.reviews.get(5)![0]!.body).toContain(intentMarker(row("review", {})));
    const issue = row(
      "issue",
      { title: "flake", body: "seen twice", labels: ["ci"] },
      { intentKey: "run:triage:1" },
    );
    await apply(w, issue);
    await apply(w, issue);
    expect(w.side.issues).toHaveLength(1);
    expect(await lookup(w, issue)).toMatchObject({ _tag: "found" });
  });

  it("[FD-GH-092] an issue older than the first page is found, and a search that cannot finish is undetermined", async () => {
    const w = world();
    const r = row("issue", { title: "flake", body: "seen" }, { intentKey: "run:triage:2" });
    w.side.issues.push({
      id: 1,
      number: 1,
      title: "flake",
      body: `seen\n\n${intentMarker(r)}`,
      labels: [],
    });
    for (let n = 2; n <= 150; n++)
      w.side.issues.push({ id: n, number: n, title: "other", body: "other", labels: [] });
    expect(await lookup(w, r)).toEqual({ _tag: "found", externalRef: "1" });
    expect(await apply(w, r)).toEqual({ _tag: "applied", externalRef: "1" });
    expect(w.side.issues).toHaveLength(150);

    // The second page fails: neither lookup nor apply decides on the first page alone.
    w.side.failures.push(
      null,
      new GithubHttpError({ status: 502, message: "bad gateway", rateLimited: false }),
    );
    expect(await lookup(w, r)).toMatchObject({ _tag: "undetermined" });
    w.side.failures.push(
      null,
      new GithubHttpError({ status: 502, message: "bad gateway", rateLimited: false }),
    );
    expect(await apply(w, r)).toMatchObject({ _tag: "retryable" });
    expect(w.side.issues).toHaveLength(150);
  });

  it("[FD-AGT-075] an issue close as a duplicate closes with state reason duplicate and writes nothing else", async () => {
    const w = world();
    w.side.issues.push(
      { id: 9, number: 9, title: "dup", body: "same crash", labels: [] },
      { id: 33, number: 3, title: "original", body: "crash", labels: [] },
    );
    const r = row("issue", { number: 9, close_as_duplicate_of: 3 }, { intentKey: "run:close:0" });
    expect(await apply(w, r)).toMatchObject({ _tag: "applied", externalRef: "9" });
    expect(writes(w)).toEqual(["closeIssue"]);
    expect(w.side.issues[0]).toMatchObject({
      title: "dup",
      body: "same crash",
      stateReason: "duplicate",
      duplicateIssueId: 33,
    });
    expect(await lookup(w, r)).toMatchObject({ _tag: "found", externalRef: "9" });
    expect(await apply(w, r)).toMatchObject({ _tag: "applied", externalRef: "9" });
    expect(await apply(w, row("issue", { close_as_duplicate_of: 3 }))).toMatchObject({
      _tag: "refused",
      reason: "issue: a close names no issue",
    });
    expect(await apply(w, row("issue", { number: 9 }))).toMatchObject({
      _tag: "refused",
      reason: "issue: a title and a body are required",
    });
    expect(writes(w)).toEqual(["closeIssue"]);
  });

  it("[FD-GH-092] an issue list longer than the search bound is undetermined, never absent", async () => {
    const w = world();
    for (let n = 1; n <= ISSUE_PAGES * 100; n++)
      w.side.issues.push({ id: n, number: n, title: "other", body: "other", labels: [] });
    const r = row("issue", { title: "flake", body: "seen" });
    expect(await lookup(w, r)).toMatchObject({ _tag: "undetermined" });
    expect(await apply(w, r)).toMatchObject({ _tag: "retryable" });
    expect(w.side.calls.filter((c) => c === "createIssue")).toEqual([]);
  });

  it("[FD-AGT-077] a lost duplicate-close answer never closes an issue a maintainer reopened before retry", async () => {
    const w = world();
    w.side.issues.push(
      { id: 9, number: 9, title: "dup", body: "same crash", labels: [] },
      { id: 33, number: 3, title: "original", body: "crash", labels: [] },
    );
    const r = row("issue", { number: 9, close_as_duplicate_of: 3 }, { intentKey: "run:close:0" });
    w.side.lostAnswers.push(new GithubNetworkError({ sent: true, message: "reset after close" }));
    expect(await apply(w, r)).toMatchObject({ _tag: "unknown" });
    Object.assign(w.side.issues[0]!, { state: "open", stateReason: "reopened" });
    expect(await lookup(w, r)).toMatchObject({ _tag: "absent" });
    expect(await apply(w, r)).toMatchObject({ _tag: "refused" });
    expect(w.side.issues[0]!.stateReason).toBe("reopened");
    expect(writes(w)).toEqual(["closeIssue"]);
  });

  it("[FD-AGT-077] a failed target or original read never permits an issue close", async () => {
    const w = world();
    w.side.issues.push(
      { id: 9, number: 9, title: "dup", body: "same crash", labels: [] },
      { id: 33, number: 3, title: "original", body: "crash", labels: [] },
    );
    const r = row("issue", { number: 9, close_as_duplicate_of: 3 });
    const unavailable = () =>
      new GithubHttpError({ status: 502, message: "bad gateway", rateLimited: false });
    w.side.failures.push(unavailable());
    expect(await lookup(w, r)).toMatchObject({ _tag: "undetermined" });
    w.side.failures.push(unavailable());
    expect(await apply(w, r)).toMatchObject({ _tag: "retryable" });
    w.side.failures.push(null, unavailable());
    expect(await apply(w, r)).toMatchObject({ _tag: "retryable" });
    expect(writes(w)).toEqual([]);
  });

  it("refuses a close payload for another repository before reading or writing an issue", async () => {
    const w = world();
    w.side.issues.push(
      { id: 9, number: 9, title: "dup", body: "same crash", labels: [] },
      { id: 33, number: 3, title: "original", body: "crash", labels: [] },
    );
    const wrong = row("issue", {
      number: 9,
      close_as_duplicate_of: 3,
      repo: { owner: "unrelated", name: "public" },
    });
    expect(await apply(w, wrong)).toMatchObject({
      _tag: "refused",
      reason: "issue: close repository does not match execution scope",
    });
    expect(await lookup(w, wrong)).toMatchObject({ _tag: "undetermined" });
    expect(w.side.calls).toEqual([]);
    const same = row("issue", {
      number: 9,
      close_as_duplicate_of: 3,
      repo: { owner: "ACME", name: "App" },
    });
    expect(await apply(w, same)).toMatchObject({ _tag: "applied", externalRef: "9" });
    expect(writes(w)).toEqual(["closeIssue"]);
  });

  it("[FD-AGT-077] adopts an already closed issue and refuses a closed original or a pull request", async () => {
    const w = world();
    w.side.issues.push(
      {
        id: 9,
        number: 9,
        title: "dup",
        body: "same crash",
        labels: [],
        state: "closed",
        stateReason: "completed",
      },
      { id: 33, number: 3, title: "original", body: "crash", labels: [], state: "closed" },
    );
    const r = row("issue", { number: 9, close_as_duplicate_of: 3 });
    expect(await apply(w, r)).toMatchObject({ _tag: "applied", externalRef: "9" });
    expect(await lookup(w, r)).toMatchObject({ _tag: "found", externalRef: "9" });
    w.side.issues[0]!.state = "open";
    expect(await apply(w, r)).toMatchObject({
      _tag: "refused",
      reason: "issue: the original is not an open issue",
    });
    Object.assign(w.side.issues[0]!, { pull_request: { url: "pull" } });
    expect(await apply(w, r)).toMatchObject({
      _tag: "refused",
      reason: "issue: a close names a pull request",
    });
    expect(writes(w)).toEqual([]);
  });

  it("[FD-GH-046] a lost answer after GitHub made the comment is adopted on the next attempt", async () => {
    const w = world();
    const r = row("comment", { issue_number: 3, body: "hello" });
    w.side.lostAnswers.push(new GithubNetworkError({ sent: true, message: "reset" }));
    expect(await apply(w, r)).toMatchObject({ _tag: "unknown" });
    expect(await apply(w, r)).toMatchObject({ _tag: "applied" });
    expect(w.side.comments.get(3)).toHaveLength(1);
  });

  it("[FD-AGT-053] a comment whose payload names a marker updates the one comment carrying it in place", async () => {
    const w = world();
    const MARK = "<!-- flare-dispatch: pr-review -->";
    w.side.comments.set(7, [{ id: 1, body: "a human comment" }]);
    const first = row("comment", { issue_number: 7, body: `review 1\n\n${MARK}`, marker: MARK });
    const created = await apply(w, first);
    const second = row(
      "comment",
      { issue_number: 7, body: "review 2", marker: MARK },
      { executionId: "exec-2" },
    );
    const updated = await apply(w, second);
    expect(updated).toEqual(created);
    expect(
      w.side.comments.get(7)?.map((c) => ({ ...c, body: withoutWriteReceipt(c.body) })),
    ).toEqual([
      { id: 1, body: "a human comment" },
      {
        id: Number((created as { externalRef: string }).externalRef),
        body: `review 2\n\n${MARK}\n\n${intentMarker(second)}`,
        user: { login: BOT.login },
      },
    ]);
    // A repeat of the row adopts the comment its earlier attempt updated, and lookup finds it.
    expect(await apply(w, second)).toEqual(updated);
    expect(writes(w)).toEqual(["createComment", "updateComment"]);
    expect(await lookup(w, second)).toEqual({ ...updated, _tag: "found" });
    // Of two comments carrying the marker, the earliest is the one kept.
    w.side.comments.set(8, [
      { id: 50, body: `old\n\n${MARK}`, user: { login: BOT.login } },
      { id: 51, body: `a later duplicate\n\n${MARK}`, user: { login: BOT.login } },
    ]);
    expect(
      await apply(w, row("comment", { issue_number: 8, body: `new\n\n${MARK}`, marker: MARK })),
    ).toEqual({ _tag: "applied", externalRef: "50" });
    expect(w.side.comments.get(8)?.[1]?.body).toBe(`a later duplicate\n\n${MARK}`);
  });

  it("[FD-AGT-053] a marked comment someone other than the App wrote is left untouched, and a new comment is created", async () => {
    const w = world();
    const MARK = "<!-- flare-dispatch: pr-review -->";
    const planted = { id: 1, body: `planted\n\n${MARK}`, user: { login: "mallory" } };
    w.side.comments.set(7, [{ ...planted }]);
    const r = row("comment", { issue_number: 7, body: "review", marker: MARK });
    const created = await apply(w, r);
    expect(created).toMatchObject({ _tag: "applied" });
    expect((created as { externalRef: string }).externalRef).not.toBe("1");
    expect(writes(w)).toEqual(["createComment"]);
    expect(w.side.comments.get(7)?.[0]).toEqual(planted);
    expect(w.side.comments.get(7)).toHaveLength(2);
  });

  it("[FD-AGT-053] an older execution's row never overwrites the review a newer execution wrote", async () => {
    const w = world();
    const MARK = "<!-- flare-dispatch: pr-review -->";
    const newer = row(
      "comment",
      { issue_number: 7, body: "review of exec-2", marker: MARK },
      { executionId: "exec-2" },
    );
    const older = row("comment", { issue_number: 7, body: "review of exec-1", marker: MARK });
    const kept = await apply(w, newer);
    expect(await apply(w, older)).toEqual(kept);
    expect(await apply(w, older)).toEqual(kept);
    expect(writes(w)).toEqual(["createComment"]);
    const comments = w.side.comments.get(7) ?? [];
    expect(comments).toHaveLength(1);
    expect(withoutWriteReceipt(comments[0]?.body)).toBe(
      `review of exec-2\n\n${MARK}\n\n${intentMarker(newer)}`,
    );
  });

  it("[FD-AGT-053] a quoted marker in review content cannot pin the comment against future reviews", async () => {
    const w = world();
    const MARK = "<!-- flare-dispatch: pr-review -->";
    const older = row(
      "comment",
      {
        issue_number: 7,
        body: "An example marker:\n\n```html\n<!-- flare-dispatch:intent 7ZZZZZZZZZZZZZZZZZZZZZZZZZ/run:comment:0 -->\n```",
        marker: MARK,
      },
      { executionId: "01K97WGW010000000000000000" },
    );
    const newer = row(
      "comment",
      { issue_number: 7, body: "current review", marker: MARK },
      {
        executionId: "01K97WGW020000000000000000",
      },
    );
    const first = await apply(w, older);
    expect(await apply(w, newer)).toEqual(first);
    expect(w.side.comments.get(7)).toHaveLength(1);
    expect(withoutWriteReceipt(w.side.comments.get(7)?.[0]?.body)).toBe(
      `current review\n\n${MARK}\n\n${intentMarker(newer)}`,
    );
    expect(writes(w)).toEqual(["createComment", "updateComment"]);
  });

  it("[FD-AGT-053] a comment payload with an empty marker is refused", async () => {
    const w = world();
    w.side.comments.set(7, [{ id: 1, body: "a human comment", user: { login: "dev" } }]);
    expect(
      await apply(w, row("comment", { issue_number: 7, body: "review", marker: "" })),
    ).toMatchObject({ _tag: "refused" });
    expect(writes(w)).toEqual([]);
  });
});

describe("labels", () => {
  it("adds and removes labels with set semantics", async () => {
    const w = world();
    await apply(
      w,
      row("label", { issue_number: 2, add: ["a", "b"] }, { effectClass: "replay-safe" }),
    );
    await apply(
      w,
      row("label", { issue_number: 2, add: ["a"], remove: ["b"] }, { effectClass: "replay-safe" }),
    );
    expect([...w.side.labels.get(2)!]).toEqual(["a"]);
  });
});

const proposal = (overrides: Record<string, unknown> = {}) => ({
  branch: "flare-dispatch/fix",
  base: "main",
  title: "Fix",
  body: "Body",
  message: "fix: thing",
  entries: [{ path: "img.png", mode: "100644", digest: "d1", size: 4 }],
  ...overrides,
});

describe("pr.propose", () => {
  it("[FD-GH-080] the staged-write gate runs before any GitHub call; a rejection names the first kind and every reason", async () => {
    const w = world();
    w.gate = {
      _tag: "rejected",
      reasons: [
        { kind: "path-invalid", path: "../x" },
        { kind: "too-large", detail: "6 MiB" },
      ],
    };
    const answer = await apply(w, row("pr.propose", proposal(), { intentKey: "cp:pr:propose" }));
    expect(answer).toEqual({
      _tag: "refused",
      reason: "writeback: path-invalid; path-invalid ../x; too-large 6 MiB",
    });
    expect(w.side.calls).toEqual([]);
  });

  it("[FD-GH-081] [FD-GH-083] each blob is the file's raw bytes in base64, and a new pull request is a draft", async () => {
    const w = world();
    const bytes = new Uint8Array([0x89, 0x50, 0x00, 0xff]);
    w.blobs.set("d1", bytes);
    const answer = await apply(w, row("pr.propose", proposal()));
    expect(answer).toEqual({ _tag: "applied", externalRef: "1" });
    expect([...w.side.blobs.values()]).toEqual([Buffer.from(bytes).toString("base64")]);
    expect(w.side.pulls[0]).toMatchObject({
      draft: true,
      head: { ref: "flare-dispatch/fix" },
      base: { ref: "main" },
    });
    const head = w.side.branches.get("flare-dispatch/fix")!.sha;
    expect(w.side.commits.get(head)).toMatchObject({ message: "fix: thing", parents: ["base0"] });
  });

  it("[FD-GH-083] a repeat reuses the open pull request; draft false opens a ready one", async () => {
    const w = world();
    w.blobs.set("d1", new Uint8Array([1]));
    await apply(w, row("pr.propose", proposal()));
    await apply(w, row("pr.propose", proposal()));
    expect(w.side.pulls).toHaveLength(1);
    await apply(w, row("pr.propose", proposal({ branch: "flare-dispatch/ready", draft: false })));
    expect(w.side.pulls[1]!.draft).toBe(false);
    expect(await lookup(w, row("pr.propose", proposal()))).toEqual({
      _tag: "found",
      externalRef: "1",
    });
    expect(await lookup(w, row("pr.propose", proposal({ branch: "flare-dispatch/none" })))).toEqual(
      {
        _tag: "absent",
      },
    );
  });

  it("[FD-GH-082] a branch outside flare-dispatch/ or a protected one is never written", async () => {
    const w = world();
    w.blobs.set("d1", new Uint8Array([1]));
    expect(await apply(w, row("pr.propose", proposal({ branch: "main" })))).toEqual({
      _tag: "refused",
      reason: "writeback: branch-invalid",
    });
    w.side.branches.set("flare-dispatch/locked", { sha: "base0", protected: true });
    expect(
      await apply(w, row("pr.propose", proposal({ branch: "flare-dispatch/locked" }))),
    ).toEqual({
      _tag: "refused",
      reason: "writeback: branch-protected",
    });
    expect(writes(w)).toEqual([]);
  });

  it("[FD-GH-084] a target branch holding a human's commit is refused and left unchanged", async () => {
    const w = world();
    w.blobs.set("d1", new Uint8Array([1]));
    commitOn(w.side, "flare-dispatch/fix", { login: BOT.login, email: BOT.email });
    const human = commitOn(w.side, "flare-dispatch/fix", {
      login: "alice",
      email: "alice@example.com",
    });
    expect(await apply(w, row("pr.propose", proposal()))).toEqual({
      _tag: "refused",
      reason: "writeback: human-commits-present",
    });
    expect(w.side.branches.get("flare-dispatch/fix")!.sha).toBe(human);
    expect(writes(w)).toEqual([]);
  });

  it("[FD-GH-080] a deployment with no staged-write gate refuses pr.propose", async () => {
    const w = world();
    const answer = await Effect.runPromise(
      actuatorFor(row("pr.propose", proposal())).pipe(
        Effect.flatMap((a) => a.apply(row("pr.propose", proposal()))),
        Effect.provide(GithubApplierLive),
        Effect.provide(layers(w, { [REPO]: 7 }, false)),
      ),
    );
    expect(answer).toEqual({
      _tag: "refused",
      reason: "applier: pr.propose is not configured on this deployment",
    });
    expect(w.side.calls).toEqual([]);
  });
});

describe("pr.close", () => {
  const open = (w: World, branch: string) => {
    w.side.pulls.push({
      id: 1,
      number: 1,
      state: "open",
      head: { ref: branch, sha: "" },
      base: { ref: "main" },
    });
  };

  it("[FD-GH-087] closes a flare-dispatch/ pull request whose commits are all the App's", async () => {
    const w = world();
    commitOn(w.side, "flare-dispatch/fix", { login: BOT.login, email: BOT.email });
    open(w, "flare-dispatch/fix");
    expect(
      await apply(w, row("pr.close", { pull_number: 1 }, { effectClass: "replay-safe" })),
    ).toEqual({
      _tag: "applied",
      externalRef: "1",
    });
    expect(w.side.pulls[0]!.state).toBe("closed");
  });

  it.each([
    ["a branch outside flare-dispatch/", "feature/x", null],
    [
      "a human's commit on the branch",
      "flare-dispatch/fix",
      { login: "alice", email: "alice@example.com" },
    ],
  ])("FD-GH-087 %s is refused writeback: human-commits-present", async (_, branch, human) => {
    const w = world();
    commitOn(w.side, branch, { login: BOT.login, email: BOT.email });
    if (human !== null) commitOn(w.side, branch, human);
    open(w, branch);
    expect(await apply(w, row("pr.close", { pull_number: 1 }))).toEqual({
      _tag: "refused",
      reason: "writeback: human-commits-present",
    });
    expect(w.side.pulls[0]!.state).toBe("open");
  });
});

describe("releases", () => {
  const draft = { tag: "v1.2.0", target: "main", name: "v1.2.0", body: "notes" };

  it("[FD-GH-085] a draft is created only when no release exists for the tag, with its assets", async () => {
    const w = world();
    w.blobs.set("a1", new Uint8Array([1, 2]));
    const r = row("release.draft", {
      ...draft,
      assets: [{ name: "fd.tgz", digest: "a1", content_type: "application/gzip" }],
    });
    await apply(w, r);
    await apply(w, r);
    expect(w.side.releases).toEqual([
      { id: expect.any(Number), tag_name: "v1.2.0", draft: true, assets: [{ name: "fd.tgz" }] },
    ]);
    expect(await lookup(w, r)).toMatchObject({ _tag: "found" });
  });

  it("[FD-GH-085] a published release for the tag is refused and not modified", async () => {
    const w = world();
    w.side.releases.push({ id: 1, tag_name: "v1.2.0", draft: false, assets: [] });
    expect(await apply(w, row("release.draft", draft))).toEqual({
      _tag: "refused",
      reason: "release: v1.2.0 is already published",
    });
    expect(writes(w)).toEqual([]);
  });

  it("[FD-GH-086] publishes only the tag's draft, and leaves a published release unchanged", async () => {
    const w = world();
    expect(await apply(w, row("release.publish", { tag: "v1.2.0" }))).toEqual({
      _tag: "refused",
      reason: "release: no draft release for v1.2.0",
    });
    w.side.releases.push({ id: 1, tag_name: "v1.2.0", draft: true, assets: [] });
    expect(await lookup(w, row("release.publish", { tag: "v1.2.0" }))).toEqual({ _tag: "absent" });
    await apply(w, row("release.publish", { tag: "v1.2.0" }));
    await apply(w, row("release.publish", { tag: "v1.2.0" }));
    expect(w.side.releases[0]!.draft).toBe(false);
    expect(w.side.calls.filter((c) => c === "publishRelease")).toHaveLength(1);
    expect(await lookup(w, row("release.publish", { tag: "v1.2.0" }))).toEqual({
      _tag: "found",
      externalRef: "1",
    });
  });
});

describe("the release provenance gate", () => {
  const ARTIFACT = { name: "fd.tgz", digest: `sha256:${"a".repeat(64)}` };
  const drafted = (w: World) =>
    void w.side.releases.push({ id: 1, tag_name: "v1.2.0", draft: true, assets: [{ name: "fd.tgz" }] });
  const publish = (artifacts: unknown[] = [ARTIFACT]) => row("release.publish", { tag: "v1.2.0", artifacts });
  const published = (w: World) => w.side.calls.filter((c) => c === "publishRelease").length;

  it("asks the gate about the draft's assets and the intent's artifacts, each attributed to its execution, before it publishes", async () => {
    const w = world();
    drafted(w);
    expect(
      await apply(w, publish([ARTIFACT, { name: "fd.cdx.json", digest: ARTIFACT.digest, execution_id: "exec-sbom" }])),
    ).toEqual({ _tag: "applied", externalRef: "1" });
    expect(w.releaseGated).toEqual([
      {
        assets: ["fd.tgz"],
        artifacts: [
          { ...ARTIFACT, executionId: "exec-1" },
          { name: "fd.cdx.json", digest: ARTIFACT.digest, executionId: "exec-sbom" },
        ],
      },
    ]);
    expect(published(w)).toBe(1);
  });

  it("ends the row refused with the gate's provenance reason and leaves the release a draft", async () => {
    for (const reason of ["provenance: release statement missing", "provenance: release built warm"]) {
      const w = world();
      drafted(w);
      w.releaseGate = { _tag: "refused", reason, artifact: "fd.tgz" };
      expect(await apply(w, publish())).toEqual({ _tag: "refused", reason });
      expect(published(w)).toBe(0);
      expect(w.side.releases[0]!.draft).toBe(true);
    }
  });

  it("retries while the gate cannot read its records, and publishes nothing on a deploy without the gate", async () => {
    const w = world();
    drafted(w);
    w.releaseGate = { _tag: "unavailable", reason: "statements: D1 unavailable" };
    expect(await apply(w, publish())).toEqual({ _tag: "retryable", reason: "statements: D1 unavailable" });
    const bare = world();
    drafted(bare);
    bare.releaseGate = undefined;
    expect(await apply(bare, publish([]))).toEqual({
      _tag: "refused",
      reason: "applier: release.publish is not configured on this deployment",
    });
    expect(published(w) + published(bare)).toBe(0);
  });

  it("publishes a draft that holds no asset for an intent that names no artifact without asking the gate", async () => {
    const w = world();
    w.releaseGate = undefined;
    w.side.releases.push({ id: 1, tag_name: "v1.2.0", draft: true, assets: [] });
    expect(await apply(w, row("release.publish", { tag: "v1.2.0" }))).toEqual({ _tag: "applied", externalRef: "1" });
    expect(published(w)).toBe(1);
  });
});

describe("notifications and follow-ons", () => {
  it("[FD-GH-079] a Slack verdict POST carries a timestamp and an HMAC-SHA256 over the timestamp and the body", async () => {
    const w = world();
    await apply(w, row("notify.slack", { text: "check failed" }, { effectClass: "replay-safe" }));
    const [post] = w.slackPosts;
    const ts = post!.headers.get("x-flare-dispatch-timestamp")!;
    const expected = `v1=${createHmac("sha256", "slack-secret").update(`${ts}.${post!.body}`).digest("hex")}`;
    expect(post!.headers.get("x-flare-dispatch-signature")).toBe(expected);
    expect(post!.headers.get("x-flare-dispatch-delivery")).toBe("exec-1/run:step:0");
  });

  it("[FD-GH-078] email and notices go out only through the applier, with ids derived from the key", async () => {
    const w = world();
    await apply(
      w,
      row(
        "notify.email",
        { to: ["a@example.com"], subject: "s", text: "t" },
        { intentKey: "cp:notify:email" },
      ),
    );
    await apply(
      w,
      row("notice.publish", {
        run: "nightly",
        use_case: "digest",
        dedupe_key: "2026-11-04",
        title: "t",
        body: "b",
      }),
    );
    expect(w.emails).toEqual([
      {
        messageId: "<exec-1.cp.notify.email@flare-dispatch>",
        to: ["a@example.com"],
        subject: "s",
        text: "t",
      },
    ]);
    expect(w.notices).toEqual([{ deliveryId: "nightly:digest:2026-11-04", title: "t", body: "b" }]);
  });

  it("[FD-GH-088] a follow-on submits one admission request keyed by the row's execution and intent key", async () => {
    const w = world();
    const answer = await apply(
      w,
      row("dispatch.followOn", { run: "review", inputs: { a: 1 } }, { effectClass: "replay-safe" }),
    );
    expect(answer).toEqual({ _tag: "applied", externalRef: "child-of-exec-1" });
    expect(w.followOns).toEqual([
      {
        executionId: "exec-1",
        intentKey: "run:step:0",
        run: "review",
        label: null,
        inputs: { a: 1 },
      },
    ]);
    expect(w.side.calls).toEqual([]);
  });
});

describe("job and verdict records", () => {
  const jobRecord = {
    schema: JOB_RECORD_SCHEMA,
    execution_id: "exec-1",
    epoch: 2,
    run: "ci",
    repository: REPO,
    commit_sha: "a".repeat(40),
    class: "required",
    executor_kind: "cloudflare",
  };
  const verdictRecord = {
    schema: VERDICT_RECORD_SCHEMA,
    execution_id: "exec-1",
    epoch: 2,
    run: "ci",
    repository: REPO,
    commit_sha: "a".repeat(40),
    ref: "refs/heads/main",
    class: "required",
    trigger: "webhook",
    verdict: "failure",
    reason: "tests failed",
    conclusion: "failure",
    check_name: "flare-dispatch/ci",
  };
  const jobRow = row("job.record", jobRecord, {
    intentKey: "cp:job:record:2",
    effectClass: "replay-safe",
  });
  const verdictRow = row("verdict.record", verdictRecord, {
    executionId: null,
    intentKey: "ops:verdict-record:exec-1",
    effectClass: "replay-safe",
  });
  const hmac = (timestamp: string, body: string) =>
    `v1=${createHmac("sha256", RECORDS_SECRET).update(`${timestamp}.${body}`).digest("hex")}`;

  it("[FD-GH-098] each job and verdict record POST to records.url carries a timestamp, the delivery id and an HMAC-SHA256 over the timestamp, a dot and the body", async () => {
    const w = world();
    expect(await apply(w, jobRow)).toEqual({
      _tag: "applied",
      externalRef: "exec-1/cp:job:record:2",
    });
    expect(await apply(w, verdictRow)).toEqual({
      _tag: "applied",
      externalRef: "ops/ops:verdict-record:exec-1",
    });
    expect(w.recordPosts.map((p) => JSON.parse(p.body))).toEqual([jobRecord, verdictRecord]);
    for (const [post, delivery] of [
      [w.recordPosts[0]!, "exec-1/cp:job:record:2"],
      [w.recordPosts[1]!, "ops/ops:verdict-record:exec-1"],
    ] as const) {
      expect(post.url).toBe(RECORDS_URL);
      expect(post.redirect).toBe("manual");
      const timestamp = post.headers.get("x-flare-dispatch-timestamp")!;
      expect(timestamp).toMatch(/^\d+$/);
      expect(post.headers.get("x-flare-dispatch-signature")).toBe(hmac(timestamp, post.body));
      expect(post.headers.get("x-flare-dispatch-delivery")).toBe(delivery);
    }
    // A signature under another key, or over the body alone, does not match.
    const first = w.recordPosts[0]!;
    const ts = first.headers.get("x-flare-dispatch-timestamp")!;
    expect(first.headers.get("x-flare-dispatch-signature")).not.toBe(
      `v1=${createHmac("sha256", RECORDS_SECRET).update(first.body).digest("hex")}`,
    );
    expect(first.headers.get("x-flare-dispatch-signature")).not.toBe(
      `v1=${createHmac("sha256", "slack-secret").update(`${ts}.${first.body}`).digest("hex")}`,
    );
    expect(w.slackPosts).toEqual([]);
  });

  it("[FD-GH-098] a deploy with no records endpoint refuses each record row and sends nothing", async () => {
    const w = world();
    w.records = false;
    expect(await apply(w, verdictRow)).toEqual({
      _tag: "refused",
      reason: "verdict.record: no records endpoint is configured",
    });
    expect(w.recordPosts).toEqual([]);
  });

  it("[FD-GH-098] a 2xx applies a record, a 429 or 5xx retries it, another status refuses it, and a lost answer is unknown", async () => {
    const w = world();
    w.recordAnswers.push(503, 429, 400, "lost");
    expect(await apply(w, verdictRow)).toEqual({
      _tag: "retryable",
      reason: "verdict.record: records 503",
    });
    expect(await apply(w, verdictRow)).toEqual({
      _tag: "retryable",
      reason: "verdict.record: records 429",
    });
    expect(await apply(w, verdictRow)).toEqual({
      _tag: "refused",
      reason: "verdict.record: records 400",
    });
    expect(await apply(w, verdictRow)).toMatchObject({ _tag: "unknown" });
    // No receiver status reads as an installation's: a records 401 raises no installation alarm.
    w.recordAnswers.push(401);
    expect(await apply(w, verdictRow)).toMatchObject({ _tag: "refused" });
    expect(w.alarms).toEqual([]);
  });

  it("[FD-GH-100] a repeated delivery of a record sends the first attempt's delivery id", async () => {
    const w = world();
    w.recordAnswers.push("lost", 503);
    expect(await apply(w, verdictRow)).toMatchObject({ _tag: "unknown" });
    expect(await apply(w, { ...verdictRow, attempts: 1 })).toMatchObject({ _tag: "retryable" });
    expect(await apply(w, { ...verdictRow, attempts: 2 })).toEqual({
      _tag: "applied",
      externalRef: "ops/ops:verdict-record:exec-1",
    });
    expect(w.recordPosts.map((p) => p.headers.get("x-flare-dispatch-delivery"))).toEqual([
      "ops/ops:verdict-record:exec-1",
      "ops/ops:verdict-record:exec-1",
      "ops/ops:verdict-record:exec-1",
    ]);
    // The id is the row's own: another execution's record carries another id.
    await apply(w, { ...verdictRow, intentKey: "ops:verdict-record:exec-2" });
    expect(w.recordPosts.at(-1)!.headers.get("x-flare-dispatch-delivery")).toBe(
      "ops/ops:verdict-record:exec-2",
    );
    expect(recordDeliveryId(jobRow)).toBe("exec-1/cp:job:record:2");
  });

  it("[FD-GH-101] a record row's permit, apply and release take nothing from InstallationQuota and call no GitHub API", async () => {
    const w = world();
    const quotaCalls: string[] = [];
    const spy = Layer.succeed(InstallationQuota, {
      observe: (key) => Effect.sync(() => void quotaCalls.push(`observe ${key}`)),
      acquire: (r) =>
        Effect.sync(() => {
          quotaCalls.push(`acquire ${r.limitKey}`);
          return { _tag: "granted" as const, permitId: `${r.limitKey}:1` };
        }),
      release: (id) => Effect.sync(() => void quotaCalls.push(`release ${id}`)),
      remainingShare: (key) => Effect.sync(() => (quotaCalls.push(`share ${key}`), 1)),
    });
    const directoryReads: string[] = [];
    const directory = Layer.succeed(InstallationDirectory, {
      installationFor: (scope) => Effect.sync(() => (directoryReads.push(scope), 7)),
    });
    // The key the profile's `delivery.limit_key` binding gives both record kinds (FD-PROF-068).
    expect(RECORD_KINDS.map((k) => deliveryLimitKey(k, "7"))).toEqual([
      RECORDS_LIMIT_KEY,
      RECORDS_LIMIT_KEY,
    ]);
    const request = (kind: string) => ({
      limitKey: RECORDS_LIMIT_KEY,
      call: "apply" as const,
      kind,
      tier: "effect",
      priority: 2,
      drawsReserve: false,
      classRank: 1,
      insertedAt: 0,
    });
    const answers = await Effect.runPromise(
      Effect.gen(function* () {
        const limit = yield* ActuatorRateLimit;
        const out = [];
        for (const r of [jobRow, verdictRow]) {
          const permit = yield* limit.acquire(request(r.kind));
          const actuator = yield* actuatorFor(r);
          out.push({ permit: permit._tag, answer: (yield* actuator.apply(r))._tag });
          if (permit._tag === "granted") yield* limit.release(permit.permitId);
        }
        return out;
      }).pipe(
        Effect.provide(Layer.merge(GithubApplierLive, ActuatorRateLimitLive)),
        Effect.provide(Layer.mergeAll(layers(w), spy, directory)),
      ),
    );
    expect(answers).toEqual([
      { permit: "granted", answer: "applied" },
      { permit: "granted", answer: "applied" },
    ]);
    expect(quotaCalls).toEqual([]);
    expect(directoryReads).toEqual([]);
    expect(w.side.calls).toEqual([]);
    expect(w.recordPosts).toHaveLength(2);
    // An installation's key still draws its permit from the quota.
    await Effect.runPromise(
      ActuatorRateLimit.use((l) => l.acquire({ ...request("comment"), limitKey: "7" })).pipe(
        Effect.provide(ActuatorRateLimitLive),
        Effect.provide(Layer.merge(spy, directory)),
      ),
    );
    expect(quotaCalls).toEqual(["acquire 7"]);
  });
});

describe("ops kinds", () => {
  it("[FD-GH-089] a redelivery uses the App JWT, not an installation token, and lookup reads the delivery's attempts", async () => {
    const w = world();
    const r = row(
      "delivery.redeliver",
      { delivery_id: 10 },
      { executionId: null, intentKey: "ops:redeliver:10" },
    );
    expect(await lookup(w, r)).toEqual({ _tag: "absent" });
    expect(await apply(w, r, {})).toMatchObject({ _tag: "applied" });
    expect(w.appCalls).toContain("POST /app/hook/deliveries/10/attempts");
    expect(w.side.calls).toEqual([]);
    expect(await lookup(w, r)).toEqual({ _tag: "found", externalRef: "11" });
    expect(await apply(w, r)).toEqual({ _tag: "applied", externalRef: "11" });
    expect(w.appCalls.filter((c) => c.startsWith("POST"))).toHaveLength(1);
  });

  it("[FD-GH-089] [FD-GH-092] a canary push is an empty commit under the installation token, found by its tick time", async () => {
    const w = world();
    w.side.branches.set("canary", { sha: "base0", protected: false });
    const r = row(
      "canary.push",
      { branch: "canary", tick_time: "2026-11-04T12:00Z" },
      { executionId: null, intentKey: "ops:canary:2026-11-04T12:00Z" },
    );
    expect(await lookup(w, r)).toEqual({ _tag: "absent" });
    await apply(w, r);
    await apply(w, r);
    const tip = w.side.commits.get(w.side.branches.get("canary")!.sha)!;
    expect(tip).toMatchObject({
      message: "flare-dispatch canary 2026-11-04T12:00Z",
      tree: "tree0",
      parents: ["base0"],
    });
    expect(await lookup(w, r)).toEqual({ _tag: "found", externalRef: tip.sha });
  });
});

describe("answers", () => {
  it("[FD-GH-004] a GitHub kind with no installation is refused and pages installation-lost", async () => {
    const w = world();
    expect(await apply(w, row("comment", { issue_number: 1, body: "x" }), {})).toEqual({
      _tag: "refused",
      reason: "installation: not found",
    });
    expect(w.alarms.map((a) => a.name)).toEqual(["installation-lost"]);
  });

  it("[FD-GH-047] [FD-GH-048] a 401 retries once after a new token, and a second 401 is refused and pages", async () => {
    const w = world();
    const unauthorized = () =>
      new GithubHttpError({ status: 401, message: "Bad credentials", rateLimited: false });
    w.side.failures.push(unauthorized());
    expect(await apply(w, row("comment", { issue_number: 1, body: "x" }))).toMatchObject({
      _tag: "applied",
    });
    expect(w.side.tokenRefreshes).toBe(1);
    w.side.failures.push(unauthorized(), null, unauthorized());
    expect(await apply(w, row("comment", { issue_number: 2, body: "x" }))).toEqual({
      _tag: "refused",
      reason: "installation: unauthorized",
    });
    expect(w.alarms.map((a) => a.name)).toEqual(["installation-lost"]);
  });

  it("[FD-GH-091] a kind no applier serves, or a payload its schema rejects, is refused without a GitHub call", async () => {
    const w = world();
    expect(await apply(w, row("git.notes", {}))).toEqual({
      _tag: "refused",
      reason: "applier: git.notes is not a side-output kind",
    });
    expect(await apply(w, row("comment", { body: 1 }))).toMatchObject({ _tag: "refused" });
    expect(w.side.calls).toEqual([]);
  });
});

/** Every non-test `.ts` file under `dir`. */
const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === "node_modules") return [];
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith(".ts") &&
      !/\.test(-support)?\.ts$/.test(name) &&
      !name.includes("test-support")
      ? [path]
      : [];
  });

describe("write authority", () => {
  const root = join(import.meta.dirname, "../..");
  const files = [...sources(join(root, "github/src")), ...sources(join(root, "intake/src"))];
  const rel = (f: string) => relative(root, f);
  // The control plane's own sources, plus every workspace package it depends on at runtime.
  const controlPlane = join(root, "../apps/control-plane");
  const { dependencies } = JSON.parse(readFileSync(join(controlPlane, "package.json"), "utf8")) as {
    dependencies: Record<string, string>;
  };
  const prefix = "@fractalboxdev/flare-dispatch-";
  const controlPlaneFiles = [
    ...sources(join(controlPlane, "src")),
    ...Object.keys(dependencies)
      .filter((name) => name.startsWith(prefix))
      .flatMap((name) => sources(join(root, name.slice(prefix.length), "src"))),
  ];

  it("[FD-GH-001] only the appliers call a GitHub write for an execution", () => {
    const writeCall =
      /\.(createCheckRun|updateCheckRun|createComment|createReview|createIssue|updateIssue|closeIssue|addLabels|removeLabel|createBlob|createTree|createCommit|setBranch|createPull|closePull|createDraftRelease|publishRelease|uploadAsset)\(/;
    expect(controlPlaneFiles.map(rel)).toContain("../apps/control-plane/src/tick.ts");
    const callers = controlPlaneFiles
      .filter((f) => writeCall.test(readFileSync(f, "utf8")))
      .map(rel);
    // `intake/src/ports.ts` posts the `flare-dispatch/manifest` check run, which belongs to no execution.
    expect(callers.sort()).toEqual([
      "agentic/src/writeback/applier.ts",
      "github/src/applier.ts",
      "github/src/side-applier.ts",
      "intake/src/ports.ts",
    ]);
  });

  it("[FD-GH-078] email, Slack posts and notices are sent only from the side-output applier", () => {
    const send = /\.send\(\{|\.publish\(\{|x-flare-dispatch-signature/;
    expect(files.filter((f) => send.test(readFileSync(f, "utf8"))).map(rel)).toEqual([
      "github/src/side-applier.ts",
    ]);
  });
});
