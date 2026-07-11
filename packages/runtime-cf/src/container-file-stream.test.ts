// parseStatSize — the pure half of container-file-stream.ts. The container
// calls (`exec`, `readFileStream`) can't run under vitest-pool-workers.
import { describe, expect, it } from "vitest";
import { parseStatSize } from "./container-file-stream";

describe("parseStatSize", () => {
  it("parses a plain byte count", () => {
    expect(parseStatSize("117394312\n")).toBe(117394312);
  });

  it("parses zero", () => {
    expect(parseStatSize("0")).toBe(0);
  });

  it("rejects non-numeric output", () => {
    expect(() => parseStatSize("stat: cannot stat '/tmp/x': No such file")).toThrow(
      /unparseable size/,
    );
  });

  it("rejects empty output", () => {
    expect(() => parseStatSize("")).toThrow(/unparseable size/);
  });

  it("rejects negative / mixed output", () => {
    expect(() => parseStatSize("-1")).toThrow(/unparseable size/);
    expect(() => parseStatSize("12 34")).toThrow(/unparseable size/);
  });
});
