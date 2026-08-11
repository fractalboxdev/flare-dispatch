// gif.ts tests — the pure transforms + an end-to-end dir → GIF render.
//
// No browser, no model: synthetic PNG frames are written with pngjs, then
// stitched. We assert the GIF89a magic, the byte budget is respected (frames
// dropped, not the encode failing), and the frame-ordering glob is lexical.

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PNG } from "pngjs";
import {
  decodePng,
  downscale,
  dropEvenly,
  encodeGif,
  fitWidth,
  renderGifFromDir,
  type RgbaFrame,
} from "./gif.js";

// Build a solid-colour RGBA frame.
const solid = (w: number, h: number, r: number, g: number, b: number): RgbaFrame => {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = 255;
  }
  return { width: w, height: h, data };
};

// Encode an RgbaFrame as PNG bytes (pngjs).
const toPng = (frame: RgbaFrame): Buffer => {
  const png = new PNG({ width: frame.width, height: frame.height });
  png.data = Buffer.from(frame.data);
  return PNG.sync.write(png);
};

describe("fitWidth", () => {
  it("never upscales", () => {
    expect(fitWidth(400, 300, 800)).toEqual({ width: 400, height: 300 });
  });
  it("downscales preserving aspect ratio", () => {
    expect(fitWidth(1600, 900, 800)).toEqual({ width: 800, height: 450 });
  });
});

