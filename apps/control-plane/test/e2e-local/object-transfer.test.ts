// Where an execution's bytes go, end to end on one machine: a device claims a pull request execution's lease from the
// deployed Worker, which holds the object-store presign token, then saves a cache object, uploads an artifact and uploads
// a log segment, each through URLs it asks the executor channel for. R2's S3 endpoint is a stand-in on a local port
// that checks each request's SigV4 signature under the presign token and keeps the bytes; the device reaches it as
// `curl --resolve` would, so each request keeps the presigned URL's host. The Worker's own route for bytes is the
// compile-cache route, which streams an object of at most 100 MiB into its bucket (specs/architecture.md FD-ARCH-007).
import { createHash, createHmac } from "node:crypto";
import { createServer, request as httpRequest, type Server } from "node:http";
import {
  COMPILE_CACHE_PREFIX,
  compileObjectKey,
  DEFAULT_MAX_COMPILE_OBJECT_BYTES,
  logObjectName,
  objectPrefix,
} from "@fractalboxdev/flare-dispatch-cache";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect, hello, newDevice, OPERATOR, registration, type Socket } from "../support.ts";
import { PLANE_ID, REPOSITORY, startStack, WEBHOOK_SECRET, type Stack } from "./stack.ts";

const MiB = 1024 * 1024;
/** The recorded pull request's namespace, which its execution writes (FD-CACHE-019). */
const PR_NAMESPACE = `pr/${REPOSITORY}/7`;
/** The presign token: an R2 API token's S3 access key pair, which the operator sets as Worker secrets. */
const PRESIGN_SECRETS = {
  R2_PRESIGN_ACCESS_KEY_ID: "e2e-presign-access-key",
  R2_PRESIGN_SECRET_ACCESS_KEY: "e2e-presign-secret-access-key",
};

/** One request R2's S3 endpoint stand-in received. */
interface ObjectRequest {
  readonly method: string;
  readonly host: string;
  readonly key: string;
  readonly signatureValid: boolean;
  readonly bytes: number;
}

let stack: Stack;
let r2: Server;
let r2Port: number;
const r2Requests: ObjectRequest[] = [];
/** What the stand-in stored, by object key. */
const r2Objects = new Map<string, Buffer>();
let device: Socket;
let lease: Record<string, unknown>;

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const hmac = (key: string | Buffer, text: string) =>
  createHmac("sha256", key).update(text).digest();
const encode = (text: string) =>
  encodeURIComponent(text).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

/**
 * Whether a presigned request verifies as R2 checks one: the canonical request rebuilt from the request's method, path,
 * query and signed headers, signed under the presign token's secret, and the URL not yet expired.
 */
const verifies = (
  method: string,
  url: URL,
  headers: Readonly<Record<string, string | undefined>>,
) => {
  const q = url.searchParams;
  const signedHeaders = q.get("X-Amz-SignedHeaders")?.split(";") ?? [];
  const amzDate = q.get("X-Amz-Date") ?? "";
  const credential = q.get("X-Amz-Credential")?.split("/") ?? [];
  if (credential[0] !== PRESIGN_SECRETS.R2_PRESIGN_ACCESS_KEY_ID) return false;
  const issued = Date.UTC(
    Number(amzDate.slice(0, 4)),
    Number(amzDate.slice(4, 6)) - 1,
    Number(amzDate.slice(6, 8)),
    Number(amzDate.slice(9, 11)),
    Number(amzDate.slice(11, 13)),
    Number(amzDate.slice(13, 15)),
  );
  if (Date.now() > issued + Number(q.get("X-Amz-Expires")) * 1000) return false;
  const canonicalRequest = [
    method,
    url.pathname,
    [...q]
      .filter(([k]) => k !== "X-Amz-Signature")
      .map(([k, v]) => `${encode(k)}=${encode(v)}`)
      .sort()
      .join("&"),
    signedHeaders.map((h) => `${h}:${headers[h] ?? ""}\n`).join(""),
    signedHeaders.join(";"),
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const scope = credential.slice(1).join("/");
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonicalRequest)].join("\n");
  let key = hmac(`AWS4${PRESIGN_SECRETS.R2_PRESIGN_SECRET_ACCESS_KEY}`, amzDate.slice(0, 8));
  for (const part of credential.slice(2, 5)) key = hmac(key, part);
  return hmac(key, stringToSign).toString("hex") === q.get("X-Amz-Signature");
};

