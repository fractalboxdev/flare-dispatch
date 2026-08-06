// The slack-origin policy — the dispatcher's half of the Slack batch path.
//
// Two layers of assertion here, and both matter:
//
//   * The DECIDERS (`decideSlackOriginRun` / `decideSlackOriginInputs`) —
//     pure, so every refusal is exercised directly.
//   * The ROUTE (`handleDispatch` through a signed request) — because the
//     whole point of this issue is that the controls hold server-side. A
//     policy module that is right but unreachable from the route enforces
//     nothing, so the four named controls are asserted end-to-end: a
//     `secrets`-bearing dispatch is refused, a non-allowlisted run is refused,
//     an unpinned repo is refused, and an approval-needing run fails closed
//     with the pointer back at the conversational path.
//
// Plus the drift guard: every run on the allowlist is re-checked against its
// OWN inputs schema for command-shaped fields, so adding a `command` input to
// an allowlisted run breaks this suite rather than quietly opening a shell to
// a chat message.

import { describe, expect, it } from "vitest";
import { sign } from "./hmac";
import { lookupRun, runNames } from "./registry";
import { handleDispatch } from "./routes/dispatch";
import {
  decideSlackOriginInputs,
  decideSlackOriginRun,
  payloadCommandInputs,
  resolveAllowedRuns,
  resolveSlackOriginKey,
  SLACK_ORIGIN_RUNS,
  type SlackOriginConfig,
} from "./slack-origin";
import { makeFakeEnv, makeFakeKv, makeFakeR2, makeFakeWorkflow } from "./test-helpers";

const SECRET = "slack-origin-test-secret-32-bytes";
const PINNED = "fractalbox/pinned-repo";
const SHA = "0123456789abcdef0123456789abcdef01234567";

const ORIGIN = {
  kind: "slack" as const,
  team_id: "T0BHHNG3FNJ",
  channel: "C0BHXAMJLA1",
  thread_ts: "1712345678.123456",
  user_id: "U0BHHNG3FNJ",
};

const config = (over: Partial<SlackOriginConfig> = {}): SlackOriginConfig => ({
  pinnedRepo: PINNED,
  allowedRuns: new Set(SLACK_ORIGIN_RUNS),
  ...over,
});

const run = (name: string) => {
  const found = lookupRun(name);
  if (found === undefined) throw new Error(`test fixture: no run named ${name}`);
  return found;
};

// --- the deciders -----------------------------------------------------------

