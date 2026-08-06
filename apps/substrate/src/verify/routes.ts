// The deploy-verification HTTP surface: `POST /canary`, `POST /dogfood`, and
// the canary block `/health` reports.
//
// Both probes are **unauthenticated by design**. ADR-0011 makes the canary
// double as the BYOC health check — the thing an operator runs to learn whether
// their deployment enforces the floor its version claims — and a check that
// needs a credential the operator must first be issued is a check most
// operators never run. What replaces the credential is the verdict record: a
// fresh verdict for the running deployment is served from D1 instead of
// re-probing, so the cost an anonymous caller can impose is one container boot
// per deployment per re-verify window (store-d1.ts), not one per request.
//
// `POST` rather than `GET` keeps crawlers, link previews and browser prefetch
// out of the probing path entirely.
import { SelfCheckFacade } from "../facade";
import { SUBSTRATE_VERSION } from "../version";
import { resolveProbeHost } from "./probe";
import { isDeferred, runCanary, runDogfood, type ProbeFacade } from "./run";
import { isProbeFresh, makeProbeStoreD1, type ProbeName, type ProbeRecord } from "./store-d1";
import type { SubstrateRecipe } from "@fractalboxdev/flare-dispatch-substrate-contract";
import type { Env } from "../env";

/** The public repository the dogfood clones when no override is configured. */
export const DOGFOOD_REPO_DEFAULT = "octocat/Hello-World";

/**
 * The build the verdict speaks for. `version_metadata` is a binding an operator
 * overlay can omit, so the semver is the fallback — coarser (a re-deploy of the
 * same source reuses a verdict it should have re-earned) but never wrong about
 * *which code* it describes, since the semver moves with the source.
 */
export function deploymentIdOf(env: Env): string {
  return env.VERSION_METADATA?.id ?? `v${SUBSTRATE_VERSION}`;
}

export type CanaryHealth = {
  /** True only when a fresh, passing canary exists for the running build. */
  verified: boolean;
  report: {
    status: ProbeRecord["status"] | "never-run";
    evidence?: string;
    checkedAt?: number;
    substrateVersion?: string;
  };
};

/**
 * What `/health` says about the egress floor. Fails closed: a D1 that cannot be
 * read yields `never-run`, because "I could not check" and "it is fine" must
 * never render the same on a security surface.
 */
export async function readCanaryHealth(env: Env, now: number = Date.now()): Promise<CanaryHealth> {
  let record: ProbeRecord | undefined;
  try {
    record = await makeProbeStoreD1(env.ADMISSION_DB).read(deploymentIdOf(env), "canary");
  } catch (err) {
    console.error("canary verdict read failed", err);
    return { verified: false, report: { status: "never-run" } };
  }
  if (!record) return { verified: false, report: { status: "never-run" } };
  return {
    verified: record.status === "passed" && isProbeFresh(record, now),
    report: {
      status: record.status,
      evidence: record.evidence,
      checkedAt: record.checkedAt,
      substrateVersion: record.substrateVersion,
    },
  };
}

/** `owner/name`, or the default — the value is interpolated into a clone URL. */
function dogfoodRecipe(env: Env): SubstrateRecipe {
  const raw = (env.DOGFOOD_REPO ?? "").trim();
  const slug = /^[\w.-]+\/[\w.-]+$/.test(raw) ? raw : DOGFOOD_REPO_DEFAULT;
  const [owner, name] = slug.split("/");
  return { version: 1, repo: { owner: owner ?? "", name: name ?? "" } };
}

/**
 * Serve a probe: cached verdict when one still speaks for this build, a real
 * run otherwise. A deferred run (pool full) answers 503 and records nothing —
 * the caller is expected to retry, and a busy fleet is not a verdict.
 */
async function serveProbe(
  env: Env,
  ctx: ExecutionContext,
  probe: ProbeName,
  run: (
    facade: ProbeFacade,
  ) => Promise<
    | { deferred: true; reason: string }
    | { deferred?: false; status: ProbeRecord["status"]; evidence: string }
  >,
): Promise<Response> {
  const deploymentId = deploymentIdOf(env);
  const store = makeProbeStoreD1(env.ADMISSION_DB);

  const cached = await store.read(deploymentId, probe).catch((err: unknown) => {
    console.error("probe verdict read failed", err);
    return undefined;
  });
  if (isProbeFresh(cached, Date.now()) && cached)
    return probeResponse(probe, deploymentId, cached, true);

  const outcome = await run(new SelfCheckFacade(ctx, env));
  if (isDeferred(outcome))
    return Response.json(
      { probe, deployment: deploymentId, status: "deferred", reason: outcome.reason },
      { status: 503 },
    );

  const record: ProbeRecord = {
    deploymentId,
    probe,
    status: outcome.status,
    evidence: outcome.evidence,
    substrateVersion: SUBSTRATE_VERSION,
    checkedAt: Date.now(),
  };
  // A verdict that cannot be persisted is still a verdict the caller must see;
  // losing it only costs the next call a re-probe.
  await store.record(record).catch((err: unknown) => {
    console.error("probe verdict write failed", err);
  });
  return probeResponse(probe, deploymentId, record, false);
}

function probeResponse(
  probe: ProbeName,
  deploymentId: string,
  record: ProbeRecord,
  cached: boolean,
): Response {
  return Response.json(
    {
      probe,
      deployment: deploymentId,
      status: record.status,
      evidence: record.evidence,
      substrateVersion: record.substrateVersion,
      checkedAt: record.checkedAt,
      cached,
    },
    { status: record.status === "passed" ? 200 : 503 },
  );
}

/**
 * Route the verification surface. Returns `undefined` for paths it does not
 * own, so the worker entry keeps its own routing.
 */
export async function handleVerifyRequest(
  url: URL,
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response | undefined> {
  const probe: ProbeName | undefined =
    url.pathname === "/canary" ? "canary" : url.pathname === "/dogfood" ? "dogfood" : undefined;
  if (!probe) return undefined;

  if (request.method !== "POST")
    return new Response(`POST ${url.pathname} to run the probe\n`, {
      status: 405,
      headers: { allow: "POST" },
    });

  const idempotencyKey = `${probe}-${crypto.randomUUID()}`;
  return probe === "canary"
    ? serveProbe(env, ctx, probe, (facade) =>
        runCanary(facade, { host: resolveProbeHost(env.CANARY_PROBE_HOST), idempotencyKey }),
      )
    : serveProbe(env, ctx, probe, (facade) =>
        runDogfood(facade, { recipe: dogfoodRecipe(env), idempotencyKey }),
      );
}
