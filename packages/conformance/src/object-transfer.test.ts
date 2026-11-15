// How cache and artifact bytes move on the composed control plane: the control plane Worker under workerd through
// Miniflare, on a deploy that holds the object-store presign token. A device holds a pull request execution's lease over
// a signed socket and asks the `ExecutorChannel` for URLs with `exec.presign`; the channel signs each object it allows
// with FlareDispatch's object-store presigner (MAMEKO-HOST-051), so the bytes go between the executor and R2's S3
// endpoint. The Worker's own routes take no artifact, cache or log bytes but the compile-cache route's, which streams
// an object of at most 100 MiB into R2 (specs/cache-artifacts.md FD-CACHE-047, FD-CACHE-053, FD-CACHE-056).
import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { FlareDispatchApi } from "@fractalboxdev/flare-dispatch-api";
import {
  COMPILE_CACHE_PREFIX,
  compileObjectKey,
  DEFAULT_MAX_COMPILE_OBJECT_BYTES,
  logObjectName,
  objectPrefix,
  pullRequestNamespace,
} from "@fractalboxdev/flare-dispatch-cache";
import { HttpApi } from "effect/http-api";
import { build } from "esbuild";
import { wasmModules, workerdBuild } from "../../../apps/control-plane/test/workerd-bundle.ts";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AUD,
  connect,
  endStandingClaim,
  hello,
  newDevice,
  OPERATOR,
  PLANE,
  registration,
  startAccessTeam,
  type AccessTeam,
  type Socket,
} from "../../../apps/control-plane/test/support.ts";

const REPO = "fractalboxdev/flare-dispatch";
const ORIGIN = "https://ci.example.com";
const PR = pullRequestNamespace(REPO, 47);
/** The presign token the deploy holds: an R2 API token's S3 access key pair, and the bucket's account and name. */
const PRESIGNER = {
  R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  CACHE_BUCKET_NAME: "fd-cache",
  R2_PRESIGN_ACCESS_KEY_ID: "conformance-access-key",
  R2_PRESIGN_SECRET_ACCESS_KEY: "conformance-secret-access-key",
};

const DEV_REPOSITORY = {
  repository: REPO,
  installation: 1,
  default_branch: "main",
  head: "f".repeat(40),
  confidentiality: "non-confidential",
  files: {
    ".github/flare-dispatch.json": readFileSync(
      join(import.meta.dirname, "../../../.github/flare-dispatch.json"),
    ).toString("base64"),
  },
};

let team: AccessTeam;
let plane: Miniflare;
/** The Worker's own HTTP address. */
let planeUrl: URL;

beforeAll(async () => {
  team = await startAccessTeam();
  const bundle = await build({
    entryPoints: [join(import.meta.dirname, "../../../apps/control-plane/src/worker.ts")],
    bundle: true,
    format: "esm",
    platform: "browser",
    ...workerdBuild,
    write: false,
    external: ["cloudflare:*"],
  });
  plane = new Miniflare({
    modules: [
      { type: "ESModule", path: "worker.js", contents: bundle.outputFiles[0]!.text },
      ...wasmModules(),
    ],
    compatibilityDate: "2026-05-01",
    d1Databases: { DB: "control-plane" },
    durableObjects: {
      CHANNEL: { className: "ExecutorChannel", useSQLite: true },
      EXECUTION: { className: "ExecutionEngine", useSQLite: true },
      EPOCH_ANCHOR: { className: "EpochAnchor", useSQLite: true },
      MONITOR: { className: "LivenessMonitor", useSQLite: true },
      CACHE_LEDGER: { className: "CacheLedger", useSQLite: true },
    },
    r2Buckets: ["CACHE"],
    bindings: {
      DEPLOYMENT: "development",
      PLANE_ID: PLANE,
      PUBLIC_ORIGIN: ORIGIN,
      COMPILE_CACHE_SECRET: "compile-cache-secret-for-conformance",
      LINK_KEY: "link-key-for-conformance",
      ACCESS_TEAM_DOMAIN: team.teamDomain,
      ACCESS_AUD: AUD,
      OPERATORS: JSON.stringify([OPERATOR]),
      DISPATCHERS: JSON.stringify([OPERATOR]),
      FD_DEV_REPOSITORY: JSON.stringify(DEV_REPOSITORY),
      ...PRESIGNER,
    },
  });
  planeUrl = await plane.ready;
}, 120_000);

afterAll(async () => {
  await plane?.dispose();
  await team?.close();
});

const bucket = () => plane.getR2Bucket("CACHE");

