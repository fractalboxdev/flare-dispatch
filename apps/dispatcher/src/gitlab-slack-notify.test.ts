// Unit tests for the GitLab MR-review Slack failure notification.
//
// `buildSlackFailureMessage` is the pure message builder — no network. A
// separate `afterEach`-restored fetch stub covers `postSlackFailureNotification`
// (2xx, non-2xx, and a thrown network error all resolve rather than throw).

import { afterEach, describe, expect, it, vi } from "vitest";
import { buildSlackFailureMessage, postSlackFailureNotification, type SlackFailureNotifyInput } from "./gitlab-slack-notify";

const base: SlackFailureNotifyInput = {
  projectId: "42",
  iid: 7,
  projectWebUrl: "https://gitlab.com/group/proj",
  headSha: "abcdef0123456789",
  noteId: "999",
  status: "failure",
  reason: "review step timed out after 25 minutes each",
  attempts: 2,
  executionId: "mr-review_42_7_abcdef012345",
};

describe("buildSlackFailureMessage", () => {
  it("uses the MR title when present, linked to the note", () => {
    const msg = buildSlackFailureMessage({ ...base, title: "Fix the flaky retry" });
    expect(msg.text).toContain("<https://gitlab.com/group/proj/-/merge_requests/7#note_999|Fix the flaky retry>");
    expect(msg.text).toContain("head `abcdef012345`");
    expect(msg.text).toContain("status `failure`");
    expect(msg.text).toContain("2 attempts");
    expect(msg.text).toContain("reason: review step timed out after 25 minutes each");
  });

  it("falls back to project/iid when no title is given", () => {
    const msg = buildSlackFailureMessage(base);
    expect(msg.text).toContain("|42/7>");
  });

  it("falls back to project/iid when the title is blank", () => {
    const msg = buildSlackFailureMessage({ ...base, title: "   " });
    expect(msg.text).toContain("|42/7>");
  });

  it("links to the MR itself (not a note anchor) when there is no noteId", () => {
    const msg = buildSlackFailureMessage({ ...base, noteId: null, title: "No note" });
    expect(msg.text).toContain("<https://gitlab.com/group/proj/-/merge_requests/7|No note>");
    expect(msg.text).not.toContain("#note_");
  });

  it("singularizes '1 attempt'", () => {
    const msg = buildSlackFailureMessage({ ...base, attempts: 1 });
    expect(msg.text).toContain("1 attempt");
    expect(msg.text).not.toContain("1 attempts");
  });

  it("renders skipped-quota with its own status word", () => {
    const msg = buildSlackFailureMessage({ ...base, status: "skipped-quota", reason: "model quota exhausted (rate-limited)" });
    expect(msg.text).toContain("skipped (quota exhausted)");
    expect(msg.text).toContain("status `skipped-quota`");
  });

  it("renders note-not-posted with its own status word", () => {
    const msg = buildSlackFailureMessage({
      ...base,
      status: "note-not-posted",
      reason: "review completed but the MR note could not be posted (no GITLAB_TOKEN, or GitLab rejected the note — see the Worker logs)",
    });
    expect(msg.text).toContain("finished, but the note was not posted");
    expect(msg.text).toContain("status `note-not-posted`");
    expect(msg.text).toContain("reason: review completed but the MR note could not be posted");
  });

  it("truncates the reason to 200 chars", () => {
    const longReason = "x".repeat(500);
    const msg = buildSlackFailureMessage({ ...base, reason: longReason });
    const reasonLine = msg.text.split("\n").find((l) => l.startsWith("reason: "))!;
    expect(reasonLine.slice("reason: ".length)).toHaveLength(200);
  });

  it("omits the Workflow-instance link when accountId is absent", () => {
    const msg = buildSlackFailureMessage(base);
    expect(msg.text).not.toContain("dash.cloudflare.com");
  });

  it("adds the Workflow-instance link when accountId is set, using the default workflow name", () => {
    const msg = buildSlackFailureMessage({ ...base, accountId: "abc123" });
    expect(msg.text).toContain(
      "<https://dash.cloudflare.com/abc123/workers/workflows/gitlab-review/instance/mr-review_42_7_abcdef012345|Workflow instance>",
    );
  });

  it("uses a custom workflowName when given", () => {
    const msg = buildSlackFailureMessage({ ...base, accountId: "abc123", workflowName: "my-review-wf" });
    expect(msg.text).toContain("/workers/workflows/my-review-wf/instance/");
  });

  it("trims a trailing slash on projectWebUrl before building links", () => {
    const msg = buildSlackFailureMessage({ ...base, projectWebUrl: "https://gitlab.com/group/proj/", title: "T" });
    expect(msg.text).toContain("<https://gitlab.com/group/proj/-/merge_requests/7#note_999|T>");
  });

  it("escapes a title that would otherwise break out of the mrkdwn link and inject one", () => {
    const msg = buildSlackFailureMessage({
      ...base,
      title: "evil</url|inject> & <http://evil.example|click me>",
    });
    // The whole raw title lands inside ONE link's text — no stray `>` closes
    // it early, and no unescaped `<...|...>` starts a second, attacker-chosen
    // link.
    expect(msg.text).toContain(
      "<https://gitlab.com/group/proj/-/merge_requests/7#note_999|evil&lt;/url|inject&gt; &amp; &lt;http://evil.example|click me&gt;>",
    );
    expect(msg.text).not.toContain("<http://evil.example|click me>");
  });

  it("escapes a reason containing mrkdwn special characters", () => {
    const msg = buildSlackFailureMessage({ ...base, reason: "backend said A & B <failed> for real" });
    expect(msg.text).toContain("reason: backend said A &amp; B &lt;failed&gt; for real");
  });

  it("a blank/whitespace-only workflowName falls back to the default rather than a malformed URL", () => {
    const msg = buildSlackFailureMessage({ ...base, accountId: "abc123", workflowName: "   " });
    expect(msg.text).toContain(
      "<https://dash.cloudflare.com/abc123/workers/workflows/gitlab-review/instance/mr-review_42_7_abcdef012345|Workflow instance>",
    );
  });
});

describe("postSlackFailureNotification", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns true on a 2xx response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok", { status: 200 }));
    await expect(postSlackFailureNotification("https://hooks.slack.example/x", { text: "hi" })).resolves.toBe(true);
  });

  it("returns false (never throws) on a non-2xx response", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 500 }));
    await expect(postSlackFailureNotification("https://hooks.slack.example/x", { text: "hi" })).resolves.toBe(false);
    expect(warn).toHaveBeenCalled();
  });

  it("returns false (never throws) when fetch itself rejects", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    await expect(postSlackFailureNotification("https://hooks.slack.example/x", { text: "hi" })).resolves.toBe(false);
    expect(warn).toHaveBeenCalled();
  });

  it("sends an abort signal, so a hung webhook cannot hang the step indefinitely", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok", { status: 200 }));
    await postSlackFailureNotification("https://hooks.slack.example/x", { text: "hi" });
    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("never logs the webhook URL, even when the thrown error's own message echoes it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const webhookUrl = "https://hooks.slack.example/T00/B00/super-secret-token";
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError(`Failed to parse URL from ${webhookUrl}`));
    await expect(postSlackFailureNotification(webhookUrl, { text: "hi" })).resolves.toBe(false);
    expect(warn).toHaveBeenCalled();
    const logged = String(warn.mock.calls[0]![0]);
    expect(logged).not.toContain(webhookUrl);
    expect(logged).not.toContain("super-secret-token");
    expect(logged).toContain("<redacted>");
  });
});
