// The device extension process: `fd-device-extension <plane id> <L1 directory>`, started by mameko's device executor
// with its end of a socketpair as file descriptor 3 (MAMEKO-EXEC-155). L1 is the cache package's, on the directory
// named; L2 is `absentL2` until the extension holds a presigned-URL transport under its lease. Where the JSON file
// `FD_PEER_CACHE` names enables peer cache, the extension serves its L1 entries to the devices of its member on the
// address the file names and fetches a miss from the peers it lists (FD-CACHE-014).
import { readFileSync } from "node:fs";
import net from "node:net";
import { nodeDisk, openL1, type L1Cache } from "@fractalboxdev/flare-dispatch-cache/device";
import { EXTENSION_FD } from "@fractalboxdev/mameko-protocol";
import { Effect, Option } from "effect";
import { absentL2, answerLine, DEFAULT_L1_SHARE, hello, type ExtensionState } from "./extension.ts";
import {
  decodePeerCacheConfig,
  httpPeer,
  startPeerServer,
  tailscaleWhois,
  TAILSCALE_WHOIS,
} from "./peer-cache.ts";

const [planeId, l1Root] = process.argv.slice(2);
if (planeId === undefined || l1Root === undefined) {
  process.stderr.write("usage: fd-device-extension <plane id> <L1 directory>\n");
  process.exit(64);
}

const peerCachePath = process.env["FD_PEER_CACHE"];
const peerCache =
  peerCachePath === undefined
    ? undefined
    : Option.getOrUndefined(decodePeerCacheConfig(readFileSync(peerCachePath, "utf8")));
if (peerCachePath !== undefined && peerCache === undefined) {
  process.stderr.write(`fd-device-extension: ${peerCachePath} is not a peer-cache setting\n`);
  process.exit(78);
}
const peers = peerCache?.enabled === true ? peerCache : undefined;

const l1: L1Cache = await openL1({
  disk: nodeDisk(l1Root),
  l2: absentL2,
  // Without peer cache no verified entry reaches this L1, and a manifest verifies against no key.
  keys:
    peers === undefined
      ? { controlPlane: { kty: "EC" }, device: () => null }
      : { controlPlane: peers.keys.control_plane, device: (id) => peers.keys.devices[id] ?? null },
  share: Number(process.env["FD_L1_SHARE"] ?? DEFAULT_L1_SHARE),
  ...(peers === undefined
    ? {}
    : {
        peerCache: {
          enabled: true,
          member: peers.member,
          peers: peers.peers.map((p) => httpPeer(p.member, p.url)),
        },
      }),
});

if (peers !== undefined) {
  const server = await startPeerServer({
    l1,
    member: peers.member,
    identify: tailscaleWhois(peers.whois ?? TAILSCALE_WHOIS),
    host: peers.listen.host,
    port: peers.listen.port,
  });
  process.stderr.write(`fd-device-extension: peer cache on ${peers.listen.host}:${server.port}\n`);
}

const state: ExtensionState = {
  planeId,
  l1,
  content: new Map(),
  readable: new Set(),
  writable: new Set(),
};

const socket = new net.Socket({ fd: EXTENSION_FD, readable: true, writable: true });
const send = (message: unknown) => socket.write(`${JSON.stringify(message)}\n`);
send(hello(planeId));

// Lines are answered one at a time, in the order they arrive, so L1's index sees one operation at a time.
let pending: Promise<void> = Promise.resolve();
let buffer = "";
socket.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
    const line = buffer.slice(0, end);
    buffer = buffer.slice(end + 1);
    pending = pending.then(async () => {
      const reply = await Effect.runPromise(answerLine(state, line));
      if (reply !== null) send(reply);
    });
  }
});
socket.on("end", () => void pending.then(() => process.exit(0)));
