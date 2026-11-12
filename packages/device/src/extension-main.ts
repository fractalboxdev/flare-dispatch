// The device extension process: `fd-device-extension <plane id> <L1 directory>`, started by mameko's device executor
// with its end of a socketpair as file descriptor 3 (MAMEKO-EXEC-140). L1 is the cache package's, on the directory
// named; L2 is `absentL2` until the extension holds a presigned-URL transport under its lease.
import net from "node:net";
import { nodeDisk, openL1 } from "@fractalboxdev/flare-dispatch-cache/device";
import { EXTENSION_FD } from "@fractalboxdev/mameko-protocol";
import { Effect } from "effect";
import { absentL2, answerLine, DEFAULT_L1_SHARE, hello, type ExtensionState } from "./extension.ts";

const [planeId, l1Root] = process.argv.slice(2);
if (planeId === undefined || l1Root === undefined) {
  process.stderr.write("usage: fd-device-extension <plane id> <L1 directory>\n");
  process.exit(64);
}

const state: ExtensionState = {
  planeId,
  l1: await openL1({
    disk: nodeDisk(l1Root),
    l2: absentL2,
    // No L2 entry reaches this L1, so no signature is checked: a manifest verifies against no key.
    keys: { controlPlane: { kty: "EC" }, device: () => null },
    share: Number(process.env["FD_L1_SHARE"] ?? DEFAULT_L1_SHARE),
  }),
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
