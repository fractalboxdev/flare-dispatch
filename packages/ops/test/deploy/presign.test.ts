// The deploy suite of `V-DEPLOY` for the object-store presigner's R2 API token (specs/cache-artifacts.md FD-CACHE-091):
// `fd deploy` and `fd doctor` on the fakes of `support.ts` fail the drift stage, before any write, where the control
// plane lacks either presign token secret or the token the overlay names is not Object Read & Write on exactly the
// cache and artifact buckets.
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { OBJECT_READ_WRITE, placeholderOverlay } from "../../src/index.ts";
import {
  API,
  apiToken,
  bucketKey,
  deploy,
  fd,
  isWrite,
  OVERLAY,
  PRESIGN_BUCKETS,
  PRESIGN_TOKEN_ID,
  SCRIPT,
  tokenPolicy,
  world,
  type World,
} from "./support.ts";

const [CACHE, ARTIFACTS] = PRESIGN_BUCKETS;
const BOTH = Object.fromEntries(PRESIGN_BUCKETS.map((b) => [bucketKey(b), "*"]));
const TOKEN_READ = `GET api.cloudflare.com${API}/tokens/${PRESIGN_TOKEN_ID}`;

type Report = { readonly stages: readonly { stage: string; ok: boolean; detail: string }[] };
const driftStage = (report: Report) => report.stages.find((s) => s.stage === "drift");

/**
 * `fd deploy` and `fd doctor` on an account `change` leaves as it is; each fails at the drift stage with no write, and
 * answers the drift stage's detail of both.
 */
const refused = async (change: (w: World) => void, overlay = OVERLAY) => {
  const w = world();
  change(w);
  const deployed = await deploy(w, overlay);
  expect(deployed.ok).toBe(false);
  expect(deployed.stages.at(-1)!.stage).toBe("drift");
  expect(w.calls.filter(isWrite)).toEqual([]);
  const doctor = await Effect.runPromise(fd(w).doctor(overlay));
  expect(doctor.ok).toBe(false);
  expect(w.calls.filter(isWrite)).toEqual([]);
  return { deploy: driftStage(deployed)!.detail, doctor: driftStage(doctor)!.detail };
};

/** A refusal whose deploy and doctor details both name each of `expected`. */
const refusedNaming = async (
  change: (w: World) => void,
  expected: readonly string[],
  overlay = OVERLAY,
) => {
  const details = await refused(change, overlay);
  for (const text of expected) {
    expect(details.deploy).toContain(text);
    expect(details.doctor).toContain(text);
  }
  return details;
};

const withToken = (token: Record<string, unknown>) => (w: World) =>
  void w.tokens.set(PRESIGN_TOKEN_ID, token);

