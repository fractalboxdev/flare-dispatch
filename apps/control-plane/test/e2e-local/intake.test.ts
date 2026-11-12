// Intake on the cloud path with the GitHub App: the Worker holds an App key, and the fixture server answers GitHub from
// the recorded state of `fixtures/intake-github.json`. Each trigger reads the repository's manifest through the App,
// and an Actions dispatch is verified against the fixture issuer's JWKS (specs/intake.md § Manifest, § Actions
// dispatch).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeSigner } from "@fractalboxdev/flare-dispatch-api/test-support";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GithubState } from "./fixtures/github-server.ts";
import { OIDC_AUDIENCE, startStack, WEBHOOK_SECRET, type Stack } from "./stack.ts";

const STATE = JSON.parse(
  readFileSync(join(import.meta.dirname, "fixtures/intake-github.json"), "utf8"),
) as GithubState;

const WIDGETS = "acme/widgets";
const GADGETS = "acme/gadgets";
const BROKEN = "acme/broken";
/** A repository no installation of the App covers. */
const STRAY = "acme/stray";

const repo = (name: string) => STATE.repositories[name]!;
const headOf = (name: string) => repo(name).branches[repo(name).default_branch]!;

let stack: Stack;

beforeAll(async () => {
  stack = await startStack({ github: STATE });
});

afterAll(async () => {
  await stack?.close();
});

const query = async (sql: string, ...params: unknown[]) => {
  const db = await stack.mf.getD1Database("DB");
  return (
    await db
      .prepare(sql)
      .bind(...params)
      .all()
  ).results;
};

const recordsOf = (repository: string) =>
  query(
    "select trigger, run, label, sha, installation from intake_records where repo = ? order by created_at",
    repository,
  );

/** The recorded pull request delivery, retargeted at `repository`. */
const pullRequestTo = (repository: string) =>
  stack.github.delivery("pull_request", "pull_request.opened.json", WEBHOOK_SECRET, (payload) => {
    const pr = payload["pull_request"] as Record<string, Record<string, unknown>>;
    const [owner, name] = repository.split("/") as [string, string];
    const target = { ...(payload["repository"] as object), name, full_name: repository };
    const side = (s: Record<string, unknown>) => ({
      ...s,
      repo: { ...(s["repo"] as object), name, full_name: repository },
      label: `${owner}:${String(s["ref"])}`,
    });
    return {
      ...payload,
      repository: target,
      pull_request: {
        ...pr,
        base: { ...side(pr["base"]!), sha: headOf(repository) },
        head: side(pr["head"]!),
      },
    };
  });

const deliver = async (repository: string) => {
  const delivery = pullRequestTo(repository);
  return fetch(`${stack.url}/v1/webhooks/github`, {
    method: "POST",
    headers: delivery.headers,
    body: delivery.body,
  });
};

const dispatch = (
  token: string,
  run: string,
  body: { readonly repository: string; readonly sha: string } & Record<string, unknown>,
) =>
  fetch(`${stack.url}/v1/dispatch/${run}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({
      ...body,
      inputs: {
        repo: `https://github.com/${body.repository}`,
        sha: body.sha,
        ref: "refs/heads/main",
        steps: [{ label: "test", command: "pnpm test" }],
      },
    }),
  });

const tokenFor = (repository: string, sha: string) =>
  stack.github.oidcToken({ repository, sha }, OIDC_AUDIENCE);