/** R2's S3 endpoint for the deploy's account and bucket: a signed PUT stores its body, anything else is refused. */
const startR2 = async () => {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const host = req.headers.host ?? "";
      const url = new URL(req.url ?? "/", `https://${host}`);
      const body = Buffer.concat(chunks);
      const signatureValid = verifies(req.method ?? "", url, {
        host,
        "content-length": req.headers["content-length"],
      });
      const bucket = `/${stack.config.vars["CACHE_BUCKET_NAME"] as string}/`;
      const key = decodeURIComponent(url.pathname).slice(bucket.length);
      r2Requests.push({ method: req.method ?? "", host, key, signatureValid, bytes: body.length });
      if (!signatureValid || req.method !== "PUT") return res.writeHead(403).end();
      r2Objects.set(key, body);
      res.writeHead(200, { etag: `"${sha256(body)}"` }).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return { server, port: typeof address === "object" && address !== null ? address.port : 0 };
};

/** A PUT of `body` to a presigned URL, sent to the stand-in's address under the URL's own host. */
const putPresigned = (signed: string, body: Buffer) =>
  new Promise<number>((resolve, reject) => {
    const url = new URL(signed);
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: r2Port,
        method: "PUT",
        path: `${url.pathname}${url.search}`,
        headers: { host: url.host, "content-length": String(body.length) },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.end(body);
  });

/**
 * The status of a PUT that declares `declared` bytes and sends only a first chunk of them: the route's answer to the
 * declaration, read before the rest of the body exists, after which the request is abandoned.
 */
const declaredPut = (url: URL, headers: Readonly<Record<string, string>>, declared: number) =>
  new Promise<number>((resolve, reject) => {
    let answered = false;
    const req = httpRequest(
      {
        host: url.hostname,
        port: url.port,
        method: "PUT",
        path: url.pathname,
        headers: { ...headers, "content-length": String(declared) },
      },
      (res) => {
        answered = true;
        resolve(res.statusCode ?? 0);
        res.resume();
        req.destroy();
      },
    );
    req.on("error", (e) => {
      if (!answered) reject(e);
    });
    req.write(Buffer.alloc(64 * 1024));
  });

let presigns = 0;

/** One `exec.presign` for a PUT of `length` bytes at `key`, answered by the channel's `exec.presigned`. */
const presignPut = async (key: string, length: number) => {
  const id = `p${++presigns}`;
  device.send({
    type: "exec.presign",
    id,
    execution_id: lease["execution_id"],
    epoch: lease["epoch"],
    objects: [{ key, method: "PUT", length }],
  });
  const answer = await device.next("exec.presigned");
  expect(answer["ref"]).toBe(id);
  expect(answer["status"], key).toBeUndefined();
  const urls = answer["urls"] as readonly { key: string; url: string }[];
  expect(urls.map((u) => u.key)).toEqual([key]);
  return urls[0]!.url;
};

/** Every object key in the Worker's own `CACHE` bucket. */
const workerBucketKeys = async () =>
  (await (await stack.mf.getR2Bucket("CACHE")).list()).objects.map((o) => o.key).sort();

const bytesOf = (size: number, seed: number) =>
  Buffer.from(Uint8Array.from({ length: size }, (_, i) => (i * 31 + seed) % 251));

beforeAll(async () => {
  stack = await startStack({ publicOrigin: true, secrets: PRESIGN_SECRETS });
  ({ server: r2, port: r2Port } = await startR2());
  const { identity, keys } = await newDevice();
  const enrolled = await fetch(`${stack.url}/v1/executors/register`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(await stack.access(OPERATOR)) },
    body: JSON.stringify(registration("ot-device", identity)),
  });
  expect(enrolled.status).toBe(201);
  device = await connect(stack.mf, "ot-device", keys, PLANE_ID);
  device.send(hello("ot-device", PLANE_ID));
  await device.next("session.welcome");
  const delivery = stack.github.delivery(
    "pull_request",
    "pull_request.opened.json",
    WEBHOOK_SECRET,
  );
  const delivered = await fetch(`${stack.url}/v1/webhooks/github`, {
    method: "POST",
    headers: delivery.headers,
    body: delivery.body,
  });
  expect(delivered.status).toBe(202);
  const { executions } = (await delivered.json()) as { executions: string[] };
  device.send({
    type: "exec.claim",
    id: "c1",
    free: { release: 1, required: 1, interactive: 1, batch: 1 },
  });
  lease = await device.next("exec.lease");
  expect(lease["execution_id"]).toBe(executions[0]);
});

