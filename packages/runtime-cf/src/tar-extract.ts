// @fractalboxdev/flare-dispatch-runtime-cf — expand a stored `.tar.gz` artifact into
// per-file R2 objects, so the dispatcher can serve an artifact's CONTENTS
// (a Playwright HTML report, a screenshots tree) as a browsable static site
// instead of an opaque archive download.
//
// Container-tar artifacts (`artifact-r2.ts` container mode) stay uploaded as
// one tarball at `artifacts/<exec>/<name>` — the stable download URL. This
// module reads that object back, gunzips it via the platform
// `DecompressionStream`, walks the tar entries with a minimal parser, and
// PUTs each regular file at `artifacts/<exec>/<name>/<relpath>` with a
// content-type inferred from its extension. The artifacts route then serves
// those nested keys directly (`routes/artifacts.ts`), making
// `GET /v1/artifacts/<exec>/<name>/index.html` a real page.
//
// --- Why a hand-rolled tar parser -------------------------------------------
//
// Workers have no `node:tar`; pulling a userland tar dependency into the
// dispatcher bundle for a 512-byte-block format is heavier than the format
// itself. The parser handles exactly what `tar czf` (GNU/busybox in our
// sandbox images) emits: ustar headers with the `prefix` field, GNU `L`
// long-name entries, and pax `x` extended headers carrying `path=` — the
// Playwright bundles' test-result directory names routinely exceed the
// 100-char ustar name field, so long-name support is load-bearing, not
// theoretical.
//
// --- Bounds ------------------------------------------------------------------
//
// Expansion is best-effort decoration on top of the tarball (the caller
// swallows failures), but it must never endanger the isolate:
//   - per-entry cap: entries larger than `maxEntryBytes` are skipped (the
//     tarball download still has them);
//   - total cap: expansion stops once `maxTotalBytes` have been written;
//   - count cap: expansion stops after `maxEntries` files.
// Entries are buffered one at a time (a tar entry must be contiguous), so
// peak memory ≈ one capped entry.

/** A regular file pulled out of a tar stream. */
export type TarFile = {
  /** Entry path as recorded in the archive (after long-name resolution). */
  readonly path: string;
  readonly bytes: Uint8Array;
};

export type ExpandCaps = {
  readonly maxEntryBytes: number;
  readonly maxTotalBytes: number;
  readonly maxEntries: number;
};

export const EXPAND_CAPS_DEFAULT: ExpandCaps = {
  maxEntryBytes: 32 * 1024 * 1024, // 32 MiB — a trace.zip / webm fits
  maxTotalBytes: 256 * 1024 * 1024, // 256 MiB per artifact
  maxEntries: 4000,
};

const BLOCK = 512;

/** Read exactly `n` bytes from a byte reader, or `null` on clean EOF at 0. */
const readExact = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  carry: { buf: Uint8Array },
  n: number,
): Promise<Uint8Array | null> => {
  const chunks: Uint8Array[] = [];
  let have = 0;
  if (carry.buf.length > 0) {
    const take = carry.buf.subarray(0, Math.min(n, carry.buf.length));
    chunks.push(take);
    have += take.length;
    carry.buf = carry.buf.subarray(take.length);
  }
  while (have < n) {
    const { done, value } = await reader.read();
    if (done) {
      if (have === 0) return null;
      throw new Error(`tar: truncated stream (wanted ${n}, got ${have})`);
    }
    const need = n - have;
    if (value.length > need) {
      chunks.push(value.subarray(0, need));
      carry.buf = value.subarray(need);
      have = n;
    } else {
      chunks.push(value);
      have += value.length;
    }
  }
  if (chunks.length === 1) return chunks[0]!;
  const out = new Uint8Array(n);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
};

const decoder = new TextDecoder();

/** NUL-terminated field → string. */
const field = (block: Uint8Array, start: number, len: number): string => {
  const raw = block.subarray(start, start + len);
  const nul = raw.indexOf(0);
  return decoder.decode(nul === -1 ? raw : raw.subarray(0, nul));
};

/** Octal size field (may be space/NUL padded). */
const octal = (block: Uint8Array, start: number, len: number): number => {
  const text = field(block, start, len).trim();
  return text === "" ? 0 : Number.parseInt(text, 8);
};

/** Parse a pax extended header body — `len key=value\n` records. */
const paxPath = (bytes: Uint8Array): string | undefined => {
  const text = decoder.decode(bytes);
  let i = 0;
  while (i < text.length) {
    const sp = text.indexOf(" ", i);
    if (sp === -1) return undefined;
    const len = Number.parseInt(text.slice(i, sp), 10);
    if (!Number.isFinite(len) || len <= 0) return undefined;
    const record = text.slice(sp + 1, i + len - 1); // strip trailing \n
    const eq = record.indexOf("=");
    if (eq !== -1 && record.slice(0, eq) === "path") {
      return record.slice(eq + 1);
    }
    i += len;
  }
  return undefined;
};

/**
 * Walk a (already-gunzipped) tar stream, yielding regular files. Oversized
 * entries are skipped, not yielded; iteration stops at the archive's
 * end-of-stream zero blocks or a clean EOF.
 */