describe("the manifest decides what a trigger submits", () => {
  it("[FD-INT-015] a pull request submits only the run its manifest lists for pull_request; a dispatch of a run listed only for push is refused", async () => {
    const r = await deliver(WIDGETS);
    expect(r.status).toBe(202);
    const { executions } = (await r.json()) as { executions: string[] };
    // The manifest lists `check` twice: label `ci` for pull requests and dispatch, label `release` for pushes only.
    expect(executions).toHaveLength(1);
    expect(await recordsOf(WIDGETS)).toEqual([
      {
        trigger: "webhook",
        run: "check",
        label: "ci",
        sha: "1".repeat(40),
        installation: repo(WIDGETS).installation,
      },
    ]);
    // The Worker read the manifest at the base branch head, through the App.
    expect(stack.github.calls).toContainEqual({
      method: "GET",
      host: "api.github.com",
      path: `/repos/${WIDGETS}/contents/.github/flare-dispatch.json?ref=${headOf(WIDGETS)}`,
    });

    const sha = "6".repeat(40);
    const token = await tokenFor(WIDGETS, sha);
    const notListed = await dispatch(token, "check", {
      repository: WIDGETS,
      sha,
      label: "release",
    });
    expect(notListed.status).toBe(404);
    expect(((await notListed.json()) as { error: string }).error).toBe("run_not_found");
    const listed = await dispatch(token, "check", { repository: WIDGETS, sha, label: "ci" });
    expect(listed.status).toBe(202);
    expect((await recordsOf(WIDGETS)).map((r) => [r["trigger"], r["label"], r["sha"]])).toEqual([
      ["webhook", "ci", "1".repeat(40)],
      ["dispatch", "ci", sha],
    ]);
    expect(stack.github.unrecorded).toEqual([]);
  });

  it("[FD-INT-018] a manifest whose entries fail the recipe's parameters submits nothing, records the shed and posts the failing manifest check run", async () => {
    const r = await deliver(BROKEN);
    expect(r.status).toBe(202);
    expect(((await r.json()) as { executions: string[] }).executions).toEqual([]);
    // The manifest's one valid entry is not submitted either.
    expect(await recordsOf(BROKEN)).toEqual([]);
    expect(await query("select reason from shed where scope_id = ?", BROKEN)).toEqual([
      { reason: "manifest: invalid" },
    ]);
    const posted = stack.github.writes.filter((w) => w.path === `/repos/${BROKEN}/check-runs`);
    expect(posted).toHaveLength(1);
    const body = posted[0]!.body as {
      name: string;
      head_sha: string;
      status: string;
      conclusion: string;
      output: { title: string; summary: string };
    };
    expect(body).toMatchObject({
      name: "flare-dispatch/manifest",
      head_sha: headOf(BROKEN),
      status: "completed",
      conclusion: "failure",
    });
    // 22 entries with no steps fail, so the summary lists the first 20 errors and counts the rest.
    const listed = body.output.summary.split("\n").filter((l) => l.startsWith("- "));
    expect(listed).toHaveLength(20);
    expect(listed[0]).toContain("runs[1].params");
    expect(body.output.summary).toMatch(/\nand \d+ more$/);
    expect(stack.github.unrecorded).toEqual([]);
  });
});

describe("an Actions dispatch", () => {
  it("[FD-INT-035] is accepted only with the issuer's RS256 signature from its JWKS, the configured audience and an unexpired exp", async () => {
    const sha = "7".repeat(40);
    const job = { repository: WIDGETS, sha };
    const now = Math.floor(Date.now() / 1000);
    const forger = await makeSigner(stack.github.issuerKid);
    const refused = [
      await stack.github.oidcToken(job, "another-audience"),
      await stack.github.oidcToken(job, OIDC_AUDIENCE, {
        claims: { iss: "https://issuer.example.com" },
      }),
      await stack.github.oidcToken(job, OIDC_AUDIENCE, {
        claims: { iat: now - 1200, nbf: now - 1200, exp: now - 600 },
      }),
      await stack.github.oidcToken(job, OIDC_AUDIENCE, { header: { alg: "RS512" } }),
      // The issuer's kid, signed by a key outside its JWKS.
      await forger.sign({
        iss: "https://token.actions.githubusercontent.com",
        aud: OIDC_AUDIENCE,
        repository: WIDGETS,
        ref: "refs/heads/main",
        workflow_ref: `${WIDGETS}/.github/workflows/ci.yml@refs/heads/main`,
        sha,
        exp: now + 600,
      }),
    ];
    for (const token of refused) {
      const r = await dispatch(token, "check", { repository: WIDGETS, sha, label: "ci" });
      expect(r.status).toBe(401);
      expect(((await r.json()) as { error: string }).error).toBe("unauthenticated");
    }
    expect((await recordsOf(WIDGETS)).filter((r) => r["sha"] === sha)).toEqual([]);

    const accepted = await dispatch(await tokenFor(WIDGETS, sha), "check", {
      repository: WIDGETS,
      sha,
      label: "ci",
    });
    expect(accepted.status).toBe(202);
    // The keys came from the issuer's JWKS on the fixture server.
    expect(stack.github.calls).toContainEqual({
      method: "GET",
      host: "token.actions.githubusercontent.com",
      path: "/.well-known/jwks",
    });
  });

  it("[FD-INT-042] takes its installation from the repository through the App; a repository no installation covers answers 422", async () => {
    const sha = "8".repeat(40);
    const r = await dispatch(await tokenFor(GADGETS, sha), "check", { repository: GADGETS, sha });
    expect(r.status).toBe(202);
    expect(await recordsOf(GADGETS)).toEqual([
      {
        trigger: "dispatch",
        run: "check",
        label: null,
        sha,
        installation: repo(GADGETS).installation,
      },
    ]);
    // The App resolved the installation from the repository and minted that installation's token.
    expect(stack.github.calls).toContainEqual({
      method: "GET",
      host: "api.github.com",
      path: `/repos/${GADGETS}/installation`,
    });
    expect(stack.github.calls).toContainEqual({
      method: "POST",
      host: "api.github.com",
      path: `/app/installations/${repo(GADGETS).installation}/access_tokens`,
    });

    const stray = await dispatch(await tokenFor(STRAY, sha), "check", { repository: STRAY, sha });
    expect(stray.status).toBe(422);
    expect(((await stray.json()) as { error: string }).error).toBe("installation_not_found");
    expect(await recordsOf(STRAY)).toEqual([]);
    expect(stack.github.unrecorded).toEqual([]);
  });
});