afterAll(async () => {
  await new Promise<void>((resolve) => (r2 === undefined ? resolve() : r2.close(() => resolve())));
  await stack?.close();
});

describe("an execution's bytes on the deployed Worker", () => {
  it("[FD-ARCH-007] go from the executor to R2 through presigned URLs for a cache save, an artifact and a log segment, never through the Worker", async () => {
    const executionId = lease["execution_id"] as string;
    const epoch = lease["epoch"] as number;
    expect(lease["cache_namespaces"]).toMatchObject({ write: PR_NAMESPACE });
    const frontBefore = stack.requests.length;
    const bucketBefore = await workerBucketKeys();

    const uploads = [
      {
        key: `${objectPrefix(PR_NAMESPACE, "a".repeat(64), executionId, epoch)}target.tar.zst`,
        body: bytesOf(3 * MiB, 1),
      },
      { key: `artifact/${executionId}/${epoch}/report.html`, body: bytesOf(512 * 1024, 2) },
      {
        key: (await logObjectName({
          executionId,
          epoch,
          journalName: "test",
          stream: "stdout",
          start: 0,
          end: 64 * 1024,
        }))!,
        body: bytesOf(64 * 1024, 3),
      },
    ];
    for (const u of uploads) {
      const url = await presignPut(u.key, u.body.length);
      expect(new URL(url).host).toBe(
        `${stack.config.vars["R2_ACCOUNT_ID"] as string}.r2.cloudflarestorage.com`,
      );
      expect(await putPresigned(url, u.body)).toBe(200);
    }

    // R2 received each upload once, under its signed URL, with the exact bytes.
    expect(r2Requests.map((r) => [r.method, r.key, r.signatureValid, r.bytes])).toEqual(
      uploads.map((u) => ["PUT", u.key, true, u.body.length]),
    );
    for (const u of uploads) expect(sha256(r2Objects.get(u.key)!)).toBe(sha256(u.body));
    // A signed URL takes no other length: R2 refuses a body that differs from the declared one.
    const again = await presignPut(uploads[1]!.key.replace("report.html", "other.html"), 10);
    expect(await putPresigned(again, Buffer.alloc(11))).toBe(403);

    // The Worker carried none of those bytes: no request reached it, and its bucket holds nothing new.
    expect(stack.requests.slice(frontBefore)).toEqual([]);
    expect(await workerBucketKeys()).toEqual(bucketBefore);
  });

  it("[FD-ARCH-007] the compile-cache route refuses an object over 100 MiB and streams one within the bound into the Worker's bucket", async () => {
    const grant = (lease["upload_grant"] as { compile_cache: { endpoint: string; token: string } })
      .compile_cache;
    expect(grant.endpoint).toBe(`${stack.url}/v1/compile-cache/${REPOSITORY}`);
    const put = (path: string, size: number) => {
      let sent = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent >= size) return controller.close();
          const chunk = new Uint8Array(Math.min(MiB, size - sent)).fill(sent % 251);
          sent += chunk.byteLength;
          controller.enqueue(chunk);
        },
      });
      return fetch(`${grant.endpoint}/${path}`, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${grant.token}`,
          "content-length": String(size),
          "content-type": "application/octet-stream",
        },
        body,
        duplex: "half",
      } as RequestInit);
    };
    const bucket = await stack.mf.getR2Bucket("CACHE");

    const over = await declaredPut(
      new URL(`${grant.endpoint}/arch007/over`),
      { authorization: `Bearer ${grant.token}`, "content-type": "application/octet-stream" },
      DEFAULT_MAX_COMPILE_OBJECT_BYTES + 1,
    );
    expect(over).toBe(413);
    expect(await bucket.head(compileObjectKey(PR_NAMESPACE, "arch007/over"))).toBeNull();

    const within = await put("arch007/within", 16 * MiB);
    expect(within.status).toBe(201);
    const stored = await bucket.head(compileObjectKey(PR_NAMESPACE, "arch007/within"));
    expect(stored?.size).toBe(16 * MiB);
    expect(compileObjectKey(PR_NAMESPACE, "arch007/within").startsWith(COMPILE_CACHE_PREFIX)).toBe(
      true,
    );
    // Both went through the Worker's compile-cache route and nowhere else.
    expect(stack.requests.filter((r) => r.method === "PUT").map((r) => r.path)).toEqual([
      `/v1/compile-cache/${REPOSITORY}/arch007/over`,
      `/v1/compile-cache/${REPOSITORY}/arch007/within`,
    ]);
  });
});