describe("decideSlackOriginRun", () => {
  it("admits an allowlisted run on the pinned repo with an idempotency key", () => {
    const verdict = decideSlackOriginRun({
      runName: "spec-drift-pr",
      run: run("spec-drift-pr"),
      repo: PINNED,
      rawInputs: {},
      idempotencyKey: "Ev0123456789",
      config: config(),
    });

    expect(verdict.kind).toBe("admitted");
  });

  it("refuses everything when no target repo is pinned — the path is off by default", () => {
    const verdict = decideSlackOriginRun({
      runName: "spec-drift-pr",
      run: run("spec-drift-pr"),
      repo: PINNED,
      rawInputs: {},
      idempotencyKey: "Ev0123456789",
      config: config({ pinnedRepo: undefined }),
    });

    expect(verdict).toMatchObject({ kind: "refused", error: "slack_origin_unconfigured" });
  });

  it("fails an approval-needing run closed, pointing back at the conversational path", () => {
    const verdict = decideSlackOriginRun({
      runName: "release-notes",
      run: run("release-notes"),
      repo: PINNED,
      rawInputs: {},
      idempotencyKey: "Ev0123456789",
      config: config({ allowedRuns: new Set([...SLACK_ORIGIN_RUNS, "release-notes"]) }),
    });

    expect(verdict).toMatchObject({ kind: "refused", error: "approval_required" });
    // The refusal must say what to do instead — a bare "denied" would leave
    // the asker with a silent thread, which is the failure it exists to avoid.
    if (verdict.kind !== "refused") throw new Error("expected a refusal");
    expect(verdict.message).toContain("in the thread");
    expect(verdict.message).toContain("merging or rejecting the release PR");
  });

  it("refuses a run that is not on the allowlist", () => {
    const verdict = decideSlackOriginRun({
      runName: "offload-test",
      run: run("offload-test"),
      repo: PINNED,
      rawInputs: {},
      idempotencyKey: "Ev0123456789",
      config: config(),
    });

    expect(verdict).toMatchObject({ kind: "refused", error: "run_not_allowed_from_slack" });
  });

  it("refuses a payload-command run even when it was allowlisted by hand", () => {
    const verdict = decideSlackOriginRun({
      runName: "offload-test",
      run: run("offload-test"),
      repo: PINNED,
      rawInputs: {},
      idempotencyKey: "Ev0123456789",
      config: config({ allowedRuns: new Set([...SLACK_ORIGIN_RUNS, "offload-test"]) }),
    });

    expect(verdict).toMatchObject({ kind: "refused", error: "payload_command_run" });
    if (verdict.kind !== "refused") throw new Error("expected a refusal");
    expect(verdict.message).toContain("`command`");
  });

  it("refuses a repo other than the pinned target", () => {
    const verdict = decideSlackOriginRun({
      runName: "spec-drift-pr",
      run: run("spec-drift-pr"),
      repo: "someone-else/other-repo",
      rawInputs: {},
      idempotencyKey: "Ev0123456789",
      config: config(),
    });

    expect(verdict).toMatchObject({ kind: "refused", error: "repo_not_pinned" });
  });

  it("refuses a dispatch with no Idempotency-Key — repeats would silently dedup", () => {
    const verdict = decideSlackOriginRun({
      runName: "spec-drift-pr",
      run: run("spec-drift-pr"),
      repo: PINNED,
      rawInputs: {},
      idempotencyKey: null,
      config: config(),
    });

    expect(verdict).toMatchObject({ kind: "refused", error: "idempotency_key_required" });
  });

  it("refuses a payload naming a secret before anything else about the run", () => {
    // The credential rule does not depend on the run being allowlisted, on the
    // repo matching, or on the run even accepting a `secrets` field — a
    // caller that attaches one has a bug worth naming on its own terms.
    const verdict = decideSlackOriginRun({
      runName: "offload-test",
      run: run("offload-test"),
      repo: "someone-else/other-repo",
      rawInputs: { repo: PINNED, sha: SHA, secrets: ["CLERK_SECRET_KEY"] },
      idempotencyKey: null,
      config: config(),
    });

    expect(verdict).toMatchObject({
      kind: "refused",
      error: "credential_selection_not_permitted",
    });
  });
});

describe("decideSlackOriginInputs", () => {
  it("refuses decoded inputs naming secrets — a schema default cannot smuggle one", () => {
    const verdict = decideSlackOriginInputs({
      runName: "check",
      run: run("check"),
      decoded: { repo: PINNED, sha: SHA, secrets: ["CLERK_SECRET_KEY"] },
    });

    expect(verdict).toMatchObject({
      kind: "refused",
      error: "credential_selection_not_permitted",
    });
  });

  it("refuses inputs naming a credential the run resolves indirectly", () => {
    const verdict = decideSlackOriginInputs({
      runName: "pr-review",
      run: run("pr-review"),
      decoded: { repo: PINNED, sha: SHA, baseSha: SHA, pr: 1, roleArn: "arn:aws:iam::1:role/x" },
    });

    expect(verdict).toMatchObject({
      kind: "refused",
      error: "credential_selection_not_permitted",
    });
  });

  it("forces `secrets: []` onto what executes, for a run that declares the field", () => {
    const verdict = decideSlackOriginInputs({
      runName: "check",
      run: run("check"),
      // An empty array passes the refusal above; the normalization still has
      // to run, because the guarantee is about what executes, not what was
      // asked for.
      decoded: { repo: PINNED, sha: SHA, secrets: [] },
    });

    if (verdict.kind !== "admitted") throw new Error("expected admission");
    expect(verdict.inputs).toMatchObject({ secrets: [] });
  });

  it("leaves inputs untouched for a run with no secrets field", () => {
    const decoded = { firedAt: 1_700_000_000_000 };
    const verdict = decideSlackOriginInputs({
      runName: "spec-drift-pr",
      run: run("spec-drift-pr"),
      decoded,
    });

    if (verdict.kind !== "admitted") throw new Error("expected admission");
    expect(verdict.inputs).toBe(decoded);
  });
});

