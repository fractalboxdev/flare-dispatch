// Unit tests for tar-extract — the upload-time browse expansion.
//
// Archives are synthesised in-test (ustar header writer + CompressionStream)
// so the parser's long-name (`L`), pax (`x`), strip-prefix, traversal-guard,
// and cap behaviours are pinned without any container runtime. The R2 side
// drives the real Miniflare binding via `makeTestBindings`, same as
// artifact-r2.test.ts.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_EXPAND_CAPS,
  contentTypeFor,
  expandTarGzToR2,
  iterateTarFiles,
} from "./tar-extract";
import { makeTestBindings, type TestBindings } from "./test-support";

const encoder = new TextEncoder();

/** One-chunk byte stream (Blob.stream()'s BlobPart typing varies per env). */
const byteStream = (bytes: Uint8Array): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });

/** Build one 512-byte ustar header block. */
const header = (
  name: string,
  size: number,
  typeflag: string,
  prefix = "",
): Uint8Array => {
  const block = new Uint8Array(512);
  block.set(encoder.encode(name).subarray(0, 100), 0);
  block.set(encoder.encode("0000644\0"), 100); // mode
  block.set(encoder.encode("0000000\0"), 108); // uid
  block.set(encoder.encode("0000000\0"), 116); // gid
  block.set(encoder.encode(`${size.toString(8).padStart(11, "0")}\0`), 124);
  block.set(encoder.encode("00000000000\0"), 136); // mtime
  block.set(encoder.encode("        "), 148); // checksum spaces for calc
  block[156] = typeflag.charCodeAt(0);
  block.set(encoder.encode("ustar\0"), 257);
  block.set(encoder.encode("00"), 263);
  if (prefix !== "") block.set(encoder.encode(prefix).subarray(0, 155), 345);
  // Checksum: sum of all bytes with the checksum field as spaces.
  let sum = 0;
  for (const b of block) sum += b;
  block.set(encoder.encode(`${sum.toString(8).padStart(6, "0")}\0 `), 148);
  return block;
};

const padTo512 = (bytes: Uint8Array): Uint8Array => {
  const padded = new Uint8Array(Math.ceil(bytes.length / 512) * 512);
  padded.set(bytes);
  return padded;
};

type Entry = {
  name: string;
  body?: string;
  typeflag?: string;
  longName?: boolean;
  paxPath?: string;
};

/** Assemble a tar archive from entries (+ the end-of-archive zero blocks). */
const buildTar = (entries: Entry[]): Uint8Array => {
  const parts: Uint8Array[] = [];
  for (const e of entries) {
    if (e.longName) {
      const nameBytes = encoder.encode(`${e.name}\0`);
      parts.push(header("././@LongLink", nameBytes.length, "L"));
      parts.push(padTo512(nameBytes));
    }
    if (e.paxPath !== undefined) {
      const record = ` path=${e.paxPath}\n`;
      const len = record.length + String(record.length + 2).length;
      const body = encoder.encode(`${len}${record}`);
      parts.push(header("./PaxHeaders/x", body.length, "x"));
      parts.push(padTo512(body));
    }
    const bodyBytes = encoder.encode(e.body ?? "");
    parts.push(
      header(
        e.longName ? e.name.slice(0, 100) : e.name,
        bodyBytes.length,
        e.typeflag ?? "0",
      ),
    );
    if (bodyBytes.length > 0) parts.push(padTo512(bodyBytes));
  }
  parts.push(new Uint8Array(1024)); // end-of-archive
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
};

const gzip = async (bytes: Uint8Array): Promise<Uint8Array> => {
  const stream = byteStream(bytes).pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
};

const collect = async (tar: Uint8Array) => {
  const files: Array<{ path: string; text: string }> = [];
  for await (const f of iterateTarFiles(
    byteStream(tar),
    DEFAULT_EXPAND_CAPS,
  )) {
    files.push({ path: f.path, text: new TextDecoder().decode(f.bytes) });
  }
  return files;
};

