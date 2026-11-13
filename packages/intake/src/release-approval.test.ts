// Release approval end to end: signed `pull_request` events on a release pull request through the webhook route, the
// fake GitHub reads and mameko's real admission on SQLite.
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { ReleaseNotesInput } from "@fractalboxdev/flare-dispatch-agentic";
import { catalogRuns } from "./catalog.ts";
import {
  bodyOf,
  CATALOG,
  harness,
  HEAD,
  REPO,
  repoWithManifest,
  signedWebhook,
  type Harness,
  type HarnessOptions,
} from "./harness.test-support.ts";
import { RELEASE_APPROVAL_WINDOW_MS, releaseSignalOf } from "./release-approval.ts";
import { handleIntake } from "./routes.ts";
import { WebhookFields } from "./event.ts";

const BOT = "flare-dispatch[bot]";
/** The head of the commit range the release pull request's marker names. */
const RANGE_HEAD = "e".repeat(40);
/** The commit a merge of the release pull request wrote to `main`. */
const MERGE = "f".repeat(40);
/** 24 h before the harness clock's `NOW`, 2026-11-04T12:00:00Z. */
const CREATED = "2026-11-03T12:00:00.000Z";
const iso = (ms: number) => new Date(ms).toISOString();
const createdMs = Date.parse(CREATED);

const marker = (version = "v1.4.0") =>
  `<!-- flare-dispatch:release-notes execution=01HPROPOSE0000000000000000 version=${version} head=${RANGE_HEAD} -->`;

interface ReleaseEvent {
  readonly action: "closed" | "labeled";
  readonly merged?: boolean;
  /** When the merge or label happened. */
  readonly at?: string;
  readonly label?: string;
  readonly sender?: string;
  readonly state?: "open" | "closed";
  readonly author?: { readonly login: string; readonly type: string };
  readonly body?: string | null;
  readonly number?: number;
}

const releaseEvent = (e: ReleaseEvent) => {
  const at = e.at ?? "2026-11-04T11:00:00.000Z";
  const closed = e.action === "closed";
  return {
    action: e.action,
    repository: { full_name: REPO },
    installation: { id: 7 },
    sender: { login: e.sender ?? "maintainer", type: "User" },
    ...(e.label === undefined ? {} : { label: { name: e.label } }),
    pull_request: {
      number: e.number ?? 40,
      user: e.author ?? { login: BOT, type: "Bot" },
      body: e.body === undefined ? `Release \`v1.4.0\`.\n\n# v1.4.0\n\n${marker()}` : e.body,
      state: e.state ?? (closed ? "closed" : "open"),
      created_at: CREATED,
      updated_at: at,
      closed_at: closed ? at : null,
      merged: e.merged === true,
      merged_at: e.merged === true ? at : null,
      merge_commit_sha: e.merged === true ? MERGE : null,
      head: { sha: HEAD, ref: "flare-dispatch/release", repo: { full_name: REPO } },
      base: { ref: "main", repo: { full_name: REPO } },
    },
  };
};

const releaseHarness = (options: HarnessOptions = {}) => {
  const development = catalogRuns("development");
  return harness({
    repos: {
      [REPO]: repoWithManifest(undefined, {
        permissions: { maintainer: "write", owner: "admin", triager: "read" },
      }),
    },
    ...options,
    settings: {
      catalog: (name) => (name === "release-notes" ? development(name) : CATALOG[name]),
      appLogin: BOT,
      ...options.settings,
    },
  });
};

let deliveries = 0;
const deliver = async (h: Harness, payload: unknown, delivery = `d-${++deliveries}`) =>
  h.run(
    handleIntake(await signedWebhook("pull_request", payload, { delivery }), "webhooks/github"),
  );

/** The publish executions intake recorded, with their commit and inputs. */
const publishes = (h: Harness) =>
  h
    .records()
    .filter((r) => r["run"] === "release-notes")
    .map((r) => ({
      sha: r["sha"],
      inputs: JSON.parse(String(r["inputs_json"])) as typeof ReleaseNotesInput.Type,
    }));

const publishInputs = (commit: string) => ({
  repo: { owner: "acme", name: "app" },
  baseBranch: "main",
  publish: { version: "v1.4.0", commit, notesCommit: HEAD, pullRequest: 40 },
});

