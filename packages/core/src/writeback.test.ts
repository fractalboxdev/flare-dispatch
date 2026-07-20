// Unit coverage for the pure writeback manifest validation. No I/O, no R2, no
// GitHub — every decision is exercised by feeding `validateManifest` a
// hand-built spec + manifest + a `sizeOf` stub, mirroring run-admission.test.ts.
// The runtime side (read blobs from R2, mint token, commit) lives in
// @fractalboxdev/flare-dispatch-runtime-cf and is tested there against MSW + a fake R2.

import { describe, expect, it } from "vitest";
import {
  WRITEBACK_MAX_BYTES_DEFAULT,
  decodeManifest,
  isSensitivePath,
  matchGlob,
  resolveHeadBranch,
  resolvePrMeta,
  validateManifest,
  type ValidatedEntry,
  type WritebackManifest,
  type WritebackSpec,
} from "./writeback";

const spec = (over: Partial<WritebackSpec> = {}): WritebackSpec => ({
  branch: "flare-dispatch/refresh",
  commitMessage: "chore: refresh",
  pr: { title: "t", body: "b" },
  ...over,
});

const manifest = (entries: WritebackManifest["entries"]): WritebackManifest => ({
  entries,
});

/** A size stub: every file is 10 bytes unless overridden. */
const sizeOf =
  (sizes: Record<string, number> = {}) =>
  (e: ValidatedEntry): number =>
    sizes[e.path] ?? 10;

describe("validateManifest — empty / no-op", () => {
  it("an empty manifest is a clean skip, not a failure", () => {
    const r = validateManifest(spec(), manifest([]), sizeOf());
    expect(r._kind).toBe("empty");
  });
});

describe("validateManifest — path safety", () => {
  it("accepts a plain repo-relative write", () => {
    const r = validateManifest(
      spec(),
      manifest([{ path: "fixtures/api.json" }]),
      sizeOf(),
    );
    expect(r._kind).toBe("ok");
    if (r._kind === "ok") {
      expect(r.entries).toEqual([
        { path: "fixtures/api.json", mode: "100644", deleted: false },
      ]);
    }
  });

  it("rejects a path traversal (..)", () => {
    const r = validateManifest(
      spec(),
      manifest([{ path: "../etc/passwd" }]),
      sizeOf(),
    );
    expect(r._kind).toBe("rejected");
    if (r._kind === "rejected") {
      expect(r.reasons.some((x) => x.kind === "path-traversal")).toBe(true);
    }
  });

  it("rejects an absolute path", () => {
    const r = validateManifest(spec(), manifest([{ path: "/abs" }]), sizeOf());
    expect(r._kind).toBe("rejected");
    if (r._kind === "rejected") {
      expect(r.reasons[0]?.kind).toBe("absolute-path");
    }
  });

  it("rejects a Windows-drive absolute path", () => {
    const r = validateManifest(
      spec(),
      manifest([{ path: "C:/x" }]),
      sizeOf(),
    );
    expect(r._kind).toBe("rejected");
    if (r._kind === "rejected") {
      expect(r.reasons[0]?.kind).toBe("absolute-path");
    }
  });

  it("rejects empty/'.' segments (a//b, ./a)", () => {
    const r = validateManifest(
      spec(),
      manifest([{ path: "a//b" }, { path: "./c" }]),
      sizeOf(),
    );
    expect(r._kind).toBe("rejected");
    if (r._kind === "rejected") {
      expect(r.reasons.every((x) => x.kind === "dot-segment")).toBe(true);
    }
  });

  it("rejects a duplicate path", () => {
    const r = validateManifest(
      spec(),
      manifest([{ path: "a.txt" }, { path: "a.txt" }]),
      sizeOf(),
    );
    expect(r._kind).toBe("rejected");
    if (r._kind === "rejected") {
      expect(r.reasons.some((x) => x.kind === "duplicate-path")).toBe(true);
    }
  });

  it("collects ALL reasons at once, not just the first", () => {
    const r = validateManifest(
      spec(),
      manifest([{ path: "/abs" }, { path: "../up" }]),
      sizeOf(),
    );
    expect(r._kind).toBe("rejected");
    if (r._kind === "rejected") expect(r.reasons).toHaveLength(2);
  });
});

