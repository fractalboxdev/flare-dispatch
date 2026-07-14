// FlareDispatch Dispatcher — the deploy console (`GET/POST /deploy`).
//
// A human-facing, Cloudflare-Access-gated surface: an authenticated operator
// picks an environment and triggers a deploy. Authorization — who may deploy
// WHICH env — is derived from the verified Access identity (deploy-access.ts)
// against the `deploy.env-authz` policy in CONFIG_KV (deploy-authz.ts), never
// from a self-asserted field.
//
//   GET  /deploy → the console page, listing only the caller's authorized envs.
//   POST /deploy → re-checks authorization SERVER-SIDE (never trusts the hidden
//                  button), then instantiates a `worker-deploy` execution for
//                  the chosen env. Production-class envs (requireGithubLogin)
//                  additionally pass through the run cooldown.
//
// The env reaches the deploy command as `DEPLOY_ENV` via worker-deploy's
// existing non-sensitive `env` input — no run change needed. An unconfigured
// repo makes `worker-deploy` no-op green, so a POST is always a real, linkable
// execution with no surprise side effects.

import { Schema } from "effect";
import { isBrowserNavigation } from "../access-auth";
import { checkAndArmCooldown } from "../cooldown";
import { workflowDashboardUrl } from "../dashboard-url";
import { gateDeploy } from "../deploy-access";
import {
  allowedEnvs,
  ENV_AUTHZ_KEY,
  envRequiresApproval,
  parseEnvAuthzPolicy,
} from "../deploy-authz";
import {
  renderDeployPage,
  type CommitOption,
  type DeployEnvOption,
  type RefOption,
} from "../deploy-page";
import type { Env } from "../env";
import { listBranches, listRecentCommits, resolveRefHead, shortRef } from "../github-deploy";
import { toInstanceId } from "../instance-id";
import { lookupRun } from "../registry";

/** Default deploy target — this repository. */
const DEFAULT_REPO = "fractalboxdev/flare-dispatch";
const DEFAULT_REFS = ["refs/heads/main", "refs/heads/alpha"];
/** Cooldown window for a production-class deploy (seconds). */
const PROD_COOLDOWN_SEC = 120;

/** CONFIG_KV overrides for the dropdown option sets. */
const DEPLOY_REPOS_KEY = "deploy.repos";
const DEPLOY_REFS_KEY = "deploy.refs";

/** Parse a comma-separated CONFIG_KV list into trimmed, non-empty entries. */
const csv = (raw: string | null): readonly string[] =>
  raw === null
    ? []
    : raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);

/** Normalize a configured ref (bare name or full ref) to `refs/heads/<name>`. */
const toFullRef = (ref: string): string =>
  ref.startsWith("refs/") ? ref : `refs/heads/${ref}`;

/**
 * Build the repo / ref / commit dropdown option sets. Repos come from
 * `deploy.repos` (or this repo); refs from the active repo's branches via the
 * GitHub App, falling back to `deploy.refs` / defaults; commits from the active
 * repo + ref (best-effort — empty when the App can't serve them, the page still
 * works via the "latest" option). Only the FIRST repo's refs/commits are
 * pre-rendered; POST re-resolves for whatever the caller actually picks.
 */
const buildFormOptions = async (
  env: Env,
): Promise<{
  repos: readonly string[];
  refs: readonly RefOption[];
  commits: readonly CommitOption[];
}> => {
  const configRepos = env.CONFIG_KV !== undefined ? csv(await env.CONFIG_KV.get(DEPLOY_REPOS_KEY)) : [];
  const repos = configRepos.length > 0 ? configRepos : [DEFAULT_REPO];
  const activeRepo = repos[0]!;

  const branches = await listBranches(env, activeRepo);
  const refValues =
    branches !== null && branches.length > 0
      ? branches.map((b) => `refs/heads/${b}`)
      : (env.CONFIG_KV !== undefined ? csv(await env.CONFIG_KV.get(DEPLOY_REFS_KEY)) : []).map(toFullRef);
  const refList = refValues.length > 0 ? refValues : DEFAULT_REFS;
  const refs: readonly RefOption[] = refList.map((value) => ({ value, label: shortRef(value) }));

  const commits = (await listRecentCommits(env, activeRepo, refs[0]!.value)) ?? [];
  return { repos, refs, commits };
};

const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const html = (body: string, status: number): Response =>
  new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });

/** Load + parse the `deploy.env-authz` policy from CONFIG_KV (fail-closed). */
const loadPolicy = async (env: Env) =>
  parseEnvAuthzPolicy(
    env.CONFIG_KV !== undefined ? await env.CONFIG_KV.get(ENV_AUTHZ_KEY) : null,
  );

/**
 * `GET/POST /deploy`. Gates behind the deploy Access app, resolves the caller's
 * authorized environments, then renders (GET) or dispatches (POST).
 */
