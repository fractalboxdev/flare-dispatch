// The peer endpoint and its HTTP client on the loopback address, with WhoIs replaced by a fixed member map; the
// two-process path over the extension's own entry point is the e2e-local suite's.
import { createHash } from "node:crypto";
import { es256Sign, signedBody, type Manifest } from "@fractalboxdev/flare-dispatch-cache";
import { memoryDisk, openL1, type L2Entry } from "@fractalboxdev/flare-dispatch-cache/device";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { absentL2 } from "./extension.ts";
import {
  decodePeerCacheConfig,
  httpPeer,
  PEER_CACHE_PATH,
  startPeerServer,
  tailscaleWhois,
  type PeerServer,
} from "./peer-cache.ts";

const NS = "protected/o/r/device";
const key = (n: number) => n.toString(16).padStart(64, "0");
const utf8 = (t: string) => new TextEncoder().encode(t);
const text = (b: Uint8Array | null | undefined) => (b == null ? null : new TextDecoder().decode(b));

const signer = async () => {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const publicJwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  return { privateKey: pair.privateKey, keys: { controlPlane: publicJwk, device: () => null } };
};

const entry = async (privateKey: CryptoKey, k: string, body: Uint8Array): Promise<L2Entry> => {
  const path = `cache/${NS}/${k}/e.1/blob`;
  const unsigned = {
    key: k,
    namespace: NS,
    tier: "protected-device" as const,
    writer: { executor_id: "cf-1", executor_kind: "cloudflare", execution_id: "e", epoch: 1 },
    objects: [{ path, size: body.byteLength, sha256: createHash("sha256").update(body).digest("hex") }],
    created_at: 0,
  };
  const manifest: Manifest = {
    ...unsigned,
    signature: { alg: "ES256", key_id: "control-plane", value: await es256Sign(privateKey, signedBody(unsigned)) },
  };
  return { manifest, objects: new Map([[path, body]]) };
};

const servers: PeerServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

describe("peer cache endpoint", async () => {
  const cp = await signer();
  const serving = async (identify: (address: string) => Promise<string | null>) => {
    const l1 = await openL1({ disk: memoryDisk(1_000_000), l2: absentL2, keys: cp.keys });
    const server = await startPeerServer({ l1, member: "alice", identify, host: "127.0.0.1", port: 0 });
    servers.push(server);
    return { l1, url: `http://127.0.0.1:${server.port}` };
  };

  it("[FD-CACHE-014] serves a verified L1 entry with its manifest, and the fetching L1 places it only once it verifies", async () => {
    const a = await serving(async () => "alice");
    const good = await entry(cp.privateKey, key(1), utf8("compiled"));
    expect(await Effect.runPromise(a.l1.place(good))).toBe(true);
    await Effect.runPromise(a.l1.put(NS, key(2), utf8("put-only")));

    const peer = httpPeer("alice", a.url);
    expect((await peer.fetch(NS, key(1)))?.manifest).toEqual(good.manifest);
    // An entry without a manifest is not served, so it never reaches a peer unverifiable.
    expect(await peer.fetch(NS, key(2))).toBeNull();
    expect(await peer.fetch(NS, key(3))).toBeNull();

    const b = await openL1({
      disk: memoryDisk(1_000_000),
      l2: absentL2,
      keys: cp.keys,
      peerCache: { enabled: true, member: "alice", peers: [peer] },
    });
    expect(text(await Effect.runPromise(b.get(NS, key(1))))).toBe("compiled");
    expect(text(await Effect.runPromise(b.peek(NS, key(1))))).toBe("compiled");

    // Under another control-plane key the same bytes do not verify, and nothing is placed.
    const other = await signer();
    const c = await openL1({
      disk: memoryDisk(1_000_000),
      l2: absentL2,
      keys: other.keys,
      peerCache: { enabled: true, member: "alice", peers: [peer] },
    });
    expect(await Effect.runPromise(c.get(NS, key(1)))).toBeNull();
    expect(c.usage().entries).toBe(0);
  });

  it("[FD-CACHE-014] answers only the devices of its own member", async () => {
    const good = await entry(cp.privateKey, key(1), utf8("compiled"));
    const other = await serving(async () => "mallory");
    await Effect.runPromise(other.l1.place(good));
    const forbidden = await fetch(`${other.url}${PEER_CACHE_PATH}?namespace=${encodeURIComponent(NS)}&key=${key(1)}`);
    expect(forbidden.status).toBe(403);
    expect(await httpPeer("alice", other.url).fetch(NS, key(1))).toBeNull();

    const unknown = await serving(async () => null);
    await Effect.runPromise(unknown.l1.place(good));
    await expect(fetch(`${unknown.url}${PEER_CACHE_PATH}?namespace=${encodeURIComponent(NS)}&key=${key(1)}`)).rejects.toThrow();
  });

  it("[FD-CACHE-014] identifies a peer by the login WhoIs names, and a tagged node as no member", async () => {
    const whois = (answer: unknown) =>
      tailscaleWhois([process.execPath, "-e", `process.stdout.write(${JSON.stringify(JSON.stringify(answer))})`]);
    expect(await whois({ Node: {}, UserProfile: { LoginName: "alice@example.com" } })("::ffff:100.64.0.2")).toBe(
      "alice@example.com",
    );
    expect(
      await whois({ Node: { Tags: ["tag:ci"] }, UserProfile: { LoginName: "tagged-devices" } })("100.64.0.3"),
    ).toBeNull();
    expect(await tailscaleWhois([process.execPath, "-e", "process.exit(1)"])("100.64.0.4")).toBeNull();
    expect(await whois({ Node: {}, UserProfile: { LoginName: "alice" } })("")).toBeNull();
  });

  it("decodes the peer-cache setting and refuses one without keys", () => {
    const setting = {
      enabled: true,
      member: "alice",
      listen: { host: "100.64.0.1", port: 7491 },
      peers: [{ member: "alice", url: "http://100.64.0.2:7491" }],
      keys: { control_plane: { kty: "EC", crv: "P-256", x: "x", y: "y" }, devices: {} },
    };
    expect(decodePeerCacheConfig(JSON.stringify(setting))._tag).toBe("Some");
    expect(decodePeerCacheConfig(JSON.stringify({ ...setting, keys: undefined }))._tag).toBe("None");
  });
});