describe("dropEvenly", () => {
  it("returns a copy when under the cap", () => {
    expect(dropEvenly([1, 2, 3], 10)).toEqual([1, 2, 3]);
  });
  it("keeps first and last when thinning", () => {
    const out = dropEvenly([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 3);
    expect(out.length).toBe(3);
    expect(out[0]).toBe(0);
    expect(out[out.length - 1]).toBe(9);
  });
  it("handles max of 1 without NaN indexing", () => {
    expect(dropEvenly([5, 6, 7], 1)).toEqual([5]);
  });
  it("handles max of 0", () => {
    expect(dropEvenly([1, 2], 0)).toEqual([]);
  });
});

describe("downscale", () => {
  it("is a no-op at matching dims", () => {
    const f = solid(4, 4, 10, 20, 30);
    expect(downscale(f, 4, 4)).toBe(f);
  });
  it("averages a solid colour to itself", () => {
    const f = solid(8, 8, 100, 150, 200);
    const out = downscale(f, 4, 4);
    expect(out.width).toBe(4);
    expect(out.height).toBe(4);
    // Solid input → every output pixel keeps the colour.
    expect(out.data[0]).toBe(100);
    expect(out.data[1]).toBe(150);
    expect(out.data[2]).toBe(200);
    expect(out.data[3]).toBe(255);
  });
});

describe("decodePng + encodeGif round-trip", () => {
  it("decodes a PNG back to the source pixels", () => {
    const png = toPng(solid(3, 2, 1, 2, 3));
    const f = decodePng(png);
    expect(f.width).toBe(3);
    expect(f.height).toBe(2);
    expect(f.data[0]).toBe(1);
    expect(f.data[1]).toBe(2);
    expect(f.data[2]).toBe(3);
  });
  it("encodes frames into a GIF89a stream", () => {
    const bytes = encodeGif([solid(4, 4, 255, 0, 0), solid(4, 4, 0, 0, 255)], 500);
    const magic = Buffer.from(bytes.slice(0, 6)).toString("ascii");
    expect(magic).toBe("GIF89a");
    expect(bytes.length).toBeGreaterThan(0);
  });
});

describe("renderGifFromDir", () => {
  const mkdir = () => fs.mkdtempSync(path.join(os.tmpdir(), "gif-test-"));

  it("is a clean no-op on an empty/absent dir", () => {
    const dir = mkdir();
    const out = path.join(dir, "demo.gif");
    const res = renderGifFromDir({
      framesDir: path.join(dir, "does-not-exist"),
      out,
      maxWidth: 800,
      maxFrames: 60,
      maxBytes: 10_000_000,
      delayMs: 600,
    });
    expect(res).toEqual({ gifPath: "", frameCount: 0, bytes: 0, width: 0, height: 0 });
    expect(fs.existsSync(out)).toBe(false);
  });

  it("stitches frames in lexical order and writes a GIF", () => {
    const dir = mkdir();
    // Deliberately write out of order; the sort must reorder them.
    fs.writeFileSync(path.join(dir, "story-0002.png"), toPng(solid(20, 16, 0, 255, 0)));
    fs.writeFileSync(path.join(dir, "story-0000.png"), toPng(solid(20, 16, 255, 0, 0)));
    fs.writeFileSync(path.join(dir, "story-0001.png"), toPng(solid(20, 16, 0, 0, 255)));
    // A non-PNG must be ignored.
    fs.writeFileSync(path.join(dir, "notes.txt"), "ignore me");
    const out = path.join(dir, "demo.gif");
    const res = renderGifFromDir({
      framesDir: dir,
      out,
      maxWidth: 800,
      maxFrames: 60,
      maxBytes: 10_000_000,
      delayMs: 400,
    });
    expect(res.frameCount).toBe(3);
    expect(res.gifPath).toBe(out);
    expect(fs.existsSync(out)).toBe(true);
    const written = fs.readFileSync(out);
    expect(written.slice(0, 6).toString("ascii")).toBe("GIF89a");
  });

  it("with `match`, stitches only the frames for one chapter", () => {
    const dir = mkdir();
    // Two chapters share the frames dir, named `${story}-NNNN.png`.
    fs.writeFileSync(path.join(dir, "Sign up-0000.png"), toPng(solid(20, 16, 255, 0, 0)));
    fs.writeFileSync(path.join(dir, "Sign up-0001.png"), toPng(solid(20, 16, 0, 255, 0)));
    fs.writeFileSync(path.join(dir, "Checkout-0000.png"), toPng(solid(20, 16, 0, 0, 255)));
    const out = path.join(dir, "chapter-0.gif");
    const res = renderGifFromDir({
      framesDir: dir,
      out,
      maxWidth: 800,
      maxFrames: 60,
      maxBytes: 10_000_000,
      delayMs: 400,
      match: "Sign up-",
    });
    // Only the two "Sign up-" frames — the "Checkout-" frame is excluded.
    expect(res.frameCount).toBe(2);
    expect(res.gifPath).toBe(out);
    expect(fs.readFileSync(out).slice(0, 6).toString("ascii")).toBe("GIF89a");
  });

  it("with a `match` that hits no frames, is a clean no-op", () => {
    const dir = mkdir();
    fs.writeFileSync(path.join(dir, "story-0000.png"), toPng(solid(20, 16, 255, 0, 0)));
    const out = path.join(dir, "chapter-9.gif");
    const res = renderGifFromDir({
      framesDir: dir,
      out,
      maxWidth: 800,
      maxFrames: 60,
      maxBytes: 10_000_000,
      delayMs: 400,
      match: "nonexistent-",
    });
    expect(res).toEqual({ gifPath: "", frameCount: 0, bytes: 0, width: 0, height: 0 });
    expect(fs.existsSync(out)).toBe(false);
  });

  it("respects the byte budget by dropping frames, not failing", () => {
    const dir = mkdir();
    // 24 noisy frames so the unbudgeted GIF is comfortably large.
    for (let i = 0; i < 24; i++) {
      const f = solid(120, 90, (i * 37) % 256, (i * 91) % 256, (i * 53) % 256);
      // sprinkle per-pixel noise so quantisation can't collapse it to nothing
      for (let p = 0; p < f.width * f.height; p++) {
        f.data[p * 4] = (p * (i + 1)) % 256;
      }
      fs.writeFileSync(
        path.join(dir, `story-${String(i).padStart(4, "0")}.png`),
        toPng(f),
      );
    }
    const out = path.join(dir, "demo.gif");
    const res = renderGifFromDir({
      framesDir: dir,
      out,
      maxWidth: 120,
      maxFrames: 60,
      maxBytes: 4000, // tiny budget → must thin frames
      delayMs: 400,
    });
    expect(res.frameCount).toBeLessThan(24);
    expect(res.frameCount).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(out)).toBe(true);
  });
});