/** Every object key in the control plane's bucket. */
const storedKeys = async () => {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await (await bucket()).list(cursor === undefined ? {} : { cursor });
    keys.push(...page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
  return keys.sort();
};

interface Lease {
  readonly socket: Socket;
  readonly id: string;
  readonly epoch: number;
  readonly cache_namespaces: { readonly read: readonly string[]; readonly write: string | null };
  readonly compileCache: { readonly endpoint: string; readonly token: string };
}

/** A pull request execution, as intake records a webhook's, leased to a fresh device over the control plane's socket. */
const pullRequestLease = async (): Promise<Lease> => {
  const executorId = "conf-object-transfer";
  const device = await newDevice();
  const headers = {
    "content-type": "application/json",
    "cf-access-jwt-assertion": await team.jwt(OPERATOR),
  };
  const enrolled = await plane.dispatchFetch("http://x/v1/executors/register", {
    method: "POST",
    headers,
    body: JSON.stringify(registration(executorId, device.identity)),
  });
  expect(enrolled.status).toBe(201);
  const sha = "4".repeat(40);
  const admitted = await plane.dispatchFetch("http://x/v1/dispatch/check", {
    method: "POST",
    headers,
    body: JSON.stringify({
      repository: REPO,
      sha,
      inputs: {
        repo: `https://github.com/${REPO}`,
        sha,
        ref: "main",
        steps: [{ label: "build", command: "cargo build" }],
      },
    }),
  });
  expect(admitted.status).toBe(202);
  const { execution_id: id } = (await admitted.json()) as { execution_id: string };
  const d1 = (await plane.getD1Database("DB")) as unknown as D1Database;
  await d1
    .prepare("update intake_records set cache_trigger_json = ? where execution_id = ?")
    .bind(JSON.stringify({ _tag: "PullRequest", number: 47 }), id)
    .run();
  await d1
    .prepare("update executions set deadline_at = ? where id = ?")
    .bind(Date.now() + 3_600_000, id)
    .run();
  const socket = await connect(plane, executorId, device.keys);
  socket.send(hello(executorId));
  await socket.next("session.welcome");
  socket.send({
    type: "exec.claim",
    id: "c1",
    free: { release: 1, required: 1, interactive: 1, batch: 1 },
  });
  const lease = await socket.next("exec.lease");
  expect(lease["execution_id"]).toBe(id);
  await endStandingClaim(socket);
  const grant = lease["upload_grant"] as {
    compile_cache: { endpoint: string; token: string } | null;
  };
  return {
    socket,
    id,
    epoch: lease["epoch"] as number,
    cache_namespaces: lease["cache_namespaces"] as Lease["cache_namespaces"],
    compileCache: grant.compile_cache!,
  };
};

let leased: Lease | undefined;
const theLease = async () => (leased ??= await pullRequestLease());

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

/** One `exec.presign` on the lease's socket, answered by the channel's `exec.presigned`. */
const presign = async (
  lease: Lease,
  objects: readonly { key: string; method: "GET" | "PUT"; length: number | null }[],
  epoch = lease.epoch,
) => {
  const id = `p${++presigns}`;
  lease.socket.send({ type: "exec.presign", id, execution_id: lease.id, epoch, objects });
  const answer = await lease.socket.next("exec.presigned");
  expect(answer["ref"]).toBe(id);
  return answer as {
    readonly status?: string;
    readonly urls?: readonly { key: string; url: string; expires_at: number }[];
  };
};

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const hmac = (key: string | Buffer, text: string) =>
  createHmac("sha256", key).update(text).digest();
/** RFC 3986 percent-encoding as SigV4 canonicalizes a path segment or a query component. */
const encode = (text: string) =>
  encodeURIComponent(text).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

/**
 * The SigV4 signature R2's S3 endpoint expects for a presigned request of `method` on the URL, with a `PUT`'s
 * `Content-Length` of `length`: the canonical request rebuilt from the URL's own query, under the presign token's secret.
 */
const expectedSignature = (url: URL, method: "GET" | "PUT", length: number | null) => {
  const query = [...url.searchParams].filter(([k]) => k !== "X-Amz-Signature");
  const canonicalQuery = query
    .map(([k, v]) => `${encode(k)}=${encode(v)}`)
    .sort()
    .join("&");
  const signed = url.searchParams.get("X-Amz-SignedHeaders")!.split(";");
  const values: Record<string, string> = {
    host: url.host,
    ...(length === null ? {} : { "content-length": String(length) }),
  };
  const canonicalRequest = [
    method,
    url.pathname,
    canonicalQuery,
    signed.map((h) => `${h}:${values[h] ?? ""}\n`).join(""),
    signed.join(";"),
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const amzDate = url.searchParams.get("X-Amz-Date")!;
  const scope = url.searchParams.get("X-Amz-Credential")!.split("/").slice(1).join("/");
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonicalRequest)].join("\n");
  let key = hmac(`AWS4${PRESIGNER.R2_PRESIGN_SECRET_ACCESS_KEY}`, amzDate.slice(0, 8));
  for (const part of ["auto", "s3", "aws4_request"]) key = hmac(key, part);
  return hmac(key, stringToSign).toString("hex");
};

