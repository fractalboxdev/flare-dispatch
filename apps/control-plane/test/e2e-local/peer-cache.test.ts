// Peer cache between two devices of one member (specs/cache-artifacts.md FD-CACHE-014): two device extension processes,
// each started from `packages/device/src/extension-main.ts` on its own L1 directory with the extension interface on
// file descriptor 3, the second listing the first as a peer of the same member. WhoIs is a fixed answer naming that
// member, since both processes listen on the loopback address rather than a Tailscale one. The first device's L1
// holds entries a cloud executor committed, placed through L1's own verification; the test then tampers with one
// entry's bytes and another's manifest on that disk, so the first device serves them as they are.
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { es256Sign, signedBody, type Manifest } from "@fractalboxdev/flare-dispatch-cache";
import { nodeDisk, openL1, type L2Entry } from "@fractalboxdev/flare-dispatch-cache/device";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const EXTENSION_MAIN = join(
  import.meta.dirname,
  "../../../../packages/device/src/extension-main.ts",
);
const MEMBER = "alice@example.com";
const NAMESPACE = "protected/acme/widgets/device";
const key = (n: number) => n.toString(16).padStart(64, "0");
const GOOD = key(1);
const TAMPERED_BYTES = key(2);
const TAMPERED_MANIFEST = key(3);
const b64 = (text: string) => Buffer.from(text).toString("base64");
const WHOIS = [
  process.execPath,
  "-e",
  `process.stdout.write(${JSON.stringify(JSON.stringify({ Node: {}, UserProfile: { LoginName: MEMBER } }))})`,
];

let root: string;
let publicJwk: JsonWebKey;
let privateKey: CryptoKey;
const children: ChildProcess[] = [];

/** An entry a cloud executor committed: one object under a manifest the control plane signed. */
const committed = async (k: string, body: string): Promise<L2Entry> => {
  const bytes = new TextEncoder().encode(body);
  const path = `cache/${NAMESPACE}/${k}/01JDZ8Q6V3M2K9T4WXYZ5ABCDE.1/blob`;
  const unsigned = {
    key: k,
    namespace: NAMESPACE,
    tier: "protected-device" as const,
    writer: {
      executor_id: "cf-1",
      executor_kind: "cloudflare",
      execution_id: "01JDZ8Q6V3M2K9T4WXYZ5ABCDE",
      epoch: 1,
    },
    objects: [{ path, size: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") }],
    created_at: 1_700_000_000_000,
  };
  const manifest: Manifest = {
    ...unsigned,
    signature: {
      alg: "ES256",
      key_id: "control-plane",
      value: await es256Sign(privateKey, signedBody(unsigned)),
    },
  };
  return { manifest, objects: new Map([[path, bytes]]) };
};

/** A connected pair of sockets over a Unix socket. */
const socketPair = (dir: string): Promise<[net.Socket, net.Socket]> =>
  new Promise((ok) => {
    let client: net.Socket;
    const server = net.createServer((accepted) => {
      server.close();
      ok([client, accepted]);
    });
    server.listen(join(dir, "pair.sock"), () => {
      client = net.createConnection(join(dir, "pair.sock"));
    });
  });

const lines = (stream: NodeJS.ReadableStream) => {
  let buffer = "";
  const waiting: ((line: string) => void)[] = [];
  const ready: string[] = [];
  stream.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      const w = waiting.shift();
      if (w === undefined) ready.push(line);
      else w(line);
    }
  });
  return () =>
    new Promise<string>((ok) => {
      const line = ready.shift();
      if (line === undefined) waiting.push(ok);
      else ok(line);
    });
};

