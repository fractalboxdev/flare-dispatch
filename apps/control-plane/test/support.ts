// The test's own Access team: an RS256 key, its JWKS served on a local port at Access's certs path, and JWTs for an
// identity. The Worker verifies them exactly as it verifies Cloudflare Access's.
import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { connectMessage, CONNECT_HEADERS } from "@fractalboxdev/mameko-coordinator";
import { makeSigner } from "@fractalboxdev/flare-dispatch-api/test-support";
import type { Miniflare } from "miniflare";

export const PLANE = "flare-dispatch";
export const AUD = "control-plane-test";
export const OPERATOR = "operator@example.com";

export interface AccessTeam {
  readonly teamDomain: string;
  readonly jwt: (email: string) => Promise<string>;
  readonly close: () => Promise<void>;
}

export const startAccessTeam = async (): Promise<AccessTeam> => {
  const signer = await makeSigner("control-plane-test");
  const server: Server = createServer((req, res) => {
    if (req.url === "/cdn-cgi/access/certs") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ keys: [signer.jwk] }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const teamDomain = `http://127.0.0.1:${port}`;
  return {
    teamDomain,
    jwt: (email) => {
      const now = Math.floor(Date.now() / 1000);
      return signer.sign({ iss: teamDomain, aud: [AUD], email, iat: now, exp: now + 600 });
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
};

type Keys = { readonly publicKey: CryptoKey; readonly privateKey: CryptoKey };

const base64 = (bytes: ArrayBuffer | Uint8Array) =>
  Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString("base64");

export const newDevice = async () => {
  const keys = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as Keys;
  return {
    keys,
    identity: {
      public_key: base64((await crypto.subtle.exportKey("spki", keys.publicKey)) as ArrayBuffer),
      key_store: "software",
      certificate_chain: [],
      evidence: null,
    },
  };
};

/** A device's registration; a host-process device advertises `isolation:none` (MAMEKO-LEASE-084). */
export const registration = (
  executorId: string,
  identity: unknown,
  labels: readonly string[] = ["isolation:none"],
) => ({
  executor_id: executorId,
  identity,
  labels,
  protocol_version: "1",
  code_hash: null,
});

/** A device's signed upgrade: the connect signature `routeExecutorUpgrade` verifies. */
export const connect = async (mf: Miniflare, executorId: string, keys: Keys) => {
  const path = "/v1/executors/connect";
  const nonce = randomBytes(32).toString("hex");
  const at = Date.now();
  const message = await connectMessage({
    method: "GET",
    path,
    executorId,
    planeId: PLANE,
    connectAt: at,
    nonce,
  });
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    keys.privateKey,
    new Uint8Array(message),
  );
  const response = await mf.dispatchFetch(`http://x${path}`, {
    headers: {
      Upgrade: "websocket",
      [CONNECT_HEADERS.executorId]: executorId,
      [CONNECT_HEADERS.at]: String(at),
      [CONNECT_HEADERS.nonce]: nonce,
      [CONNECT_HEADERS.signature]: base64(signature),
    },
  });
  const ws = response.webSocket;
  if (ws === null || ws === undefined) throw new Error(`no socket: ${response.status}`);
  const frames: Record<string, unknown>[] = [];
  ws.accept();
  ws.addEventListener("message", (e) => void frames.push(JSON.parse(String(e.data))));
  return {
    send: (m: unknown) => ws.send(JSON.stringify(m)),
    next: async (type: string) => {
      for (let i = 0; i < 1000; i++) {
        const frame = frames.find((f) => f["type"] === type);
        if (frame !== undefined) {
          frames.splice(frames.indexOf(frame), 1);
          return frame;
        }
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(`no ${type}; received ${JSON.stringify(frames)}`);
    },
  };
};
export type Socket = Awaited<ReturnType<typeof connect>>;

export const hello = (executorId: string) => ({
  type: "session.hello",
  id: "h1",
  executor_id: executorId,
  plane_id: PLANE,
  boot_id: "b",
  executor_version: "t",
  versions: { min: 1, max: 1 },
  held: [],
  capacity: null,
  in_use: {},
  outbox_depth: 0,
});

/** A heartbeat ends a device's standing claim, so a later test's dispatch wakes only that test's device. */
export const endStandingClaim = async (socket: Socket) => {
  socket.send({
    type: "exec.heartbeat",
    id: "hb1",
    leases: [],
    in_use: {},
    activity: "unknown",
    memory_pressure: "unknown",
    thermal: "unknown",
    power: "unknown",
    free_disk_bytes: 0,
    teardowns: [],
  });
  await socket.next("exec.heartbeat.ack");
};
