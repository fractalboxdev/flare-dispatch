import { describe, expect, it } from "vitest";
import { classifyGhcrFailure, pushGhcrImageIndex, type GhcrPlatformImage } from "./ghcr-push";

const hex = async (bytes: Uint8Array): Promise<string> =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
const MANIFEST = "application/vnd.oci.image.manifest.v1+json";
const INDEX = "application/vnd.oci.image.index.v1+json";

/** One platform as `contextful-ci image` describes it: keys sorted, blobs verbatim. */
const platformImage = async (architecture: "amd64" | "arm64", layerByte: number): Promise<GhcrPlatformImage> => {
  const layer = new Uint8Array([layerByte, 2, 3]);
  const layerDigest = `sha256:${await hex(layer)}`;
  const config = new TextEncoder().encode(JSON.stringify({ architecture, os: "linux" }));
  const configDigest = `sha256:${await hex(config)}`;
  const manifest = new TextEncoder().encode(JSON.stringify({
    config: { digest: configDigest, mediaType: "application/vnd.oci.image.config.v1+json", size: config.byteLength },
    layers: [{ digest: layerDigest, mediaType: "application/vnd.oci.image.layer.v1.tar+gzip", size: layer.byteLength }],
    mediaType: MANIFEST, schemaVersion: 2,
  }));
  const manifestDigest = `sha256:${await hex(manifest)}`;
  return { layerDigest, layerSize: layer.byteLength, openLayer: async () => layer, configDigest, config,
    manifestDigest, manifest, entry: { digest: manifestDigest, mediaType: MANIFEST,
      platform: { architecture, os: "linux", ...(architecture === "arm64" ? { variant: "v8" } : {}) },
      size: manifest.byteLength } };
};

type Recorded = { url: string; method: string; auth: string | null; type: string | null; body: Uint8Array };
/** A registry that has nothing and accepts every upload, recording each request. */
const emptyRegistry = (requests: Recorded[], location = "/v2/o/r/p/blobs/uploads/session"): typeof fetch =>
  async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const body = request.body === null ? new Uint8Array() : new Uint8Array(await request.arrayBuffer());
    requests.push({ url: request.url, method: request.method, auth: request.headers.get("authorization"),
      type: request.headers.get("content-type"), body });
    if (url.pathname === "/token") return Response.json({ token: "registry-bearer" });
    if (request.method === "HEAD") return new Response(null, { status: 404 });
    if (request.method === "POST") return new Response(null, { status: 202, headers: { Location: location } });
    if (request.method === "PUT") return new Response(null, { status: 201 });
    throw new Error(`unexpected ${request.method} ${request.url}`);
  };

