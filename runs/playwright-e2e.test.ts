// Trigger-level unit tests for the `playwright-e2e` Webhook-mode binding.
//
// The run body needs the full sandbox/browser runtime, but the trigger's
// `gate` / `inputs` / `idempotencyKey` are pure functions of the webhook
// payload — so we exercise the load-bearing SAFETY property directly: the
// trigger is OPT-IN and fires ONLY on a non-bot PR carrying `request-e2e`,
// so merely installing the App never blanket-runs e2e on every push.

import { describe, expect, it } from "vitest";
import { playwrightE2E } from "./playwright-e2e";

type Label = { name: string };
const makePayload = (opts: {
  labels?: string[];
  login?: string;
  repo?: string;
  sha?: string;
}) => ({
  repository: { full_name: opts.repo ?? "owner/name" },
  pull_request: {
    head: { sha: opts.sha ?? "abcdef0123456789" },
    labels: (opts.labels ?? []).map((name): Label => ({ name })),
    user: { login: opts.login ?? "octocat" },
  },
});

describe("playwright-e2e webhook trigger", () => {
  const trigger = playwrightE2E.triggers?.[0];

  it("binds the pull_request event", () => {
    expect(trigger?.event).toBe("pull_request");
  });

  it("does NOT fire without the request-e2e label (opt-in)", () => {
    expect(trigger?.gate?.({ payload: makePayload({}) })).toBe(false);
  });

  it("fires for a non-bot PR carrying request-e2e", () => {
    expect(
      trigger?.gate?.({ payload: makePayload({ labels: ["request-e2e"] }) }),
    ).toBe(true);
  });

  it("never fires for a bot author, even when labeled", () => {
    expect(
      trigger?.gate?.({
        payload: makePayload({ labels: ["request-e2e"], login: "renovate[bot]" }),
      }),
    ).toBe(false);
  });

  it("maps {repo, sha} from the payload and omits baseURL (resolved in-run)", () => {
    const inputs = trigger?.inputs({
      payload: makePayload({ repo: "acme/web", sha: "deadbeefcafe0000" }),
    });
    expect(inputs).toEqual({ repo: "acme/web", sha: "deadbeefcafe0000" });
    expect("baseURL" in (inputs as object)).toBe(false);
  });

  it("derives a {run}:{repo_}:{sha12} idempotency key", () => {
    expect(
      trigger?.idempotencyKey({
        payload: makePayload({ repo: "acme/web", sha: "deadbeefcafe0000" }),
      }),
    ).toBe("playwright-e2e:acme_web:deadbeefcafe");
  });
});
