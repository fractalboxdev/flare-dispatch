// The device extension process: `fd-device-extension <plane id> <L1 directory>`, started by mameko's device executor
// with its end of a socketpair as file descriptor 3 (MAMEKO-EXEC-140).
import { mkdirSync } from "node:fs";
import net from "node:net";
import { EXTENSION_FD } from "@fractalboxdev/mameko-protocol";
import { answerLine, hello, type ExtensionState } from "./extension.ts";
import { DEFAULT_L1_SHARE, freeDiskBytes, L1 } from "./l1.ts";

const [planeId, l1Root] = process.argv.slice(2);
if (planeId === undefined || l1Root === undefined) {
  process.stderr.write("usage: fd-device-extension <plane id> <L1 directory>\n");
  process.exit(64);
}

const share = Number(process.env["FD_L1_SHARE"] ?? DEFAULT_L1_SHARE);
mkdirSync(l1Root, { recursive: true });
const state: ExtensionState = {
  planeId,
  l1: new L1(l1Root, Math.floor(freeDiskBytes(l1Root) * share)),
  content: new Map(),
  readable: new Set(),
  writable: new Set(),
};

const socket = new net.Socket({ fd: EXTENSION_FD, readable: true, writable: true });
const send = (message: unknown) => socket.write(`${JSON.stringify(message)}\n`);
send(hello(planeId));

let buffer = "";
socket.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
    const reply = answerLine(state, buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    if (reply !== null) send(reply);
  }
});
socket.on("end", () => process.exit(0));