describe("fd deploy over the presign token", () => {
  it("[FD-CACHE-091] deploys a control plane that holds both presign token secrets and whose token is Object Read & Write on exactly the cache and artifact buckets, reading the token's policies before the first write", async () => {
    const w = world();
    const report = await deploy(w);
    expect(report.ok).toBe(true);
    const read = w.calls.indexOf(TOKEN_READ);
    expect(read).toBeGreaterThanOrEqual(0);
    expect(read).toBeLessThan(w.calls.findIndex(isWrite));
    // Two policies that together grant Object Read & Write on each bucket are the same scope.
    const split = world();
    withToken(
      apiToken([
        tokenPolicy(OBJECT_READ_WRITE, { [bucketKey(CACHE)]: "*" }),
        tokenPolicy(OBJECT_READ_WRITE, { [bucketKey(ARTIFACTS)]: "*" }),
      ]),
    )(split);
    expect((await deploy(split)).ok).toBe(true);
  });

  it("[FD-CACHE-091] stops in the drift stage, before any write, where the control plane lacks R2_PRESIGN_ACCESS_KEY_ID or R2_PRESIGN_SECRET_ACCESS_KEY, naming the secret and never its value", async () => {
    for (const name of ["R2_PRESIGN_ACCESS_KEY_ID", "R2_PRESIGN_SECRET_ACCESS_KEY"]) {
      const details = await refusedNaming(
        (w) => w.deleteSecret(SCRIPT, name),
        [
          `control-plane.ports.object-store-presigner: phase 0 requires a Layer for object-store-presigner; unset: ${name}`,
        ],
      );
      expect(details.deploy).not.toContain("presign-key-id");
      expect(details.deploy).not.toContain("presign-secret");
    }
  });

  it("[FD-CACHE-091] stops in the drift stage where the overlay names no presign token, or the account owns none by that id", async () => {
    const { presign: _presign, ...unnamed } = placeholderOverlay;
    await refusedNaming(
      () => undefined,
      ["presign.tokenId: the overlay names no presign token"],
      JSON.stringify(unnamed),
    );
    await refusedNaming(
      (w) => void w.tokens.delete(PRESIGN_TOKEN_ID),
      [`presign.tokenId: the account owns no API token ${PRESIGN_TOKEN_ID}`],
    );
  });

  it("[FD-CACHE-091] stops in the drift stage where the token grants more than Object Read & Write: Admin Read & Write, or a permission group beside the object ones", async () => {
    await refusedNaming(
      withToken(
        apiToken([tokenPolicy(["Workers R2 Storage Read", "Workers R2 Storage Write"], BOTH)]),
      ),
      [
        "grants Workers R2 Storage Read, outside Object Read & Write",
        "grants Workers R2 Storage Write, outside Object Read & Write",
        `does not grant Workers R2 Storage Bucket Item Read or Workers R2 Storage Bucket Item Write on bucket ${CACHE}`,
      ],
    );
    await refusedNaming(
      withToken(apiToken([tokenPolicy([...OBJECT_READ_WRITE, "Workers Scripts Write"], BOTH)])),
      ["presign.token.policies[0].permission_groups: grants Workers Scripts Write"],
    );
  });

  it("[FD-CACHE-091] stops in the drift stage where the token grants Object Read only, or Object Read & Write on one of the two buckets", async () => {
    await refusedNaming(
      withToken(apiToken([tokenPolicy(["Workers R2 Storage Bucket Item Read"], BOTH)])),
      [
        `presign.token.${CACHE}: presign token ${PRESIGN_TOKEN_ID} does not grant Workers R2 Storage Bucket Item Write on bucket ${CACHE}`,
        `presign.token.${ARTIFACTS}: presign token ${PRESIGN_TOKEN_ID} does not grant Workers R2 Storage Bucket Item Write on bucket ${ARTIFACTS}`,
      ],
    );
    const details = await refusedNaming(
      withToken(apiToken([tokenPolicy(OBJECT_READ_WRITE, { [bucketKey(CACHE)]: "*" })])),
      [
        `does not grant Workers R2 Storage Bucket Item Read or Workers R2 Storage Bucket Item Write on bucket ${ARTIFACTS}`,
      ],
    );
    expect(details.deploy).not.toContain(`on bucket ${CACHE}`);
  });

  it("[FD-CACHE-091] stops in the drift stage where the token covers a resource beyond the two buckets: a third bucket, another account's bucket, the same-named bucket of another jurisdiction or every bucket of the account", async () => {
    const other = bucketKey("flare-dispatch-other");
    const foreign = bucketKey(CACHE, "f".repeat(32));
    const eu = bucketKey(CACHE).replace("_default_", "_eu_");
    const wildcard = `com.cloudflare.api.account.${placeholderOverlay.accountId}`;
    for (const [key, value] of [
      [other, "*"],
      [foreign, "*"],
      [eu, "*"],
      [wildcard, { "com.cloudflare.edge.r2.bucket.*": "*" }],
    ] as const)
      await refusedNaming(
        withToken(apiToken([tokenPolicy(OBJECT_READ_WRITE, { ...BOTH, [key]: value })])),
        [
          `presign.token.policies[0].resources: covers ${key}, which is not the cache or the artifact bucket of account ${placeholderOverlay.accountId}`,
        ],
      );
  });

  it("[FD-CACHE-091] stops in the drift stage where the token is not active, or a policy of it denies", async () => {
    await refusedNaming(withToken(apiToken([tokenPolicy(OBJECT_READ_WRITE, BOTH)], "disabled")), [
      `presign.token.status: presign token ${PRESIGN_TOKEN_ID} is disabled, not active`,
    ]);
    await refusedNaming(
      withToken(
        apiToken([
          tokenPolicy(OBJECT_READ_WRITE, BOTH),
          tokenPolicy(OBJECT_READ_WRITE, { [bucketKey(ARTIFACTS)]: "*" }, "deny"),
        ]),
      ),
      ["presign.token.policies[1].effect: the policy's effect is deny, not allow"],
    );
  });

  it("[FD-CACHE-091] stops in the drift stage, before any write, where the deploy token cannot read the presign token", async () => {
    await refusedNaming(
      (w) => void (w.state.tokensReadFails = true),
      [`GET ${API.slice("/client/v4".length)}/tokens/${PRESIGN_TOKEN_ID}: 403`],
    );
  });
});