describe("release approval: approve", () => {
  it("[FD-AGT-085] [FD-INT-066] a merge within the window starts one release-notes publish execution for the marker's version at the merge commit", async () => {
    const h = await releaseHarness();
    const r = await deliver(h, releaseEvent({ action: "closed", merged: true }));
    expect(r!.status).toBe(202);
    const body = await bodyOf(r);
    expect(publishes(h)).toEqual([{ sha: MERGE, inputs: publishInputs(MERGE) }]);
    expect(body["executions"]).toEqual([
      h.records().find((x) => x["run"] === "release-notes")!["execution_id"],
    ]);
    // The recorded inputs are the run's own input, which the publish execution decodes.
    expect(Schema.decodeUnknownSync(ReleaseNotesInput)(publishes(h)[0]!.inputs).publish).toEqual(
      publishInputs(MERGE).publish,
    );
    expect(h.executions().filter((e) => e["run"] === "release-notes")).toHaveLength(1);
  });

  it("[FD-AGT-085] [FD-INT-066] release:approve from a principal with write permission starts one publish execution at the marker's head", async () => {
    for (const sender of ["maintainer", "owner"]) {
      const h = await releaseHarness();
      await deliver(h, releaseEvent({ action: "labeled", label: "release:approve", sender }));
      expect(publishes(h)).toEqual([{ sha: RANGE_HEAD, inputs: publishInputs(RANGE_HEAD) }]);
      expect(h.reads.calls).toContain(`permission ${REPO}`);
    }
  });

  it("[FD-AGT-085] release:approve from a principal without write permission starts none", async () => {
    for (const sender of ["triager", "stranger"]) {
      const h = await releaseHarness();
      await deliver(h, releaseEvent({ action: "labeled", label: "release:approve", sender }));
      expect(publishes(h)).toEqual([]);
    }
  });

  it("[FD-INT-066] redeliveries, a label and then a merge reach the one publish execution of the pull request", async () => {
    const h = await releaseHarness();
    const label = releaseEvent({ action: "labeled", label: "release:approve" });
    const first = await bodyOf(await deliver(h, label, "d-label"));
    const again = await bodyOf(await deliver(h, label, "d-label"));
    const merged = await bodyOf(await deliver(h, releaseEvent({ action: "closed", merged: true })));
    expect(h.executions().filter((e) => e["run"] === "release-notes")).toHaveLength(1);
    expect(publishes(h)).toHaveLength(1);
    const id = (first["executions"] as string[]).find((x) =>
      h.records().some((r) => r["execution_id"] === x && r["run"] === "release-notes"),
    );
    expect(id).toBeDefined();
    expect(again["executions"]).toContain(id);
    expect(merged["executions"]).toEqual([id]);
  });

  it("[FD-INT-066] two release pull requests each start their own publish execution", async () => {
    const h = await releaseHarness();
    await deliver(h, releaseEvent({ action: "closed", merged: true, number: 40 }));
    await deliver(h, releaseEvent({ action: "closed", merged: true, number: 41 }));
    expect(publishes(h).map((p) => p.inputs.publish?.pullRequest)).toEqual([40, 41]);
  });
});

describe("release approval: reject", () => {
  it("[FD-AGT-086] closing the release pull request unmerged starts none, and no later merge or label publishes it", async () => {
    const h = await releaseHarness();
    const closed = await deliver(h, releaseEvent({ action: "closed" }));
    expect(closed!.status).toBe(202);
    expect(publishes(h)).toEqual([]);
    await deliver(h, releaseEvent({ action: "labeled", label: "release:approve", state: "open" }));
    await deliver(h, releaseEvent({ action: "closed", merged: true }));
    expect(publishes(h)).toEqual([]);
    expect(h.executions().filter((e) => e["run"] === "release-notes")).toEqual([]);
  });

  it("[FD-AGT-086] release:reject from a principal with write permission starts none, and no later approval publishes", async () => {
    const h = await releaseHarness();
    await deliver(h, releaseEvent({ action: "labeled", label: "release:reject" }));
    await deliver(h, releaseEvent({ action: "labeled", label: "release:approve" }));
    await deliver(h, releaseEvent({ action: "closed", merged: true }));
    expect(publishes(h)).toEqual([]);
  });

  it("[FD-AGT-086] a reject or close from a principal without write permission does not stop a writer's approval", async () => {
    const h = await releaseHarness();
    await deliver(
      h,
      releaseEvent({ action: "labeled", label: "release:reject", sender: "triager" }),
    );
    await deliver(h, releaseEvent({ action: "closed", sender: "triager" }));
    await deliver(h, releaseEvent({ action: "closed", merged: true }));
    expect(publishes(h)).toEqual([{ sha: MERGE, inputs: publishInputs(MERGE) }]);
  });

  it("[FD-AGT-086] a label on a closed release pull request starts none", async () => {
    const h = await releaseHarness();
    await deliver(
      h,
      releaseEvent({ action: "labeled", label: "release:approve", state: "closed" }),
    );
    expect(publishes(h)).toEqual([]);
  });
});

