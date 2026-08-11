// @fractalboxdev/flare-dispatch-demo-agent — PNG frames → one animated GIF.
//
// Pure JS on purpose: the lean sandbox image carries no ffmpeg / ImageMagick,
// and esbuild bundles this into the single `demo-agent.cjs` with no native
// dependency (sharp, canvas) to ship. `pngjs` decodes the per-action PNG
// frames the play loop captured; `gifenc` quantises + LZW-encodes them into
// one GIF the `product-demo` run embeds inline in its PR comment.
//
// Why a GIF at all: GitHub PR comments can't embed video, but they DO render
// animated GIFs — so a walkthrough GIF puts the demo in the review thread
// instead of behind a replay link. GitHub proxies images through camo, which
// refuses payloads over ~10MB, so `renderGifFromDir` holds the output under a
// byte budget: it drops frames EVENLY first (keeping the walkthrough smooth),
// then shrinks width, rather than ever failing.
//
// The pure transforms (`fitWidth`, `downscale`, `dropEvenly`, `encodeGif`) are
// exported and unit-tested without a browser; `renderGifFromDir` is the thin
// fs wrapper the `gif` subcommand calls.

import * as fs from "node:fs";
import * as path from "node:path";
import { PNG } from "pngjs";
import { GIFEncoder, quantize, applyPalette } from "gifenc";

/** A decoded, in-memory frame: RGBA bytes (length = width * height * 4). */
export type RgbaFrame = {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
};

/** Decode PNG bytes into an RGBA frame (8-bit, de-interlaced by pngjs). */
export const decodePng = (bytes: Buffer): RgbaFrame => {
  const png = PNG.sync.read(bytes);
  return {
    width: png.width,
    height: png.height,
    data: Uint8Array.from(png.data),
  };
};

/**
 * Target dimensions that fit `maxWidth` — only ever downscales (a frame
 * narrower than `maxWidth` is left untouched, never blown up). Height keeps
 * the source aspect ratio.
 */
export const fitWidth = (
  w: number,
  h: number,
  maxWidth: number,
): { width: number; height: number } => {
  if (w <= maxWidth) return { width: w, height: h };
  return {
    width: maxWidth,
    height: Math.max(1, Math.round((h * maxWidth) / w)),
  };
};

/**
 * Box-average downscale of an RGBA frame to exact `targetW × targetH`. Each
 * output pixel averages its source box — cheap (O(source pixels)) and good
 * enough for UI screenshots. A no-op when the dims already match.
 */
export const downscale = (
  frame: RgbaFrame,
  targetW: number,
  targetH: number,
): RgbaFrame => {
  if (targetW === frame.width && targetH === frame.height) return frame;
  const out = new Uint8Array(targetW * targetH * 4);
  const sx = frame.width / targetW;
  const sy = frame.height / targetH;
  for (let y = 0; y < targetH; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.min(frame.height, Math.max(y0 + 1, Math.floor((y + 1) * sy)));
    for (let x = 0; x < targetW; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.min(frame.width, Math.max(x0 + 1, Math.floor((x + 1) * sx)));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * frame.width + xx) * 4;
          r += frame.data[i]!;
          g += frame.data[i + 1]!;
          b += frame.data[i + 2]!;
          a += frame.data[i + 3]!;
          n++;
        }
      }
      const o = (y * targetW + x) * 4;
      out[o] = (r / n) | 0;
      out[o + 1] = (g / n) | 0;
      out[o + 2] = (b / n) | 0;
      out[o + 3] = (a / n) | 0;
    }
  }
  return { width: targetW, height: targetH, data: out };
};

/**
 * Down-sample a list to at most `max` items, keeping the first and last and
 * spacing the rest evenly — so a frame budget thins the walkthrough uniformly
 * instead of lopping off the end. Returns a copy.
 */
export const dropEvenly = <T>(items: readonly T[], max: number): T[] => {
  if (max <= 0) return [];
  if (items.length <= max) return [...items];
  if (max === 1) return [items[0]!];
  const out: T[] = [];
  const step = (items.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) out.push(items[Math.round(i * step)]!);
  return out;
};