// --- the allowlist stays honest as the run catalog moves --------------------

describe("the slack-origin allowlist", () => {
  it("names only runs that exist in this deploy's registry", () => {
    expect(SLACK_ORIGIN_RUNS.filter((name) => lookupRun(name) === undefined)).toEqual([]);
  });

  it("contains no run that takes a command from its dispatch payload", () => {
    const offenders = SLACK_ORIGIN_RUNS.map((name) => ({
      name,
      inputs: payloadCommandInputs(run(name)),
    })).filter(({ inputs }) => inputs.length > 0);

    expect(offenders).toEqual([]);
  });

  it("contains no run that pauses on a human decision", () => {
    expect(SLACK_ORIGIN_RUNS.filter((name) => run(name).humanGate !== undefined)).toEqual([]);
  });

  it("classifies the catalog's command-carrying runs as payload-command", () => {
    // A sanity anchor on the detector itself: if `payloadCommandInputs` ever
    // stops recognising these, the allowlist assertions above go quiet and
    // stop protecting anything.
    const detected = runNames().filter((name) => payloadCommandInputs(run(name)).length > 0);

    expect(detected).toEqual(
      expect.arrayContaining([
        "cdp-acceptance",
        "check",
        "matrix-fanout",
        "offload-test",
        "oxlint",
        "playwright-demo",
        "refresh-fixtures",
        "vitest-shard",
        "worker-deploy",
      ]),
    );
  });
});

describe("resolveAllowedRuns", () => {
  it("keeps the code set when CONFIG_KV says nothing", () => {
    expect([...resolveAllowedRuns(["a", "b"], null)]).toEqual(["a", "b"]);
    expect([...resolveAllowedRuns(["a", "b"], "  ")]).toEqual(["a", "b"]);
  });

  it("narrows to the intersection", () => {
    expect([...resolveAllowedRuns(["a", "b", "c"], "b, c")]).toEqual(["b", "c"]);
  });

  it("cannot widen — a KV name outside the code set is dropped", () => {
    expect([...resolveAllowedRuns(["a"], "a,offload-test")]).toEqual(["a"]);
  });
});

describe("resolveSlackOriginKey", () => {
  it("ignores a scoped key that is just HMAC_SECRET under another name", () => {
    const env = { HMAC_SECRET: SECRET, SLACK_ORIGIN_HMAC_SECRET: SECRET } as never;

    expect(resolveSlackOriginKey(env)).toBeUndefined();
  });

  it("returns a genuinely distinct scoped key", () => {
    const env = { HMAC_SECRET: SECRET, SLACK_ORIGIN_HMAC_SECRET: `${SECRET}-scoped` } as never;

    expect(resolveSlackOriginKey(env)).toBe(`${SECRET}-scoped`);
  });
});

// --- the route enforces it --------------------------------------------------

type DispatchOpts = {
  readonly run: string;
  readonly repo?: string;
  readonly inputs: unknown;
  readonly source?: unknown;
  readonly idempotencyKey?: string | null;
  readonly pinnedRepo?: string | null;
  readonly secret?: string;
  readonly scopedSecret?: string;
};

