// Unit coverage for the pure helpers `artifact-r2.ts` uses on the
// container-tar branch. The Layer itself imports `@cloudflare/sandbox` for
// the live `getSandbox` call, which Node + Vitest can't resolve outside a
// `vitest-pool-workers` environment — same split as `sandbox-clone-url.ts`.

import { describe, expect, it } from "vitest";
import {
  containerTarballPath,
  isRegularFileStat,
  splitTarPath,
} from "./artifact-tar-path";

describe("splitTarPath", () => {
  it("splits an absolute directory path into parent + basename", () => {
    expect(splitTarPath("/workspace/repo/.tmp/demo-runs")).toEqual({
      parent: "/workspace/repo/.tmp",
      basename: "demo-runs",
    });
  });

  it("strips a trailing slash before splitting", () => {
    expect(splitTarPath("/workspace/repo/.tmp/demo-runs/")).toEqual({
      parent: "/workspace/repo/.tmp",
      basename: "demo-runs",
    });
  });

  it("handles a top-level absolute path", () => {
    expect(splitTarPath("/build")).toEqual({ parent: "/", basename: "build" });
  });

  it("treats a relative path with no slash as `./<basename>`", () => {
    // Relative paths keep `tar -C .` semantics — the run's CWD is the
    // implicit root, matching how the caller would have invoked tar by hand.
    expect(splitTarPath("dist")).toEqual({ parent: ".", basename: "dist" });
  });

  it("splits a relative nested path", () => {
    expect(splitTarPath("packages/web/dist")).toEqual({
      parent: "packages/web",
      basename: "dist",
    });
  });

  it("normalises an empty input — caller should reject upstream", () => {
    expect(splitTarPath("")).toEqual({ parent: ".", basename: "" });
    expect(splitTarPath("/")).toEqual({ parent: ".", basename: "" });
  });
});

describe("isRegularFileStat", () => {
  it("recognises a regular file (with stray whitespace)", () => {
    expect(isRegularFileStat("regular file\n")).toBe(true);
    expect(isRegularFileStat("  regular file  ")).toBe(true);
  });

  it("recognises GNU coreutils' zero-byte spelling", () => {
    // `stat -c %F` on an empty file prints "regular empty file" — it must
    // still stream un-tarred (an empty screenshot is a caller bug, but a
    // gzip archive of it would be a worse one).
    expect(isRegularFileStat("regular empty file")).toBe(true);
  });

  it("routes directories and everything else to the tar branch", () => {
    expect(isRegularFileStat("directory")).toBe(false);
    expect(isRegularFileStat("symbolic link")).toBe(false);
    expect(isRegularFileStat("")).toBe(false);
    expect(isRegularFileStat("stat: cannot statx")).toBe(false);
  });
});

describe("containerTarballPath", () => {
  it("composes /tmp/fd-artifact-<name>-<suffix>.tar.gz for a clean name", () => {
    expect(containerTarballPath("demo-bundle", "abc123")).toBe(
      "/tmp/fd-artifact-demo-bundle-abc123.tar.gz",
    );
  });

  it("sanitises `/`, spaces, and other unsafe chars to `-`", () => {
    // Otherwise an artifact name with a `/` would escape `/tmp/` and a name
    // with spaces would break the bash tar invocation.
    expect(containerTarballPath("step logs/run.log", "x")).toBe(
      "/tmp/fd-artifact-step-logs-run.log-x.tar.gz",
    );
  });

  it("falls back to `artifact` when the sanitised name is empty", () => {
    expect(containerTarballPath("///", "z")).toBe(
      "/tmp/fd-artifact-artifact-z.tar.gz",
    );
  });

  it("strips leading + trailing dashes from the sanitised stem", () => {
    expect(containerTarballPath("--weird--", "q")).toBe(
      "/tmp/fd-artifact-weird-q.tar.gz",
    );
  });
});