/** A presigned R2 URL for exactly `key`, `method` and `length`, on the account's S3 endpoint. */
const expectPresigned = (
  signed: { key: string; url: string; expires_at: number },
  key: string,
  method: "GET" | "PUT",
  length: number | null,
) => {
  expect(signed.key).toBe(key);
  const url = new URL(signed.url);
  expect(url.protocol).toBe("https:");
  expect(url.host).toBe(`${PRESIGNER.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`);
  expect(decodeURIComponent(url.pathname)).toBe(`/${PRESIGNER.CACHE_BUCKET_NAME}/${key}`);
  expect(url.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
  expect(url.searchParams.get("X-Amz-Credential")).toMatch(
    new RegExp(`^${PRESIGNER.R2_PRESIGN_ACCESS_KEY_ID}/\\d{8}/auto/s3/aws4_request$`),
  );
  expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe(
    method === "PUT" ? "content-length;host" : "host",
  );
  expect(Number(url.searchParams.get("X-Amz-Expires"))).toBeLessThanOrEqual(15 * 60);
  expect(signed.expires_at).toBeGreaterThan(Date.now());
  const signature = url.searchParams.get("X-Amz-Signature");
  expect(signature).toBe(expectedSignature(url, method, length));
  // The signature binds the method and the length: the same URL for another method or length does not verify.
  expect(signature).not.toBe(expectedSignature(url, method === "PUT" ? "GET" : "PUT", length));
  if (length !== null) expect(signature).not.toBe(expectedSignature(url, method, length + 1));
};

describe("the executor's object transfers on the composed control plane", () => {
  it("[FD-CACHE-047] the channel's exec.presign answers presigned R2 URLs for each allowed object's key, method and length", async () => {
    const lease = await theLease();
    expect(lease.cache_namespaces.write).toBe(PR);
    expect(lease.cache_namespaces.read).toContain("cas");
    const entry = "e".repeat(64);
    // The cache save: an object under the entry's writer prefix in the lease's write namespace.
    const cacheSave = `${objectPrefix(PR, entry, lease.id, lease.epoch)}target.tar.zst`;
    const logSegment = (await logObjectName({
      executionId: lease.id,
      epoch: lease.epoch,
      journalName: "build",
      stream: "stdout",
      start: 0,
      end: 2048,
    }))!;
    const artifact = `artifact/${lease.id}/${lease.epoch}/report.txt`;
    const cacheRead = `cache/cas/${entry}/${lease.id}/${lease.epoch}`;
    const before = await storedKeys();

    const saved = await presign(lease, [
      { key: cacheSave, method: "PUT", length: 65_536 },
      { key: logSegment, method: "PUT", length: 2048 },
    ]);
    expect(saved.status).toBeUndefined();
    expect(saved.urls).toHaveLength(2);
    expectPresigned(saved.urls![0]!, cacheSave, "PUT", 65_536);
    expectPresigned(saved.urls![1]!, logSegment, "PUT", 2048);

    const answer = await presign(lease, [
      { key: artifact, method: "PUT", length: 4096 },
      { key: cacheRead, method: "GET", length: null },
    ]);
    expect(answer.status).toBeUndefined();
    expect(answer.urls).toHaveLength(2);
    expectPresigned(answer.urls![0]!, artifact, "PUT", 4096);
    expectPresigned(answer.urls![1]!, cacheRead, "GET", null);

    // Objects outside the lease get no URL: another namespace's writer prefix, another epoch's artifact or log.
    for (const objects of [
      [
        { key: cacheSave, method: "PUT" as const, length: 1 },
        {
          key: `${objectPrefix(pullRequestNamespace(REPO, 48), entry, lease.id, lease.epoch)}x`,
          method: "PUT" as const,
          length: 1,
        },
      ],
      [
        { key: artifact, method: "PUT" as const, length: 1 },
        {
          key: `artifact/${lease.id}/${lease.epoch + 1}/report.txt`,
          method: "PUT" as const,
          length: 1,
        },
      ],
      [
        {
          key: logSegment.replace(`/${lease.epoch}/`, `/${lease.epoch + 1}/`),
          method: "PUT" as const,
          length: 1,
        },
      ],
    ]) {
      const outside = await presign(lease, objects);
      expect(outside, objects.map((o) => o.key).join(" ")).toMatchObject({ status: "refused" });
      expect(outside.urls).toBeUndefined();
    }
    // A request at an epoch the executor does not hold is stale.
    for (const key of [artifact, cacheSave])
      expect(
        await presign(lease, [{ key, method: "PUT", length: 1 }], lease.epoch + 1),
      ).toMatchObject({
        status: "stale",
      });

    // Signing moved no bytes: the Worker's bucket holds what it held before.
    expect(await storedKeys()).toEqual(before);
  }, 120_000);

  it("[FD-CACHE-047] the Worker's routes take no artifact, cache or log bytes, and the compile-cache route refuses an object over 100 MiB", async () => {
    const lease = await theLease();
    const operator = { "cf-access-jwt-assertion": await team.jwt(OPERATOR) };
    const bytes = new Uint8Array(4096).fill(7);
    const before = await storedKeys();

    // The artifact and log groups declare reads only.
    const declared: { group: string; method: string; path: string }[] = [];
    HttpApi.reflect(FlareDispatchApi, {
      onGroup: () => {},
      onEndpoint: ({ group, endpoint }) =>
        declared.push({ group: group.identifier, method: endpoint.method, path: endpoint.path }),
    });
    const transfers = declared.filter((e) => e.group === "artifacts" || e.group === "logs");
    expect(transfers.length).toBeGreaterThan(0);
    for (const e of transfers) expect(e.method, e.path).toBe("GET");

    // The compile-cache route: a PUT declaring one byte over 100 MiB is 413 and stores nothing; one within the bound
    // streams into R2 under the lease's write namespace.
    const { endpoint, token } = lease.compileCache;
    expect(endpoint).toBe(`${ORIGIN}/v1/compile-cache/${REPO}`);
    const over = DEFAULT_MAX_COMPILE_OBJECT_BYTES + 1;
    expect(DEFAULT_MAX_COMPILE_OBJECT_BYTES).toBe(100 * 1024 * 1024);
    const refused = await declaredPut(
      new URL(new URL(`${endpoint}/k047/huge`).pathname, planeUrl),
      { authorization: `Bearer ${token}` },
      over,
    );
    expect(refused).toBe(413);
    expect(await (await bucket()).head(compileObjectKey(PR, "k047/huge"))).toBeNull();

    const stored = await plane.dispatchFetch(`${endpoint}/k047/small`, {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-length": String(bytes.byteLength) },
      body: bytes,
    });
    expect(stored.status).toBe(201);
    expect(await storedKeys()).toEqual([...before, compileObjectKey(PR, "k047/small")].sort());
    expect(compileObjectKey(PR, "k047/small").startsWith(COMPILE_CACHE_PREFIX)).toBe(true);

    // Every declared route that takes a body, given artifact bytes by an operator, stores none of them; every
    // artifact, log and cache path refuses them under each write method.
    const concrete = (path: string, id: string) =>
      path
        .replace(":artifact_id", "a1")
        .replace(":id", id)
        .replace(":file", "stdout-0-10.ndjson")
        .replace(":digest", "e".repeat(64))
        .replace(":run", "check")
        .replace("*", "report.txt");
    const send = async (method: string, path: string) => {
      const r = await plane.dispatchFetch(`${ORIGIN}${path}`, {
        method,
        headers: { ...operator, "content-type": "application/octet-stream" },
        body: bytes,
      });
      await r.arrayBuffer();
      return r.status;
    };
    for (const e of declared.filter((d) => d.method !== "GET"))
      await send(e.method, concrete(e.path, "01UNKNOWNEXECUTION0000000"));
    const objectPaths = [
      ...transfers.map((e) => concrete(e.path, lease.id)),
      `/v1/artifacts/${lease.id}`,
      `/v1/executions/${lease.id}/cache`,
      `/v1/cache/${PR}/${"e".repeat(64)}`,
      `/v1/logs/${lease.id}/${lease.epoch}/stdout-0-10.ndjson`,
    ];
    for (const path of objectPaths)
      for (const method of ["PUT", "POST", "PATCH"])
        expect(await send(method, path), `${method} ${path}`).toBeGreaterThanOrEqual(400);
    expect(await storedKeys()).toEqual([...before, compileObjectKey(PR, "k047/small")].sort());
  }, 120_000);
});