export async function* iterateTarFiles(
  tarStream: ReadableStream<Uint8Array>,
  caps: ExpandCaps,
): AsyncGenerator<TarFile> {
  const reader = tarStream.getReader();
  const carry = { buf: new Uint8Array(0) };
  let pendingLongName: string | undefined;
  let yielded = 0;
  try {
    for (;;) {
      const header = await readExact(reader, carry, BLOCK);
      if (header === null) return; // clean EOF without end blocks — accept
      if (header.every((b) => b === 0)) return; // end-of-archive marker

      const size = octal(header, 124, 12);
      const typeflag = header[156]!;
      const padded = Math.ceil(size / BLOCK) * BLOCK;

      // GNU long name ('L') / pax extended header ('x'): the BODY carries the
      // real path for the NEXT entry.
      if (typeflag === 0x4c /* 'L' */ || typeflag === 0x78 /* 'x' */) {
        const body = await readExact(reader, carry, padded);
        if (body === null) throw new Error("tar: truncated long-name entry");
        const bytes = body.subarray(0, size);
        pendingLongName =
          typeflag === 0x4c
            ? // oxlint-disable-next-line no-control-regex -- tar header fields are NUL-padded; stripping the trailing NUL run is the intent
              decoder.decode(bytes).replace(/\0+$/, "")
            : (paxPath(bytes) ?? pendingLongName);
        continue;
      }

      const prefix = field(header, 345, 155);
      const shortName = field(header, 0, 100);
      const name =
        pendingLongName ?? (prefix !== "" ? `${prefix}/${shortName}` : shortName);
      pendingLongName = undefined;

      // Only regular files ('0' or NUL) are served; directories, links, and
      // exotica are skipped (their bodies, if any, must still be consumed).
      const isFile = typeflag === 0x30 || typeflag === 0;
      if (!isFile || size > caps.maxEntryBytes) {
        // Consume the body without keeping it.
        let remaining = padded;
        while (remaining > 0) {
          const step = Math.min(remaining, 4 * 1024 * 1024);
          const skipped = await readExact(reader, carry, step);
          if (skipped === null) throw new Error("tar: truncated entry body");
          remaining -= step;
        }
        continue;
      }

      const body = await readExact(reader, carry, padded);
      if (body === null) throw new Error("tar: truncated entry body");
      yield { path: name, bytes: body.subarray(0, size) };
      yielded += 1;
      if (yielded >= caps.maxEntries) return;
    }
  } finally {
    reader.releaseLock();
  }
}

/** Content-type by file extension — what the browse experience needs. */
export const contentTypeFor = (path: string): string => {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  switch (ext) {
    case "html":
    case "htm":
      return "text/html; charset=utf-8";
    case "css":
      return "text/css; charset=utf-8";
    case "js":
    case "mjs":
      return "text/javascript; charset=utf-8";
    case "json":
      return "application/json; charset=utf-8";
    case "md":
    case "txt":
    case "log":
      return "text/plain; charset=utf-8";
    case "svg":
      return "image/svg+xml";
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "webm":
      return "video/webm";
    case "mp4":
      return "video/mp4";
    case "zip":
      return "application/zip";
    case "ndjson":
      return "application/x-ndjson";
    default:
      return "application/octet-stream";
  }
};

/**
 * Expand the `.tar.gz` stored at `sourceKey` into per-file objects under
 * `destPrefix` (one R2 PUT per regular file, content-typed by extension).
 *
 * `stripPrefix` removes the archive's top-level directory (`tar czf -C parent
 * basename` wraps everything in `basename/`) so the expanded keys read
 * `<destPrefix>index.html`, not `<destPrefix>basename/index.html`. Entries
 * outside that prefix keep their full path. Path traversal segments are
 * rejected outright.
 *
 * Returns the number of files written. Throws on a missing source object or
 * a malformed archive — the caller treats expansion as best-effort.
 */
export const expandTarGzToR2 = async (
  bucket: R2Bucket,
  sourceKey: string,
  destPrefix: string,
  stripPrefix: string,
  caps: ExpandCaps = EXPAND_CAPS_DEFAULT,
): Promise<number> => {
  const source = await bucket.get(sourceKey);
  if (source === null) {
    throw new Error(`tar expansion: no object at "${sourceKey}"`);
  }
  const tarStream = source.body.pipeThrough(new DecompressionStream("gzip"));

  let written = 0;
  let totalBytes = 0;
  for await (const file of iterateTarFiles(tarStream, caps)) {
    const rel = file.path.startsWith(stripPrefix)
      ? file.path.slice(stripPrefix.length)
      : file.path;
    // Defence: never let an archive write outside its own prefix.
    if (rel === "" || rel.split("/").some((s) => s === "" || s === "..")) {
      continue;
    }
    if (totalBytes + file.bytes.length > caps.maxTotalBytes) break;
    await bucket.put(`${destPrefix}${rel}`, file.bytes, {
      httpMetadata: { contentType: contentTypeFor(rel) },
    });
    written += 1;
    totalBytes += file.bytes.length;
  }
  return written;
};
