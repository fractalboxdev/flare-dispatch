// The device extension: the plane's process beside the device executor, speaking the extension line protocol on file
// descriptor 3 (MAMEKO-EXEC-130). It holds `LocalContent` in memory, per scope, for the executor's lifetime.
import { createHash } from "node:crypto";
import net from "node:net";

const VERSION = 1;

const [planeId] = process.argv.slice(2);
if (planeId === undefined) {
  process.stderr.write("usage: device-extension <plane id>\n");
  process.exit(64);
}

const socket = new net.Socket({ fd: 3, readable: true, writable: true });
const store = new Map<string, string>();
const send = (message: unknown) => socket.write(`${JSON.stringify(message)}\n`);

send({
  type: "extension.hello",
  id: "hello",
  plane_id: planeId,
  version: VERSION,
  operations: ["content.put", "content.get"],
});

interface Request {
  readonly type: string;
  readonly id: string;
  readonly scope_id: string;
  readonly bytes: string;
  readonly digest: string;
}

const answer = (m: Request) => {
  if (m.type === "content.put") {
    const digest = `sha256:${createHash("sha256").update(Buffer.from(m.bytes, "base64")).digest("hex")}`;
    store.set(`${m.scope_id}/${digest}`, m.bytes);
    return send({ type: "content.put.ok", id: `put-${m.id}`, ref: m.id, digest });
  }
  if (m.type === "content.get")
    return send({
      type: "content.get.ok",
      id: `get-${m.id}`,
      ref: m.id,
      bytes: store.get(`${m.scope_id}/${m.digest}`) ?? null,
    });
};

let buffer = "";
socket.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
    const message = JSON.parse(buffer.slice(0, end)) as Request;
    buffer = buffer.slice(end + 1);
    answer(message);
  }
});
socket.on("end", () => process.exit(0));
