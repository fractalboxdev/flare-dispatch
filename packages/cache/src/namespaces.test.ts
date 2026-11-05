import { describe, expect, it } from "vitest";
import { leaseCacheFields } from "./lease.ts";
import {
  cacheNamespaces,
  capacityNamespaces,
  CONTENT_NAMESPACE,
  executionNamespace,
  protectedCloud,
  protectedDevice,
  pullRequestNamespace,
  repoOfNamespace,
  tierOf,
  type CacheExecution,
} from "./namespaces.ts";

const REPO = "acme/widgets";
const base: CacheExecution = {
  repo: "Acme/Widgets",
  executionId: "e-1",
  class: "batch",
  constraints: [],
  trigger: { _tag: "Other" },
};
const push = (ref: string, isProtected: boolean): CacheExecution => ({
  ...base,
  trigger: { _tag: "Push", ref, protected: isProtected },
});
const pr = (number: number): CacheExecution => ({ ...base, trigger: { _tag: "PullRequest", number } });
const KINDS = ["cloudflare", "aws", "device", "gha"] as const;
const TRIGGERS: CacheExecution[] = [
  push("refs/heads/main", true),
  push("refs/heads/feature", false),
  push("refs/heads/gh-readonly-queue/main/pr-1", true),
  pr(7),
  { ...base, trigger: { _tag: "MergeGroup" } },
  base,
];

