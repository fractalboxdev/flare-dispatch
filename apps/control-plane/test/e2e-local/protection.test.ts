// The protection snapshot over the deployed Worker with the GitHub App: class resolution reads a branch's required set
// from GitHub's branch rules through the App, keeps it in the isolate's cache across deliveries, and drops a
// repository's cached set on each `repository_ruleset` and `branch_protection_rule` webhook for it
// (specs/profile.md § Class resolution).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GithubState } from "./fixtures/github-server.ts";
import { startStack, WEBHOOK_SECRET, type Stack } from "./stack.ts";

const STATE = JSON.parse(
  readFileSync(join(import.meta.dirname, "fixtures/intake-github.json"), "utf8"),
) as GithubState;

const WIDGETS = "acme/widgets";
const GADGETS = "acme/gadgets";
/** The check `check` with label `ci` owns on a pull request. */
const CHECK = "flare-dispatch/check:ci";
const BASE = STATE.repositories[WIDGETS]!.branches["main"]!;
const RULES_READ = `/repos/${WIDGETS}/rules/branches/main`;

let stack: Stack;

beforeAll(async () => {
  stack = await startStack({ github: STATE });
});

afterAll(async () => {
  await stack?.close();
});

const post = async (delivery: { headers: Record<string, string>; body: string }) => {
  const r = await fetch(`${stack.url}/v1/webhooks/github`, {
    method: "POST",
    headers: delivery.headers,
    body: delivery.body,
  });
  expect(r.status).toBe(202);
  return (await r.json()) as { executions: string[] };
};

let pulls = 10;

/** A pull request opened against `main` of acme/widgets with head `head`; answers the class its check resolved to. */
const pullRequest = async (head: string) => {
  const number = ++pulls;
  const { executions } = await post(
    stack.github.delivery("pull_request", "pull_request.opened.json", WEBHOOK_SECRET, (p) => {
      const pr = p["pull_request"] as Record<string, Record<string, unknown>>;
      return {
        ...p,
        number,
        pull_request: {
          ...pr,
          number,
          head: { ...pr["head"], sha: head },
          base: { ...pr["base"], sha: BASE },
        },
      };
    }),
  );
  expect(executions).toHaveLength(1);
  const db = await stack.mf.getD1Database("DB");
  const row = await db
    .prepare("select class from intake_records where repo = ? and sha = ? and run = 'check'")
    .bind(WIDGETS, head)
    .first<{ class: string }>();
  return row?.class;
};

/** A protection event's recorded delivery, addressed to `repository`. */
const protectionEvent = (event: string, recording: string, repository: string) => {
  const [, name] = repository.split("/") as [string, string];
  return post(
    stack.github.delivery(event, recording, WEBHOOK_SECRET, (p) => ({
      ...p,
      repository: { ...(p["repository"] as object), name, full_name: repository },
    })),
  );
};

const rulesReads = () =>
  stack.github.calls.filter((c) => c.method === "GET" && c.path === RULES_READ).length;

describe("the protection snapshot", () => {
  it("[FD-PROF-014] caches each branch's required set across deliveries, and refreshes it on a repository_ruleset or branch_protection_rule webhook for the repository", async () => {
    // No rule requires the check, so it resolves to `interactive`; the second delivery reads no rules.
    expect(await pullRequest("a".repeat(40))).toBe("interactive");
    expect(rulesReads()).toBe(1);
    expect(await pullRequest("b".repeat(40))).toBe("interactive");
    expect(rulesReads()).toBe(1);

    // A ruleset now requires the check. Until a webhook says so, the cached set stands.
    stack.github.requireChecks(WIDGETS, "main", [CHECK]);
    expect(await pullRequest("c".repeat(40))).toBe("interactive");
    expect(rulesReads()).toBe(1);
    // A ruleset event for another repository leaves this repository's cached set in place.
    expect(
      await protectionEvent("repository_ruleset", "repository_ruleset.edited.json", GADGETS),
    ).toEqual({ executions: [] });
    expect(await pullRequest("d".repeat(40))).toBe("interactive");
    expect(rulesReads()).toBe(1);

    // The ruleset event for this repository drops its set: the next delivery reads the rules and the check is required.
    expect(
      await protectionEvent("repository_ruleset", "repository_ruleset.edited.json", WIDGETS),
    ).toEqual({ executions: [] });
    expect(await pullRequest("e".repeat(40))).toBe("required");
    expect(rulesReads()).toBe(2);
    expect(await pullRequest("f".repeat(40))).toBe("required");
    expect(rulesReads()).toBe(2);

    // The rule goes away; a branch protection event drops the set again.
    stack.github.requireChecks(WIDGETS, "main", []);
    expect(await pullRequest("0".repeat(39) + "1")).toBe("required");
    expect(
      await protectionEvent(
        "branch_protection_rule",
        "branch_protection_rule.edited.json",
        WIDGETS,
      ),
    ).toEqual({ executions: [] });
    expect(await pullRequest("0".repeat(39) + "2")).toBe("interactive");
    expect(rulesReads()).toBe(3);
    expect(stack.github.unrecorded).toEqual([]);
  });
});