describe("iterateTarFiles", () => {
  it("yields regular files and skips directories", async () => {
    const files = await collect(
      buildTar([
        { name: "report/", body: "", typeflag: "5" },
        { name: "report/index.html", body: "<html>hi</html>" },
        { name: "report/data/a.png", body: "PNG" },
      ]),
    );
    expect(files).toEqual([
      { path: "report/index.html", text: "<html>hi</html>" },
      { path: "report/data/a.png", text: "PNG" },
    ]);
  });

  it("resolves GNU 'L' long names", async () => {
    const long = `report/data/${"x".repeat(120)}.png`;
    const files = await collect(
      buildTar([{ name: long, body: "PNG", longName: true }]),
    );
    expect(files).toEqual([{ path: long, text: "PNG" }]);
  });

  it("resolves pax 'x' extended-header paths", async () => {
    const long = `report/${"y".repeat(120)}/error-context.md`;
    const files = await collect(
      buildTar([{ name: "report/error-context.md", body: "md", paxPath: long }]),
    );
    expect(files).toEqual([{ path: long, text: "md" }]);
  });

  it("skips entries above the per-entry cap but keeps the rest", async () => {
    const tar = buildTar([
      { name: "report/big.bin", body: "Z".repeat(2048) },
      { name: "report/small.txt", body: "ok" },
    ]);
    const files: string[] = [];
    for await (const f of iterateTarFiles(byteStream(tar), {
      ...DEFAULT_EXPAND_CAPS,
      maxEntryBytes: 1024,
    })) {
      files.push(f.path);
    }
    expect(files).toEqual(["report/small.txt"]);
  });
});

describe("contentTypeFor", () => {
  it("maps the browse-critical extensions", () => {
    expect(contentTypeFor("index.html")).toContain("text/html");
    expect(contentTypeFor("a/b.css")).toContain("text/css");
    expect(contentTypeFor("app.js")).toContain("text/javascript");
    expect(contentTypeFor("shot.png")).toBe("image/png");
    expect(contentTypeFor("video.webm")).toBe("video/webm");
    expect(contentTypeFor("trace.zip")).toBe("application/zip");
    expect(contentTypeFor("noext")).toBe("application/octet-stream");
  });
});

describe("expandTarGzToR2", () => {
  let bindings: TestBindings;

  beforeEach(async () => {
    bindings = await makeTestBindings();
  });
  afterEach(async () => {
    await bindings.dispose();
  });

  it("expands the archive under the dest prefix, stripping the tar's top dir", async () => {
    const tar = buildTar([
      { name: "playwright-report/index.html", body: "<html>report</html>" },
      { name: "playwright-report/data/shot.png", body: "PNG" },
      // Traversal attempt must be dropped, not written.
      { name: "playwright-report/../evil.txt", body: "nope" },
    ]);
    await bindings.bucket.put("artifacts/exec1/acceptance-report", await gzip(tar));

    const written = await expandTarGzToR2(
      bindings.bucket,
      "artifacts/exec1/acceptance-report",
      "artifacts/exec1/acceptance-report/",
      "playwright-report/",
    );
    expect(written).toBe(2);

    const index = await bindings.bucket.get(
      "artifacts/exec1/acceptance-report/index.html",
    );
    expect(await index?.text()).toBe("<html>report</html>");
    expect(index?.httpMetadata?.contentType).toContain("text/html");

    const png = await bindings.bucket.get(
      "artifacts/exec1/acceptance-report/data/shot.png",
    );
    expect(png?.httpMetadata?.contentType).toBe("image/png");

    const evil = await bindings.bucket.list({ prefix: "artifacts/exec1/" });
    expect(evil.objects.map((o) => o.key)).not.toContain("artifacts/evil.txt");
  });

  it("throws when the source object is missing", async () => {
    await expect(
      expandTarGzToR2(bindings.bucket, "artifacts/none/x", "p/", "x/"),
    ).rejects.toThrow(/no object/);
  });
});