interface Device {
  readonly l1: string;
  /** The peer endpoint's port on the loopback address. */
  readonly port: number;
  readonly request: (message: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

/** Starts one device extension process on `l1` with the peer-cache setting given. */
const startDevice = async (
  name: string,
  l1: string,
  peers: readonly { readonly member: string; readonly url: string }[],
): Promise<Device> => {
  const dir = mkdtempSync(join(root, `${name}-`));
  const setting = join(dir, "peer-cache.json");
  writeFileSync(
    setting,
    JSON.stringify({
      enabled: true,
      member: MEMBER,
      listen: { host: "127.0.0.1", port: 0 },
      peers,
      keys: { control_plane: publicJwk, devices: {} },
      whois: WHOIS,
    }),
  );
  const [ours, theirs] = await socketPair(dir);
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", "--no-warnings", EXTENSION_MAIN, `plane-${name}`, l1],
    { stdio: ["ignore", "inherit", "pipe", theirs], env: { ...process.env, FD_PEER_CACHE: setting } },
  );
  children.push(child);
  const stderr = lines(child.stderr!);
  const listening = /peer cache on 127\.0\.0\.1:(\d+)$/.exec(await stderr());
  expect(listening).not.toBeNull();
  const next = lines(ours);
  expect(JSON.parse(await next())).toMatchObject({ type: "extension.hello", plane_id: `plane-${name}` });
  return {
    l1,
    port: Number(listening![1]),
    request: async (message) => {
      ours.write(`${JSON.stringify(message)}\n`);
      return JSON.parse(await next()) as Record<string, unknown>;
    },
  };
};

const lease = (read: string[]) => ({
  type: "proxies",
  id: "lease",
  lease: { execution_id: "01JDZ8Q6V3M2K9T4WXYZ5ABCDF", cache_namespaces: { read, write: null } },
});

/** The files of an L1 directory under the namespace. */
const stored = (l1: string) => {
  const dir = join(l1, NAMESPACE);
  return existsSync(dir) ? readdirSync(dir).sort() : [];
};

let first: Device;
let second: Device;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "fd-e2e-peer-cache-"));
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  privateKey = pair.privateKey;
  publicJwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;

  // The first device's L1 holds three committed entries, each placed after L1 verified it.
  const firstL1 = join(root, "first-l1");
  const seeded = await openL1({
    disk: nodeDisk(firstL1),
    l2: { fetch: async () => null, upload: async () => {} },
    keys: { controlPlane: publicJwk, device: () => null },
  });
  for (const [k, body] of [
    [GOOD, "good entry"],
    [TAMPERED_BYTES, "honest bytes"],
    [TAMPERED_MANIFEST, "honest manifest"],
  ] as const)
    expect(await Effect.runPromise(seeded.place(await committed(k, body)))).toBe(true);
  // Tampering on the first device's disk: one entry's bytes (same length, so only the digest catches it) and
  // another's manifest (its recorded time, so only the signature catches it).
  writeFileSync(join(firstL1, NAMESPACE, TAMPERED_BYTES), "hacked bytes");
  const manifestFile = join(firstL1, NAMESPACE, `${TAMPERED_MANIFEST}.manifest.json`);
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as Manifest;
  writeFileSync(manifestFile, JSON.stringify({ ...manifest, created_at: manifest.created_at + 1 }));

  first = await startDevice("first", firstL1, []);
  second = await startDevice("second", join(root, "second-l1"), [
    { member: MEMBER, url: `http://127.0.0.1:${first.port}` },
  ]);
  expect(await second.request(lease([NAMESPACE]))).toMatchObject({ type: "proxies.ok" });
});

afterAll(() => {
  for (const child of children) child.kill();
  rmSync(root, { recursive: true, force: true });
});

describe("peer cache between two device extensions of one member", () => {
  it("[FD-CACHE-014] a miss is fetched from the peer over its endpoint and placed once its signature and digests verify", async () => {
    expect(stored(second.l1)).toEqual([]);
    expect(
      await second.request({ type: "cache.get", id: "g1", namespace: NAMESPACE, key: GOOD }),
    ).toMatchObject({ type: "cache.get.ok", ref: "g1", bytes: b64("good entry") });
    // Placed in the second device's own L1 with the manifest it verified, so a third device can verify it in turn.
    expect(stored(second.l1)).toEqual([GOOD, `${GOOD}.manifest.json`]);
    expect(readFileSync(join(second.l1, NAMESPACE, GOOD), "utf8")).toBe("good entry");
  });

  it("[FD-CACHE-014] a peer entry with tampered bytes or a tampered manifest is refused and never placed", async () => {
    for (const [id, k] of [
      ["g2", TAMPERED_BYTES],
      ["g3", TAMPERED_MANIFEST],
    ] as const)
      expect(
        await second.request({ type: "cache.get", id, namespace: NAMESPACE, key: k }),
      ).toMatchObject({ type: "cache.get.ok", ref: id, bytes: null });
    expect(stored(second.l1)).toEqual([GOOD, `${GOOD}.manifest.json`]);
    // The first device serves what its disk holds: the tampering reached the second device and was refused there.
    const served = await fetch(
      `http://127.0.0.1:${first.port}/v1/peer-cache?namespace=${encodeURIComponent(NAMESPACE)}&key=${TAMPERED_BYTES}`,
    );
    expect(served.status).toBe(200);
    expect(await served.text()).toBe("hacked bytes");
  });

  it("[FD-CACHE-014] a device fetches nothing from a peer listed under another member", async () => {
    const third = await startDevice("third", join(root, "third-l1"), [
      { member: "bob@example.com", url: `http://127.0.0.1:${first.port}` },
    ]);
    expect(await third.request(lease([NAMESPACE]))).toMatchObject({ type: "proxies.ok" });
    expect(
      await third.request({ type: "cache.get", id: "g4", namespace: NAMESPACE, key: GOOD }),
    ).toMatchObject({ type: "cache.get.ok", ref: "g4", bytes: null });
    expect(stored(third.l1)).toEqual([]);
  });
});