describe("release approval: the approval window", () => {
  it("[FD-AGT-087] a merge or release:approve after 72 h from creation starts none", async () => {
    const late = iso(createdMs + RELEASE_APPROVAL_WINDOW_MS + 1000);
    const merged = await releaseHarness();
    await deliver(merged, releaseEvent({ action: "closed", merged: true, at: late }));
    expect(publishes(merged)).toEqual([]);
    const labelled = await releaseHarness();
    await deliver(
      labelled,
      releaseEvent({ action: "labeled", label: "release:approve", at: late }),
    );
    expect(publishes(labelled)).toEqual([]);
  });

  it("[FD-AGT-087] an approval at the window's end still starts the publish, and the window is 72 h", async () => {
    expect(RELEASE_APPROVAL_WINDOW_MS).toBe(72 * 3600 * 1000);
    const h = await releaseHarness();
    await deliver(
      h,
      releaseEvent({
        action: "closed",
        merged: true,
        at: iso(createdMs + RELEASE_APPROVAL_WINDOW_MS),
      }),
    );
    expect(publishes(h)).toHaveLength(1);
  });

  it("[FD-AGT-087] a redelivery after the window of an approval made inside it still reaches the publish execution", async () => {
    const h = await releaseHarness();
    const event = releaseEvent({ action: "closed", merged: true });
    const first = await bodyOf(await deliver(h, event, "d-merge"));
    await h.adjust(RELEASE_APPROVAL_WINDOW_MS * 2);
    const again = await bodyOf(await deliver(h, event, "d-merge"));
    expect(again["executions"]).toEqual(first["executions"]);
    expect(publishes(h)).toHaveLength(1);
  });
});

describe("release approval: other pull requests", () => {
  /** The signal's tag; a null login is a deployment that names no App login. */
  const signal = (payload: unknown, appLogin: string | null = BOT) => {
    const fields = Schema.decodeUnknownSync(WebhookFields)(payload);
    return releaseSignalOf(fields.action ?? null, fields, appLogin ?? undefined)._tag;
  };

  it("[FD-INT-066] a pull request another account authored, or one without the marker, is ignored", async () => {
    const human = { login: "maintainer", type: "User" };
    const otherApp = { login: "other-app[bot]", type: "Bot" };
    const merged = { action: "closed", merged: true } as const;
    expect(signal(releaseEvent({ ...merged, author: human }))).toBe("NotRelease");
    expect(signal(releaseEvent({ ...merged, author: otherApp }))).toBe("NotRelease");
    expect(signal(releaseEvent({ ...merged, body: "Release v1.4.0" }))).toBe("NotRelease");
    expect(signal(releaseEvent({ ...merged, body: null }))).toBe("NotRelease");
    expect(signal(releaseEvent({ ...merged, body: `${marker()}\n\nedited after` }))).toBe(
      "NotRelease",
    );
    expect(signal(releaseEvent(merged), null)).toBe("NotRelease");
    expect(signal({ ...releaseEvent(merged), action: "synchronize" })).toBe("NotRelease");
    expect(signal(releaseEvent({ action: "labeled", label: "bug" }))).toBe("Unrelated");

    const h = await releaseHarness();
    await deliver(h, releaseEvent({ ...merged, author: human }));
    await deliver(h, releaseEvent({ ...merged, author: otherApp, number: 41 }));
    await deliver(h, releaseEvent({ ...merged, body: "Release v1.4.0", number: 42 }));
    await deliver(h, releaseEvent({ action: "labeled", label: "release:reject", author: human }));
    expect(publishes(h)).toEqual([]);
    // A human's `release:reject` on a pull request that is not a release one records nothing.
    expect(h.rows("select * from intake_release_rejections")).toEqual([]);
  });

  it("[FD-INT-066] a deployment that names no App login reads no release approval", async () => {
    const h = await releaseHarness({ settings: { appLogin: undefined } });
    await deliver(h, releaseEvent({ action: "closed", merged: true }));
    expect(publishes(h)).toEqual([]);
  });

  it("[FD-INT-066] a permission read that fails answers 503, so GitHub redelivers the label", async () => {
    const h = await releaseHarness();
    const { GithubHttpError } = await import("@fractalboxdev/flare-dispatch-github");
    h.reads.failures.set(
      `permission ${REPO}`,
      new GithubHttpError({ status: 502, message: "bad gateway", rateLimited: false }),
    );
    const r = await deliver(h, releaseEvent({ action: "labeled", label: "release:approve" }));
    expect(r!.status).toBe(503);
    expect(publishes(h)).toEqual([]);
    h.reads.failures.clear();
    await deliver(h, releaseEvent({ action: "labeled", label: "release:approve" }));
    expect(publishes(h)).toHaveLength(1);
  });
});
