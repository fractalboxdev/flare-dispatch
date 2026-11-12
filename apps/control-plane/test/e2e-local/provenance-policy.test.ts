// The verification policy over the deployed Worker: an operator publishes two versions with `PUT /v1/provenance-policy`,
// each is appended to the private log the `TransparencyLog` object writes to R2, and the well-known path serves the
// current version to a caller with no identity and an earlier one by its `policy_version`. On a deploy that holds a
// provenance key and a log key, the operator builds each version's key history from what the routes answer.
import { POLICY_PAYLOAD_TYPE } from "@fractalboxdev/flare-dispatch-cache/provenance-policy";
import { generateKeyPairSync } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OPERATOR } from "../support.ts";
import { startStack, type Stack } from "./stack.ts";

const POLICY_PATH = "/.well-known/flare-dispatch/provenance-policy.json";

let stack: Stack;

beforeAll(async () => {
  stack = await startStack();
});

afterAll(async () => {
  await stack?.close();
});

interface KeyHistory {
  readonly provenance_keys: readonly unknown[];
  readonly log_keys: readonly unknown[];
}

const NO_KEYS: KeyHistory = { provenance_keys: [], log_keys: [] };

const policy = (version: string, issuedAt: number, history: KeyHistory = NO_KEYS) => ({
  policy_version: version,
  issued_at: issuedAt,
  provenance_keys: history.provenance_keys,
  logs: [{ kind: "private", keys: history.log_keys }],
  devices: [],
  required_tiers: {
    release: "reproduced",
    package: "platform",
    image: "platform",
    "pr-artifact": "platform",
    preview: "platform",
    verdict: "device-signed",
  },
  slsa_build_levels: { cloud: 3, "attested-dedicated": 2, "managed-workstation": 1 },
});

/** The operator's envelope; the policy root key's signature is the verifier's to check, never the control plane's. */
const envelope = (p: object) => ({
  payloadType: POLICY_PAYLOAD_TYPE,
  payload: Buffer.from(JSON.stringify(p)).toString("base64"),
  signatures: [{ keyid: "policy-root", sig: "MEUCIQ==" }],
});

const publish = async (body: object, on: Stack = stack) =>
  fetch(`${on.url}/v1/provenance-policy`, {
    method: "PUT",
    headers: { "content-type": "application/json", ...(await on.access(OPERATOR)) },
    body: JSON.stringify({ envelope: body }),
  });

const get = (query = "", on: Stack = stack) => fetch(`${on.url}${POLICY_PATH}${query}`);

const keyHistory = async (on: Stack): Promise<KeyHistory> => {
  const answer = await fetch(`${on.url}/v1/provenance-policy/key-history`, {
    headers: await on.access(OPERATOR),
  });
  expect(answer.status).toBe(200);
  return (await answer.json()) as KeyHistory;
};

/** A private ES256 JWK with its `kid`, as the `PROVENANCE_KEY` and `LOG_KEY` secrets hold it. */
const secretKey = (kid: string) =>
  JSON.stringify({
    ...generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ format: "jwk" }),
    kid,
  });

describe("the verification policy route", () => {
  it("[FD-PROV-044] serves the current policy at the well-known path and every earlier version by its policy_version", async () => {
    expect((await get()).status).toBe(404);
    const first = envelope(policy("2026-11-01", Date.UTC(2026, 10, 1)));
    const second = envelope(policy("2026-11-12", Date.UTC(2026, 10, 12)));
    const published = await publish(first);
    expect(published.status).toBe(200);
    expect(await published.json()).toMatchObject({ policy_version: "2026-11-01", log_index: 0 });
    expect(await (await get()).json()).toEqual(first);
    const next = await publish(second);
    expect(await next.json()).toMatchObject({ policy_version: "2026-11-12", log_index: 1 });

    const current = await get();
    expect(current.status).toBe(200);
    expect(await current.json()).toEqual(second);
    expect(await (await get("?policy_version=2026-11-01")).json()).toEqual(first);
    expect(await (await get("?policy_version=2026-11-12")).json()).toEqual(second);
    expect((await get("?policy_version=2025-01-01")).status).toBe(404);

    // Each served version is a leaf of the private log in R2.
    const bucket = await stack.mf.getR2Bucket("CACHE");
    const leaves = await Promise.all(
      ["tlog/private/leaf/000", "tlog/private/leaf/001"].map(async (key) =>
        JSON.parse((await (await bucket.get(key))!.text()) as string),
      ),
    );
    expect(leaves).toEqual([first, second]);
  });
});

describe("the verification policy on a deploy holding a provenance key and a log key", () => {
  let keyed: Stack;

  beforeAll(async () => {
    keyed = await startStack({
      secrets: { PROVENANCE_KEY: secretKey("prov-e2e"), LOG_KEY: secretKey("log-e2e") },
    });
  });

  afterAll(async () => {
    await keyed?.close();
  });

  it("[FD-PROV-047] publishes a version whose key history the operator builds from the refusal and the key-history route", async () => {
    expect(await keyHistory(keyed)).toEqual(NO_KEYS);
    const refused = await publish(envelope(policy("2026-11-12", Date.UTC(2026, 10, 12))), keyed);
    expect(refused.status).toBe(400);
    const message = String(((await refused.json()) as { message: unknown }).message);
    expect(message).toContain("drops key prov-e2e");
    expect(message).toContain("drops key log-e2e");

    const recorded = await keyHistory(keyed);
    expect(recorded.provenance_keys).toMatchObject([{ kid: "prov-e2e" }]);
    expect(recorded.log_keys).toMatchObject([{ kid: "log-e2e" }]);
    const signed = envelope(policy("2026-11-12", Date.UTC(2026, 10, 12), recorded));
    const published = await publish(signed, keyed);
    expect(published.status).toBe(200);
    expect(await published.json()).toMatchObject({ policy_version: "2026-11-12", log_index: 0 });
    expect(await (await get("", keyed)).json()).toEqual(signed);
  });
});