/** Sign and drive a dispatch through the real route against fake bindings. */
const dispatch = async (opts: DispatchOpts) => {
  const workflow = makeFakeWorkflow();
  const configKv = makeFakeKv();
  const pinned = opts.pinnedRepo === undefined ? PINNED : opts.pinnedRepo;
  if (pinned !== null) configKv.store.set("slack-origin.repo", pinned);

  const env = {
    ...makeFakeEnv({
      hmacSecret: SECRET,
      workflow,
      storage: makeFakeR2(),
      configKv: configKv.binding,
    }),
    ...(opts.scopedSecret !== undefined ? { SLACK_ORIGIN_HMAC_SECRET: opts.scopedSecret } : {}),
  };

  const body = JSON.stringify({
    run: opts.run,
    github: { repo: opts.repo ?? PINNED, ref: "refs/heads/main", sha: SHA },
    inputs: opts.inputs,
    ...(opts.source !== undefined ? { source: opts.source } : {}),
  });
  const bytes = new TextEncoder().encode(body);
  const key = opts.scopedSecret ?? opts.secret ?? SECRET;
  const idempotencyKey = opts.idempotencyKey === undefined ? "Ev0123456789" : opts.idempotencyKey;

  const response = await handleDispatch(
    new Request(`https://dispatcher.test/v1/dispatch/${opts.run}`, {
      method: "POST",
      headers: {
        "X-FlareDispatch-Signature": await sign(key, bytes),
        ...(idempotencyKey === null ? {} : { "Idempotency-Key": idempotencyKey }),
      },
      body,
    }),
    env,
    opts.run,
  );

  return { response, body: (await response.json()) as Record<string, unknown>, workflow };
};

