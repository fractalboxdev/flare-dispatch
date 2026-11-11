// The executor connect route of the deployed Worker: a device's upgrade on `/v1/executors/connect` passes to mameko's
// executor route with the plane id the operator overlay sets as `executors.planeId`, and no credential other than the
// connect signature by the enrolled device key opens a session.
import { CONNECT_HEADERS } from "@fractalboxdev/mameko-coordinator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect, hello, newDevice, OPERATOR, PLANE, registration } from "../support.ts";
import { OIDC_AUDIENCE, PLANE_ID, REPOSITORY, startStack, type Stack } from "./stack.ts";

let stack: Stack;

beforeAll(async () => {
  stack = await startStack();
});

afterAll(async () => {
  await stack?.close();
});

const enroll = async (executorId: string) => {
  const device = await newDevice();
  const r = await fetch(`${stack.url}/v1/executors/register`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(await stack.access(OPERATOR)) },
    body: JSON.stringify(registration(executorId, device.identity)),
  });
  expect(r.status).toBe(201);
  return device;
};

/** An upgrade on the connect route carrying `headers` and no connect signature. */
const unsignedUpgrade = (headers: Record<string, string>) =>
  stack.mf.dispatchFetch("http://x/v1/executors/connect", {
    headers: { Upgrade: "websocket", ...headers },
  });

describe("the executor connect route", () => {
  it("[FD-IFC-085] binds every connect signature to the overlay's executors.planeId", async () => {
    expect(stack.overlay.executors?.planeId).toBe(PLANE_ID);
    expect(PLANE_ID).not.toBe(PLANE);
    // The rendered configuration carries the overlay's plane id, and the Worker reports it.
    expect(stack.config.vars["PLANE_ID"]).toBe(PLANE_ID);
    expect(await (await fetch(`${stack.url}/health`)).json()).toMatchObject({ plane_id: PLANE_ID });

    const device = await enroll("plane-device");
    const socket = await connect(stack.mf, "plane-device", device.keys, PLANE_ID);
    socket.send(hello("plane-device", PLANE_ID));
    expect(await socket.next("session.welcome")).toMatchObject({ type: "session.welcome" });

    // The same device key signing for another plane opens nothing.
    await expect(connect(stack.mf, "plane-device", device.keys, PLANE)).rejects.toThrow(
      /no socket: 40[13]/,
    );
  });

  it("[FD-IFC-085] accepts no device credential other than the connect signature", async () => {
    await enroll("credential-device");
    const access = await stack.access(OPERATOR);
    const oidc = await stack.github.oidcToken(
      { repository: REPOSITORY, sha: "9".repeat(40) },
      OIDC_AUDIENCE,
    );
    for (const headers of [
      {},
      access,
      { authorization: `Bearer ${oidc}` },
      { ...access, [CONNECT_HEADERS.executorId]: "credential-device" },
    ]) {
      const r = await unsignedUpgrade(headers);
      expect(r.webSocket ?? null).toBeNull();
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect(r.status).toBeLessThan(500);
    }
    // A key other than the enrolled one, signing for the right plane, opens nothing either.
    const stranger = await newDevice();
    await expect(connect(stack.mf, "credential-device", stranger.keys, PLANE_ID)).rejects.toThrow(
      /no socket: 40[13]/,
    );
  });
});