describe("pushGhcrImageIndex", () => {
  it("pushes each platform's blobs and manifest by digest, then the index by tag", async () => {
    const requests: Recorded[] = [];
    const platforms = [await platformImage("amd64", 1), await platformImage("arm64", 9)];
    await pushGhcrImageIndex({ username: "bot", token: "test-pat", name: "o/r/p", tag: "0.5.0", platforms,
      fetchImpl: emptyRegistry(requests) });
    expect(requests[0]?.auth).toBe(`Basic ${btoa("bot:test-pat")}`);
    const manifests = requests.filter((r) => r.method === "PUT" && r.url.includes("/manifests/"));
    expect(manifests.map((r) => new URL(r.url).pathname)).toEqual([
      `/v2/o/r/p/manifests/${platforms[0]!.manifestDigest}`,
      `/v2/o/r/p/manifests/${platforms[1]!.manifestDigest}`,
      "/v2/o/r/p/manifests/0.5.0",
    ]);
    expect(manifests.map((r) => r.type)).toEqual([MANIFEST, MANIFEST, INDEX]);
    expect(manifests[0]!.body).toEqual(platforms[0]!.manifest);
    expect(new TextDecoder().decode(manifests[2]!.body)).toBe(`{"manifests":[${
      platforms.map((p) => JSON.stringify(p.entry)).join(",")}],"mediaType":"${INDEX}","schemaVersion":2}`);
    expect(requests.every((r) => !new TextDecoder().decode(r.body).includes("test-pat"))).toBe(true);
  });

  it("uploads every blob as application/octet-stream, which GHCR requires, config verbatim", async () => {
    // GHCR answers 404 to a blob PUT carrying an OCI media type as its Content-Type.
    const requests: Recorded[] = [];
    const platform = await platformImage("amd64", 1);
    await pushGhcrImageIndex({ username: "bot", token: "test-pat", name: "o/r/p", tag: "0.5.0",
      platforms: [platform], fetchImpl: emptyRegistry(requests) });
    const blobs = requests.filter((r) => r.method === "PUT" && !r.url.includes("/manifests/"));
    expect(blobs.map((r) => r.type)).toEqual(["application/octet-stream", "application/octet-stream"]);
    expect(blobs.map((r) => new URL(r.url).searchParams.get("digest"))).toEqual([platform.layerDigest, platform.configDigest]);
    expect(blobs[1]!.body).toEqual(platform.config);
  });

  it("keeps an existing matching index tag and refuses a conflicting one", async () => {
    let indexDigest: string | undefined;
    const requests: Recorded[] = [];
    const registry = emptyRegistry(requests);
    const fetchImpl: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      if (request.url.endsWith("/manifests/0.5.0")) {
        if (request.method === "HEAD") {
          return indexDigest === undefined ? new Response(null, { status: 404 }) :
            new Response(null, { status: 200, headers: { "Docker-Content-Digest": indexDigest } });
        }
        indexDigest = `sha256:${await hex(new Uint8Array(await request.clone().arrayBuffer()))}`;
      }
      return registry(request);
    };
    const opts = { username: "bot", token: "test-pat", name: "o/r/p", tag: "0.5.0",
      platforms: [await platformImage("amd64", 1), await platformImage("arm64", 9)], fetchImpl };
    await pushGhcrImageIndex(opts);
    const afterPublish = requests.length;
    await pushGhcrImageIndex(opts);
    expect(requests.slice(afterPublish)).toHaveLength(1);
    indexDigest = `sha256:${"c".repeat(64)}`;
    await expect(pushGhcrImageIndex(opts)).rejects.toThrow("already names a different manifest");
  });

  it("refuses a platform whose blobs differ from their digests or whose entry names another manifest", async () => {
    const good = await platformImage("amd64", 1);
    const push = (platform: GhcrPlatformImage) => pushGhcrImageIndex({ username: "bot", token: "t", name: "o/r/p",
      tag: "0.5.0", platforms: [platform], fetchImpl: emptyRegistry([]) });
    await expect(push({ ...good, config: new TextEncoder().encode("{}") })).rejects.toThrow("invalid OCI image");
    await expect(push({ ...good, layerDigest: `sha256:${"e".repeat(64)}` })).rejects.toThrow("invalid OCI image");
    await expect(push({ ...good, entry: { ...good.entry, digest: `sha256:${"e".repeat(64)}` } })).rejects.toThrow("invalid OCI image");
  });

  it("opens a layer only when the registry lacks it, and never forwards the bearer to a cross-host upload", async () => {
    const requests: Recorded[] = [];
    let opened = 0;
    const platform = await platformImage("amd64", 1);
    await pushGhcrImageIndex({ username: "bot", token: "test-pat", name: "o/r/p", tag: "0.5.0",
      platforms: [{ ...platform, openLayer: async () => { opened++; return platform.openLayer(); } }],
      fetchImpl: emptyRegistry(requests, "https://upload.example.test/blob?signature=test") });
    expect(opened).toBe(1);
    const uploads = requests.filter((r) => new URL(r.url).hostname === "upload.example.test");
    expect(uploads).toHaveLength(2);
    expect(uploads.every((r) => r.auth === null)).toBe(true);
  });
});

describe("classifyGhcrFailure", () => {
  it("names the registry's HTTP status and keeps the failing operation as detail", () => {
    expect(classifyGhcrFailure(new Error("GHCR blob upload failed with HTTP 404")))
      .toEqual({ status: 404, reason: "other", detail: "GHCR blob upload failed with HTTP 404" });
    expect(classifyGhcrFailure(new Error("GHCR token request failed with HTTP 401")).reason).toBe("unauthorized");
    expect(classifyGhcrFailure(new Error("GHCR blob upload start failed with HTTP 403")).reason).toBe("unauthorized");
    expect(classifyGhcrFailure(new Error("GHCR manifest publish failed with HTTP 429")).reason).toBe("rate-limited");
    expect(classifyGhcrFailure(new Error("GHCR blob upload failed with HTTP 503")).reason).toBe("transient");
  });

  it("treats a network failure as transient and a refused input or tag conflict as final", () => {
    expect(classifyGhcrFailure(new TypeError("fetch failed"))).toMatchObject({ status: 0, reason: "transient" });
    expect(classifyGhcrFailure(new TypeError("invalid OCI image name, tag, digest, or size")))
      .toMatchObject({ status: 0, reason: "other" });
    expect(classifyGhcrFailure(new Error("GHCR image tag already names a different manifest")))
      .toMatchObject({ status: 0, reason: "other" });
  });
});