describe("validateManifest — deletions", () => {
  it("accepts a deletion entry and carries the flag through", () => {
    const r = validateManifest(
      spec(),
      manifest([{ path: "stale.json", deleted: true }]),
      sizeOf(),
    );
    expect(r._kind).toBe("ok");
    if (r._kind === "ok") {
      expect(r.entries[0]).toEqual({
        path: "stale.json",
        mode: "100644",
        deleted: true,
      });
    }
  });

  it("a deletion contributes 0 to the size cap", () => {
    const r = validateManifest(
      spec({ maxBytes: 5 }),
      manifest([{ path: "huge", deleted: true }]),
      sizeOf({ huge: 1_000_000 }),
    );
    expect(r._kind).toBe("ok");
  });
});

describe("validateManifest — allowlist", () => {
  it("accepts a path matching an allowlist glob", () => {
    const r = validateManifest(
      spec({ pathAllowlist: ["fixtures/**", "docs/*.md"] }),
      manifest([{ path: "fixtures/a/b.json" }, { path: "docs/x.md" }]),
      sizeOf(),
    );
    expect(r._kind).toBe("ok");
  });

  it("rejects a path matching no allowlist glob", () => {
    const r = validateManifest(
      spec({ pathAllowlist: ["fixtures/**"] }),
      manifest([{ path: "src/secret.ts" }]),
      sizeOf(),
    );
    expect(r._kind).toBe("rejected");
    if (r._kind === "rejected") {
      expect(r.reasons[0]?.kind).toBe("not-allowlisted");
    }
  });
});

describe("validateManifest — size + count caps", () => {
  it("rejects when total bytes exceed the cap", () => {
    const r = validateManifest(
      spec({ maxBytes: 15 }),
      manifest([{ path: "a" }, { path: "b" }]), // 10 + 10 = 20 > 15
      sizeOf(),
    );
    expect(r._kind).toBe("rejected");
    if (r._kind === "rejected") {
      expect(r.reasons.some((x) => x.kind === "too-large")).toBe(true);
    }
  });

  it("rejects when file count exceeds the cap", () => {
    const r = validateManifest(
      spec({ maxFiles: 1 }),
      manifest([{ path: "a" }, { path: "b" }]),
      sizeOf(),
    );
    expect(r._kind).toBe("rejected");
    if (r._kind === "rejected") {
      expect(r.reasons.some((x) => x.kind === "too-many-files")).toBe(true);
    }
  });

  it("uses the default byte cap when unset", () => {
    const r = validateManifest(
      spec(),
      manifest([{ path: "a" }]),
      sizeOf({ a: WRITEBACK_MAX_BYTES_DEFAULT + 1 }),
    );
    expect(r._kind).toBe("rejected");
  });
});

describe("validateManifest — .github/workflows gate", () => {
  it("rejects a workflow file without the opt-in", () => {
    const r = validateManifest(
      spec(),
      manifest([{ path: ".github/workflows/ci.yml" }]),
      sizeOf(),
    );
    expect(r._kind).toBe("rejected");
    if (r._kind === "rejected") {
      expect(r.reasons[0]?.kind).toBe("workflows-not-opted-in");
    }
  });

  it("accepts a workflow file when the run opts in", () => {
    const r = validateManifest(
      spec({ allowWorkflows: true }),
      manifest([{ path: ".github/workflows/ci.yml" }]),
      sizeOf(),
    );
    expect(r._kind).toBe("ok");
  });

  it("a non-workflow .github path is unaffected by the gate", () => {
    const r = validateManifest(
      spec(),
      manifest([{ path: ".github/dependabot.yml" }]),
      sizeOf(),
    );
    expect(r._kind).toBe("ok");
  });
});

describe("matchGlob (pure)", () => {
  it("trailing /** matches any depth (and the dir itself)", () => {
    expect(matchGlob("fixtures/**", "fixtures/a.json")).toBe(true);
    expect(matchGlob("fixtures/**", "fixtures/a/b/c.json")).toBe(true);
    expect(matchGlob("fixtures/**", "fixtures")).toBe(true);
    expect(matchGlob("fixtures/**", "src/a.json")).toBe(false);
  });

  it("* matches within a single segment only", () => {
    expect(matchGlob("docs/*.md", "docs/x.md")).toBe(true);
    expect(matchGlob("docs/*.md", "docs/sub/x.md")).toBe(false);
  });

  it("is anchored — a partial match does not pass", () => {
    expect(matchGlob("a.txt", "xa.txt")).toBe(false);
    expect(matchGlob("a.txt", "a.txt.bak")).toBe(false);
  });
});