describe("cache namespaces and tiers", () => {
  it("FD-CACHE-015 the binding returns readable and writable namespaces from the execution and the executor kind", () => {
    expect(cacheNamespaces(push("refs/heads/main", true), "cloudflare")).toEqual({
      read: [protectedCloud(REPO), CONTENT_NAMESPACE],
      write: protectedCloud(REPO),
    });
    expect(cacheNamespaces(pr(7), "device")).toEqual({
      read: [pullRequestNamespace(REPO, 7), protectedCloud(REPO), protectedDevice(REPO), CONTENT_NAMESPACE],
      write: pullRequestNamespace(REPO, 7),
    });
  });

  it("FD-CACHE-015 FD-CACHE-021 the capacity grant gives a capacity lease only its own execution namespace to write", () => {
    const n = capacityNamespaces({ repo: REPO, leaseId: "cap-1" });
    expect(n.write).toBe(executionNamespace(REPO, "cap-1"));
    expect(n.read[0]).toBe(executionNamespace(REPO, "cap-1"));
  });

  it("FD-CACHE-016 the lease fields come from the execution row, never from a namespace a run input names", async () => {
    const execution = { ...pr(7), inputs: { cache_namespaces: { write: protectedCloud(REPO) } } };
    const fields = await leaseCacheFields(
      execution,
      { epoch: 1, executorKind: "cloudflare", deadlineAt: 1 },
      { publicOrigin: undefined, tokenSecret: undefined },
    );
    expect(fields.cache_namespaces.write).toBe(pullRequestNamespace(REPO, 7));
  });

  it("FD-CACHE-017 only a protected trigger on cloudflare or aws writes protected-cloud", () => {
    for (const t of TRIGGERS)
      for (const kind of KINDS) {
        const w = cacheNamespaces(t, kind).write;
        if (w !== null && tierOf(w) === "protected-cloud") {
          expect(t).toEqual(push("refs/heads/main", true));
          expect(["cloudflare", "aws"]).toContain(kind);
        }
      }
    expect(cacheNamespaces(push("refs/heads/main", true), "aws").write).toBe(protectedCloud(REPO));
  });

  it("FD-CACHE-018 only a protected trigger on a device writes protected-device", () => {
    for (const t of TRIGGERS)
      for (const kind of KINDS) {
        const w = cacheNamespaces(t, kind).write;
        if (w !== null && tierOf(w) === "protected-device") {
          expect(kind).toBe("device");
          expect(t).toEqual(push("refs/heads/main", true));
        }
      }
    expect(cacheNamespaces(push("refs/heads/main", true), "device").write).toBe(protectedDevice(REPO));
  });

  it("FD-CACHE-019 a pull-request execution writes pr/<repo>/<number>", () => {
    for (const kind of ["cloudflare", "aws", "device"] as const)
      expect(cacheNamespaces(pr(42), kind).write).toBe("pr/acme/widgets/42");
  });

  it("FD-CACHE-020 a merge_group event or a gh-readonly-queue push writes nothing", () => {
    for (const kind of ["cloudflare", "aws", "device"] as const) {
      expect(cacheNamespaces({ ...base, trigger: { _tag: "MergeGroup" } }, kind).write).toBeNull();
      expect(cacheNamespaces(push("refs/heads/gh-readonly-queue/main/pr-3", true), kind).write).toBeNull();
      expect(cacheNamespaces(push("gh-readonly-queue/main/pr-3", true), kind).write).toBeNull();
    }
  });

  it("FD-CACHE-021 a rehearsal or a gha execution writes at most exec/<repo>/<execution_id>", () => {
    for (const t of TRIGGERS) expect(cacheNamespaces(t, "gha").write).toBe(executionNamespace(REPO, "e-1"));
    expect(cacheNamespaces({ ...base, trigger: { _tag: "Rehearsal" } }, "device").write).toBe(executionNamespace(REPO, "e-1"));
  });

  it("FD-CACHE-022 a protected trigger reads only protected-cloud, protected-device and content", () => {
    for (const kind of KINDS) {
      const tiers = cacheNamespaces(push("refs/heads/main", true), kind).read.map(tierOf);
      for (const t of tiers) expect(["protected-cloud", "protected-device", "content"]).toContain(t);
    }
  });

  it("FD-CACHE-023 a pull-request execution reads only its own namespace, the protected tiers and content", () => {
    for (const kind of ["cloudflare", "aws", "device"] as const)
      for (const n of cacheNamespaces(pr(7), kind).read)
        expect([pullRequestNamespace(REPO, 7), protectedCloud(REPO), protectedDevice(REPO), CONTENT_NAMESPACE]).toContain(n);
    expect(cacheNamespaces(pr(7), "cloudflare").read).not.toContain(pullRequestNamespace(REPO, 8));
  });

  it("FD-CACHE-024 a pull-request reader tries its own namespace before any protected tier", () => {
    for (const kind of ["cloudflare", "device"] as const)
      expect(cacheNamespaces(pr(7), kind).read[0]).toBe(pullRequestNamespace(REPO, 7));
  });

  it("FD-CACHE-025 an execution on a cloud executor gets no protected-device namespace", () => {
    for (const t of TRIGGERS)
      for (const kind of ["cloudflare", "aws"] as const)
        expect(cacheNamespaces(t, kind).read.map(tierOf)).not.toContain("protected-device");
  });

  it("FD-CACHE-026 every namespace of an execution belongs to its own repository", () => {
    for (const t of TRIGGERS)
      for (const kind of KINDS) {
        const n = cacheNamespaces(kind === "device" ? { ...t, trigger: { _tag: "Rehearsal" } } : t, kind);
        for (const ns of [...n.read, ...(n.write === null ? [] : [n.write])])
          if (ns !== CONTENT_NAMESPACE) expect(repoOfNamespace(ns)).toBe(REPO);
      }
    expect(cacheNamespaces({ ...pr(1), repo: "../other" }, "cloudflare")).toEqual({ read: [], write: null });
  });

  it("FD-CACHE-028 a release execution or a cloud-only one reads no namespace", () => {
    expect(cacheNamespaces({ ...push("refs/tags/v1", true), class: "release" }, "cloudflare").read).toEqual([]);
    expect(cacheNamespaces({ ...pr(1), constraints: ["cloud-only"] }, "cloudflare").read).toEqual([]);
  });

  it("FD-CACHE-008 a confidential-compute repository gets no L2 namespace and no compile-cache access", async () => {
    const fields = await leaseCacheFields(
      { ...pr(7), confidential: true },
      { epoch: 1, executorKind: "device", deadlineAt: 10 },
      { publicOrigin: "https://ci.example.com", tokenSecret: "s" },
    );
    expect(fields.cache_namespaces).toEqual({ read: [], write: null });
    expect(fields.upload_grant.compile_cache).toBeNull();
  });
});
