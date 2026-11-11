// The side-output appliers over an in-memory repository: each kind's write, its idempotency marker, its refusals
// and its lookup.
import { createHmac } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { Actuators, AlarmPort, type Alarm, type IntentRow } from "@fractalboxdev/mameko-ports";
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
import { intentMarker, ISSUE_PAGES } from "./side-applier.ts";
import {
  BlobStore,
  EmailSender,
  FollowOnSubmitter,
  NoticeChannel,
  SideOutputConfig,
  StagedWriteGate,
  type GateResult,
} from "./side-ports.ts";
import { GithubClient } from "./client.ts";

const REPO = "acme/app";

interface World {
  readonly side: FakeSide;
  readonly alarms: Alarm[];
  readonly slackPosts: { headers: Headers; body: string }[];
  readonly emails: unknown[];
  readonly notices: unknown[];
  readonly followOns: unknown[];
  readonly appCalls: string[];
  gate: GateResult;
  readonly blobs: Map<string, Uint8Array>;
  /** The App's webhook deliveries, for `delivery.redeliver`. */
  readonly deliveries: { id: number; guid: string; redelivery: boolean }[];
}

const world = (): World => ({
  side: fakeSide(),
  alarms: [],
  slackPosts: [],
  emails: [],
  notices: [],
  followOns: [],
  appCalls: [],
  gate: { _tag: "accepted" },
  blobs: new Map(),
  deliveries: [{ id: 10, guid: "g-1", redelivery: false }],
});

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
      appBot: BOT,
      slack: { url: "https://hooks.example.com/verdicts", secret: "slack-secret" },
      fetch: (async (_: unknown, init?: RequestInit) => {
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

  it("[FD-GH-092] an issue list longer than the search bound is undetermined, never absent", async () => {
    const w = world();
    for (let n = 1; n <= ISSUE_PAGES * 100; n++)
      w.side.issues.push({ id: n, number: n, title: "other", body: "other", labels: [] });
    const r = row("issue", { title: "flake", body: "seen" });
    expect(await lookup(w, r)).toMatchObject({ _tag: "undetermined" });
    expect(await apply(w, r)).toMatchObject({ _tag: "retryable" });
    expect(w.side.calls.filter((c) => c === "createIssue")).toEqual([]);
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
    expect(w.side.comments.get(7)).toEqual([
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
    expect(comments[0]?.body).toBe(`review of exec-2\n\n${MARK}\n\n${intentMarker(newer)}`);
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
      /\.(createCheckRun|updateCheckRun|createComment|createReview|createIssue|updateIssue|addLabels|removeLabel|createBlob|createTree|createCommit|setBranch|createPull|closePull|createDraftRelease|publishRelease|uploadAsset)\(/;
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