describe("resolveHeadBranch", () => {
  it("returns a fixed branch as-is (the stable bot branch)", () => {
    expect(resolveHeadBranch("flare-dispatch/refresh", "exec123")).toBe(
      "flare-dispatch/refresh",
    );
  });

  it("suffixes a { prefix } with the execution id (fresh per run)", () => {
    expect(resolveHeadBranch({ prefix: "fd/wb" }, "exec123")).toBe(
      "fd/wb-exec123",
    );
  });
});

describe("decodeManifest", () => {
  it("decodes a well-formed manifest", () => {
    const m = decodeManifest({
      entries: [{ path: "a", mode: "100755", deleted: false }],
    });
    expect(m.entries[0]?.mode).toBe("100755");
  });

  it("throws on a malformed manifest (missing entries)", () => {
    expect(() => decodeManifest({})).toThrow();
  });

  it("throws on an invalid mode", () => {
    expect(() => decodeManifest({ entries: [{ path: "a", mode: "777" }] })).toThrow();
  });
});

describe("sensitive-path gate (security review #8)", () => {
  const sensitive = [
    "package.json",
    "apps/web/package.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "Cargo.lock",
    "go.sum",
    ".npmrc",
    ".yarnrc.yml",
    "Dockerfile",
    "infra/Dockerfile.sandbox",
    "service.Dockerfile",
    ".github/actions/x/action.yml",
    ".gitlab-ci.yml",
  ];

  it.each(sensitive)("rejects %s without allowSensitivePaths", (path) => {
    const r = validateManifest(spec(), manifest([{ path }]), sizeOf());
    expect(r._kind).toBe("rejected");
    if (r._kind === "rejected") {
      expect(r.reasons.some((x) => x.kind === "sensitive-not-opted-in")).toBe(true);
    }
  });

  it.each(sensitive)("allows %s with allowSensitivePaths", (path) => {
    const r = validateManifest(spec({ allowSensitivePaths: true }), manifest([{ path }]), sizeOf());
    expect(r._kind).toBe("ok");
  });

  it("ordinary src files are not sensitive", () => {
    const r = validateManifest(spec(), manifest([{ path: "src/handler.ts" }]), sizeOf());
    expect(r._kind).toBe("ok");
  });

  it("isSensitivePath classifies correctly", () => {
    expect(isSensitivePath("package.json")).toBe(true);
    expect(isSensitivePath("src/package.json")).toBe(true);
    expect(isSensitivePath("src/handler.ts")).toBe(false);
    expect(isSensitivePath("README.md")).toBe(false);
  });

  it("is case-insensitive (no cased bypass)", () => {
    expect(isSensitivePath("Package.json")).toBe(true);
    expect(isSensitivePath("PACKAGE.JSON")).toBe(true);
    expect(isSensitivePath("infra/DockerFile")).toBe(true);
    expect(isSensitivePath(".NPMRC")).toBe(true);
    expect(isSensitivePath("Gemfile.lock")).toBe(true);
  });
});

describe("resolvePrMeta — runtime PR body/labels override", () => {
  const basePr = { title: "t", body: "static", labels: ["self-heal"] } as const;

  it("returns the static pr when no meta", () => {
    expect(resolvePrMeta(basePr, undefined)).toEqual(basePr);
  });

  it("overrides body and unions+dedupes labels", () => {
    const r = resolvePrMeta(basePr, { body: "✅ verified", labels: ["self-heal", "self-heal:verified"] });
    expect(r).not.toBe(false);
    if (r !== false) {
      expect(r.body).toBe("✅ verified");
      expect([...(r.labels ?? [])].sort()).toEqual(["self-heal", "self-heal:verified"].sort());
    }
  });

  it("ignores meta for a push-only (false) pr", () => {
    expect(resolvePrMeta(false, { body: "x" })).toBe(false);
  });
});