/**
 * Quantise + LZW-encode RGBA frames into one looping GIF. Every frame is
 * encoded against its own 256-colour palette (best fidelity for screen
 * content), with `delayMs` between frames. All frames must share dimensions —
 * the caller scales them to one target first.
 */
export const encodeGif = (
  frames: readonly RgbaFrame[],
  delayMs: number,
): Uint8Array => {
  const enc = GIFEncoder();
  for (const f of frames) {
    const palette = quantize(f.data, 256, { format: "rgb565" });
    const index = applyPalette(f.data, palette, "rgb565");
    enc.writeFrame(index, f.width, f.height, { palette, delay: delayMs });
  }
  enc.finish();
  return enc.bytes();
};

export type GifRenderOptions = {
  readonly framesDir: string;
  readonly out: string;
  readonly maxWidth: number;
  readonly maxFrames: number;
  readonly maxBytes: number;
  readonly delayMs: number;
  /**
   * Only stitch frames whose filename starts with this prefix. The play loop
   * names frames `${story}-NNNN.png`, so passing `"${story}-"` selects exactly
   * one chapter's frames — how the `product-demo` run renders a per-chapter GIF
   * out of the same shared `framesDir`. Omit to stitch EVERY frame (the
   * combined walkthrough GIF).
   */
  readonly match?: string;
};

export type GifRenderResult = {
  /** Where the GIF was written ("" when there were no frames to encode). */
  readonly gifPath: string;
  readonly frameCount: number;
  readonly bytes: number;
  readonly width: number;
  readonly height: number;
};

/**
 * Read every PNG in `framesDir` (lexical order — the play loop's
 * `${story}-NNNN.png` naming sorts chapters in walkthrough order), stitch them
 * into one GIF, and write it to `out`. Holds the output under `maxBytes` by
 * dropping frames evenly first, then shrinking width. An empty/absent
 * directory is a clean no-op (`gifPath: ""`, `frameCount: 0`) — the run treats
 * that as "no GIF" and posts its comment without the image.
 */
export const renderGifFromDir = (opts: GifRenderOptions): GifRenderResult => {
  const files = fs.existsSync(opts.framesDir)
    ? fs
        .readdirSync(opts.framesDir)
        .filter(
          (f) =>
            f.toLowerCase().endsWith(".png") &&
            (opts.match === undefined || f.startsWith(opts.match)),
        )
        .sort()
    : [];
  if (files.length === 0) {
    return { gifPath: "", frameCount: 0, bytes: 0, width: 0, height: 0 };
  }

  // Decode all frames, then scale each to ONE target derived from the first.
  const decoded = files.map((f) =>
    decodePng(fs.readFileSync(path.join(opts.framesDir, f))),
  );
  const target = fitWidth(decoded[0]!.width, decoded[0]!.height, opts.maxWidth);
  // `selected` always holds target-dimension frames; `frames` is `selected`
  // re-scaled to the current width — so repeated shrink passes downscale from
  // the crisp originals, never compounding blur.
  let selected = dropEvenly(
    decoded.map((f) => downscale(f, target.width, target.height)),
    opts.maxFrames,
  );
  let curW = target.width;
  let curH = target.height;
  const scaledForCur = () =>
    selected.map((f) => (f.width === curW ? f : downscale(f, curW, curH)));

  let frames = scaledForCur();
  let bytes = encodeGif(frames, opts.delayMs);
  // Budget loop: thin frames down to a floor, THEN reduce width. Bounded so a
  // pathological input can't spin — if it's still over budget after this, we
  // ship the best effort rather than failing the comment.
  for (let attempt = 0; bytes.length > opts.maxBytes && attempt < 8; attempt++) {
    if (selected.length > 8) {
      selected = dropEvenly(selected, Math.max(8, Math.floor(selected.length / 2)));
    } else {
      curW = Math.max(200, Math.round(curW * 0.8));
      curH = Math.max(1, Math.round((target.height * curW) / target.width));
    }
    frames = scaledForCur();
    bytes = encodeGif(frames, opts.delayMs);
  }

  fs.writeFileSync(opts.out, bytes);
  return {
    gifPath: opts.out,
    frameCount: frames.length,
    bytes: bytes.length,
    width: curW,
    height: curH,
  };
};