describe("POST /v1/dispatch/:run — slack origin", () => {
  it("accepts an allowlisted run on the pinned repo and instantiates it", async () => {
    const { response, body, workflow } = await dispatch({
      run: "spec-drift-pr",
      inputs: { firedAt: 1_700_000_000_000 },
      source: ORIGIN,
    });

    expect(response.status).toBe(202);
    expect(body["executionId"]).toBeTypeOf("string");
    expect(workflow.calls).toHaveLength(1);
    // The origin rides into the Workflow so the verdict knows its way back.
    expect(workflow.calls[0]?.params).toMatchObject({ source: ORIGIN });
  });

  it("rejects a slack-origin dispatch carrying secrets", async () => {
    const { response, body, workflow } = await dispatch({
      run: "check",
      inputs: { repo: PINNED, sha: SHA, command: "pnpm lint", secrets: ["CLERK_SECRET_KEY"] },
      source: ORIGIN,
    });

    expect(response.status).toBe(403);
    expect(body["error"]).toBe("credential_selection_not_permitted");
    expect(workflow.calls).toHaveLength(0);
  });

  it("rejects a secrets array smuggled onto a run whose schema would drop it", async () => {
    // `spec-drift-pr` takes only `firedAt`, so decoding discards `secrets`
    // entirely. Refusing on the raw payload is what keeps that from answering
    // 202 to a request that asked for a credential.
    const { response, body, workflow } = await dispatch({
      run: "spec-drift-pr",
      inputs: { firedAt: 1_700_000_000_000, secrets: ["CLERK_SECRET_KEY"] },
      source: ORIGIN,
    });

    expect(response.status).toBe(403);
    expect(body["error"]).toBe("credential_selection_not_permitted");
    expect(workflow.calls).toHaveLength(0);
  });

  it("rejects an IAM role chosen by the dispatch on an allowlisted run", async () => {
    const { response, body, workflow } = await dispatch({
      run: "pr-review",
      inputs: {
        repo: PINNED,
        sha: SHA,
        baseSha: SHA,
        pr: 7,
        roleArn: "arn:aws:iam::123456789012:role/exfiltrate",
      },
      source: ORIGIN,
    });

    expect(response.status).toBe(403);
    expect(body["error"]).toBe("credential_selection_not_permitted");
    expect(workflow.calls).toHaveLength(0);
  });

  it("rejects a non-allowlisted run", async () => {
    const { response, body, workflow } = await dispatch({
      run: "deploy-smoke",
      inputs: { repo: PINNED, sha: SHA, baseURL: "https://example.test", paths: ["/"] },
      source: ORIGIN,
    });

    expect(response.status).toBe(403);
    expect(body["error"]).toBe("run_not_allowed_from_slack");
    expect(workflow.calls).toHaveLength(0);
  });

  it("rejects a repo other than the pinned target", async () => {
    const { response, body, workflow } = await dispatch({
      run: "spec-drift-pr",
      repo: "someone-else/other-repo",
      inputs: { firedAt: 1_700_000_000_000 },
      source: ORIGIN,
    });

    expect(response.status).toBe(403);
    expect(body["error"]).toBe("repo_not_pinned");
    expect(workflow.calls).toHaveLength(0);
  });

  it("fails an approval-needing run closed instead of parking a Workflow", async () => {
    const { response, body, workflow } = await dispatch({
      run: "release-notes",
      inputs: { firedAt: 1_700_000_000_000 },
      source: ORIGIN,
    });

    expect(response.status).toBe(403);
    expect(body["error"]).toBe("approval_required");
    expect(String(body["message"])).toContain("in the thread");
    expect(workflow.calls).toHaveLength(0);
  });

  it("refuses when no repo is pinned — the batch path is opt-in", async () => {
    const { response, body, workflow } = await dispatch({
      run: "spec-drift-pr",
      inputs: { firedAt: 1_700_000_000_000 },
      source: ORIGIN,
      pinnedRepo: null,
    });

    expect(response.status).toBe(403);
    expect(body["error"]).toBe("slack_origin_unconfigured");
    expect(workflow.calls).toHaveLength(0);
  });

  it("refuses a slack-origin dispatch with no Idempotency-Key", async () => {
    const { response, body, workflow } = await dispatch({
      run: "spec-drift-pr",
      inputs: { firedAt: 1_700_000_000_000 },
      source: ORIGIN,
      idempotencyKey: null,
    });

    expect(response.status).toBe(403);
    expect(body["error"]).toBe("idempotency_key_required");
    expect(workflow.calls).toHaveLength(0);
  });

  it("400s a malformed origin block rather than treating it as no origin", async () => {
    const { response, body, workflow } = await dispatch({
      run: "spec-drift-pr",
      inputs: { firedAt: 1_700_000_000_000 },
      source: { kind: "slack", team_id: "T1", channel: "line\nbreak" },
    });

    expect(response.status).toBe(400);
    expect(body["error"]).toBe("invalid_body");
    expect(workflow.calls).toHaveLength(0);
  });

  it("leaves a dispatch with no origin block on the unchanged Action path", async () => {
    const { response, workflow } = await dispatch({
      run: "offload-test",
      repo: "any/other-repo",
      inputs: { repo: "any/other-repo", sha: SHA, command: "pnpm test", secrets: ["A_SECRET"] },
    });

    expect(response.status).toBe(202);
    expect(workflow.calls).toHaveLength(1);
  });

  it("forces the policy on the scoped key, even with no origin block to declare it", async () => {
    const { response, body, workflow } = await dispatch({
      run: "offload-test",
      inputs: { repo: PINNED, sha: SHA, command: "pnpm test" },
      scopedSecret: `${SECRET}-scoped`,
    });

    expect(response.status).toBe(403);
    expect(body["error"]).toBe("slack_origin_context_required");
    expect(workflow.calls).toHaveLength(0);
  });

  it("still 401s a body signed with neither key", async () => {
    const { response } = await dispatch({
      run: "spec-drift-pr",
      inputs: { firedAt: 1_700_000_000_000 },
      source: ORIGIN,
      secret: "the-wrong-secret-entirely-aaaaaaa",
    });

    expect(response.status).toBe(401);
  });
});