export const handleDeploy = async (env: Env, request: Request): Promise<Response> => {
  const gate = await gateDeploy(env, request);
  if (!gate.ok) return gate.response;
  const { identity, raw } = gate;

  const policy = await loadPolicy(env);
  const allowed = allowedEnvs(identity, policy);
  const envOptions: readonly DeployEnvOption[] = allowed.map((name) => ({
    name,
    requiresApproval: envRequiresApproval(name, policy),
  }));

  const url = new URL(request.url);

  // `?debug=identity` — dump what Access actually gave us alongside what we
  // derived from it. Access-gated like the rest of /deploy, and it only ever
  // reveals the CALLER'S OWN identity. The setup aid for wiring team policies:
  // paste your teams into `deploy.env-authz` exactly as `groups` shows them.
  if (request.method === "GET" && url.searchParams.get("debug") === "identity") {
    return json(
      {
        rawGetIdentity: raw,
        extracted: { email: identity.email, idp: identity.idp, login: identity.login },
        groups: identity.groups,
        allowedEnvs: allowed,
      },
      200,
    );
  }

  if (request.method === "POST") {
    return handleDeployPost(env, request, identity, policy, allowed);
  }
  if (request.method !== "GET") {
    return json({ error: "method_not_allowed" }, 405);
  }
  const deployed = url.searchParams.get("deployed");
  const deployedEnv = url.searchParams.get("env");
  const notice =
    deployed !== null
      ? `Deploy queued for ${deployedEnv ?? "the selected environment"} — execution ${deployed}.`
      : null;

  const { repos, refs, commits } = await buildFormOptions(env);

  return html(
    renderDeployPage({
      email: identity.email,
      idp: identity.idp,
      groups: identity.groups,
      envs: envOptions,
      repos,
      refs,
      commits,
      notice,
    }),
    200,
  );
};

const formString = (form: FormData, key: string): string => {
  const v = form.get(key);
  return typeof v === "string" ? v.trim() : "";
};

const handleDeployPost = async (
  env: Env,
  request: Request,
  identity: { readonly idp: string; readonly email: string },
  policy: ReturnType<typeof parseEnvAuthzPolicy>,
  allowed: readonly string[],
): Promise<Response> => {
  const form = await request.formData();
  const targetEnv = formString(form, "env");
  const repo = formString(form, "repo") || DEFAULT_REPO;
  const ref = formString(form, "ref") || DEFAULT_REFS[0]!;
  let sha = formString(form, "sha");

  // Server-side authorization — the button being present in the page is NOT
  // trust. Re-derive from the verified identity; a disallowed env is refused
  // even if POSTed directly. (requireGithubLogin is already folded into
  // `allowed` via allowedEnvs, so this one check covers the OTP guard too.)
  if (targetEnv === "" || !allowed.includes(targetEnv)) {
    return json(
      {
        error: "env_not_authorized",
        message: `not authorized to deploy "${targetEnv || "(none)"}"`,
        allowed,
      },
      403,
    );
  }

  // "Latest commit on the selected ref" (the empty-value option) → resolve the
  // ref's HEAD to a concrete SHA now, so worker-deploy checks out a real commit.
  if (sha === "") {
    const head = await resolveRefHead(env, repo, ref);
    if (head === null) {
      return json(
        {
          error: "sha_unresolved",
          message: `could not resolve the latest commit for ${repo}@${shortRef(ref)} — pick a specific commit, or confirm the GitHub App is installed on that repo`,
        },
        400,
      );
    }
    sha = head;
  }

  const run = lookupRun("worker-deploy");
  if (run === undefined) {
    return json({ error: "run_unavailable", message: "worker-deploy run not registered" }, 500);
  }

  const executionId = toInstanceId(
    `worker-deploy:${repo.replace(/\//g, "_")}:${targetEnv}:${sha.slice(0, 12)}`,
  );

  // Production-class cooldown — at most one prod deploy per window per env+repo.
  // A dispatch inside the window is acknowledged with the prior execution's id.
  if (envRequiresApproval(targetEnv, policy)) {
    const verdict = await checkAndArmCooldown({
      kv: env.IDEMPOTENCY_KV,
      runName: "worker-deploy",
      cooldown: { seconds: PROD_COOLDOWN_SEC, scope: () => `deploy-console:${targetEnv}` },
      repo,
      inputs: { repo },
      executionId,
      now: Date.now(),
    });
    if (verdict.state === "cooling") {
      return respondQueued(request, verdict.priorExecutionId, targetEnv, env, {
        cooling: verdict.retryAfterSec,
      });
    }
  }

  // Validate + decode inputs against the run's own schema (mirrors the dispatch
  // route), threading the env as DEPLOY_ENV so the deploy command can branch.
  const inputs = Schema.decodeUnknownSync(run.inputs)({
    repo,
    sha,
    branch: ref,
    env: { DEPLOY_ENV: targetEnv, DEPLOY_ACTOR: identity.email },
    failOnNonZeroExit: false,
  });

  const params = {
    executionId,
    run: "worker-deploy",
    github: { repo, ref, sha },
    inputs,
    origin: env.PUBLIC_ORIGIN ?? new URL(request.url).origin,
  };

  // Same idempotent-create posture as the dispatch route: a duplicate id (same
  // repo+env+sha) is the intended collapse, not an error.
  try {
    await env.RUNS_WORKFLOW.create({ id: executionId, params });
  } catch (cause) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    if (!/already_exists/i.test(msg)) throw cause;
  }

  return respondQueued(request, executionId, targetEnv, env, {});
};

/** Answer a queued deploy — a browser gets a PRG redirect, a caller gets JSON. */
const respondQueued = (
  request: Request,
  executionId: string,
  targetEnv: string,
  env: Env,
  extra: { readonly cooling?: number },
): Response => {
  const detailsUrl = workflowDashboardUrl(env.CLOUDFLARE_ACCOUNT_ID, executionId);
  if (isBrowserNavigation(request)) {
    const origin = new URL(request.url).origin;
    const params = new URLSearchParams({ deployed: executionId, env: targetEnv });
    return Response.redirect(`${origin}/deploy?${params.toString()}`, 303);
  }
  return json(
    {
      executionId,
      env: targetEnv,
      ...(extra.cooling !== undefined ? { skipped: "cooldown", retryAfterSec: extra.cooling } : {}),
      ...(detailsUrl !== undefined ? { detailsUrl } : {}),
    },
    202,
  );
};
