// The verification policy over the deployed Worker: an operator publishes two versions with `PUT /v1/provenance-policy`,
// each is appended to the private log the `TransparencyLog` object writes to R2, and the well-known path serves the
// current version to a caller with no identity and an earlier one by its `policy_version`.
import { POLICY_PAYLOAD_TYPE } from "@fractalboxdev/flare-dispatch-cache/provenance-policy";
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

const policy = (version: string, issuedAt: number) => ({
  policy_version: version,
  issued_at: issuedAt,
  provenance_keys: [],
  logs: [{ kind: "private", keys: [] }],
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

const publish = async (body: object) =>
  fetch(`${stack.url}/v1/provenance-policy`, {
    method: "PUT",
    headers: { "content-type": "application/json", ...(await stack.access(OPERATOR)) },
    body: JSON.stringify({ envelope: body }),
  });

const get = (query = "") => fetch(`${stack.url}${POLICY_PATH}${query}`);

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
