import { it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { describe, expect } from "vitest";
import { makeCFRuntimeTest } from "@fractalboxdev/flare-dispatch-core/testing";
import { contextfulRelease, contextfulReleaseCell } from "./contextful-release";

const sha = "a".repeat(40);
const repo = "fractalboxdev/contextful";

describe("contextful-release", () => {
  it.effect("refuses failed authoritative plan discovery before any release cell admission", () => {
    const { layer, handles } = makeCFRuntimeTest({
      github: { files: { [`${repo}:Cargo.toml`]: '[workspace.package]\nversion = "0.5.0"\n' } },
      sandboxProgram: { "release --plan": { exitCode: 1, stdout: "" } },
      childRuns: { pollFn: (ids) => ids.map((executionId) => ({ executionId, status: "failure" })) },
    });
    return Effect.gen(function* () {
      const result = yield* Effect.exit(contextfulRelease.run({ repo, tag: "v0.5.0", sha, dryRun: true }));
      expect(Exit.isFailure(result)).toBe(true);
      expect(handles.childRuns.spawned).toHaveLength(0);
      expect(handles.sandbox.execs.some((exec) => exec.command.includes("release --plan"))).toBe(true);
      expect(handles.github.createReleaseCalls).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it("subscribes only to live version-tag pushes from the release repository", () => {
    const trigger = contextfulRelease.triggers![0]!;
    const base = { repository: { full_name: repo }, ref: "refs/tags/v0.5.0", after: sha };
    expect(trigger.gate!({ payload: base })).toBe(true);
    expect(trigger.gate!({ payload: { ...base, after: "0".repeat(40) } })).toBe(false);
    expect(trigger.gate!({ payload: { ...base, ref: "refs/heads/main" } })).toBe(false);
    expect(trigger.gate!({ payload: { ...base, repository: { full_name: "other/repo" } } })).toBe(false);
    expect(trigger.inputs({ payload: base })).toEqual({ repo, tag: "v0.5.0", sha, dryRun: false });
  });

  it.effect("builds and stages a dry-run cell without publishing", () => {
    const profile = "contextful-control";
    const target = "aarch64-unknown-linux-musl";
    const stem = `contextful-control-0.5.0-${target}`;
    const manifest = JSON.stringify({ profile, target, archive: `${stem}.tar.gz`,
      sha256: "a".repeat(64), sbom: `${stem}.cdx.json` });
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: { "sha256sum": { exitCode: 0, stdout: `${"a".repeat(64)}  asset\n` } },
      sandboxFiles: { [`/workspace/contextful/dist/${stem}.release.json`]: manifest,
        [`/workspace/contextful/dist/${stem}.tar.gz.sha256`]: `${"a".repeat(64)}  ${stem}.tar.gz\n` },
    });
    return Effect.gen(function* () {
      const result = yield* contextfulReleaseCell.run({ repo, tag: "v0.5.0", sha,
        profile, target, releaseId: 0, dryRun: true });
      expect(result.assets).toEqual([`${stem}.tar.gz`, `${stem}.tar.gz.sha256`, `${stem}.cdx.json`]);
      expect(result.imageLayer).toBeUndefined();
      expect(handles.sandbox.execs[0]?.command).toContain("release --builder zigbuild");
      expect(handles.artifact.uploads).toHaveLength(3);
      const buildStep = handles.executions.steps.find((entry) => entry.name === "build-and-upload");
      expect(buildStep?.metadata?.["stepOpts.timeoutSec"]).toBe(14460);
      expect(buildStep?.metadata?.["stepOpts.retries"]).toBe(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("refuses an archive whose bytes differ from the release manifest digest", () => {
    const target = "aarch64-unknown-linux-musl";
    const name = `contextful-control-0.5.0-${target}`;
    const manifest = JSON.stringify({ profile: "contextful-control", target,
      archive: `${name}.tar.gz`, sha256: "b".repeat(64), sbom: `${name}.cdx.json` });
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: { "sha256sum": { exitCode: 0, stdout: `${"a".repeat(64)}  asset\n` } },
      sandboxFiles: { [`/workspace/contextful/dist/${name}.release.json`]: manifest,
        [`/workspace/contextful/dist/${name}.tar.gz.sha256`]: `${"b".repeat(64)}  ${name}.tar.gz\n` },
    });
    return Effect.gen(function* () {
      const result = yield* Effect.exit(contextfulReleaseCell.run({ repo, tag: "v0.5.0", sha,
        profile: "contextful-control", target, releaseId: 0, dryRun: true }));
      expect(Exit.isFailure(result)).toBe(true);
      expect(handles.artifact.uploads).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("refuses a checksum file that names different release bytes", () => {
    const target = "aarch64-unknown-linux-musl";
    const name = `contextful-control-0.5.0-${target}`;
    const manifest = JSON.stringify({ profile: "contextful-control", target,
      archive: `${name}.tar.gz`, sha256: "a".repeat(64), sbom: `${name}.cdx.json` });
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: { "sha256sum": { exitCode: 0, stdout: `${"a".repeat(64)}  asset\n` } },
      sandboxFiles: { [`/workspace/contextful/dist/${name}.release.json`]: manifest,
        [`/workspace/contextful/dist/${name}.tar.gz.sha256`]: `${"b".repeat(64)}  ${name}.tar.gz\n` },
    });
    return Effect.gen(function* () {
      const result = yield* Effect.exit(contextfulReleaseCell.run({ repo, tag: "v0.5.0", sha,
        profile: "contextful-control", target, releaseId: 0, dryRun: true }));
      expect(Exit.isFailure(result)).toBe(true);
      expect(handles.artifact.uploads).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("manual dry-run joins ten cells and a formula child without a release write", () => {
    const { layer, handles } = makeCFRuntimeTest({
      github: { files: { [`${repo}:Cargo.toml`]: '[workspace.package]\nversion = "0.5.0"\n' } },
      childRuns: { pollFn: (ids) => ids.map((id) => {
        if (id.startsWith("contextful-release-formula")) {
          return { executionId: id, status: "success", summaryJson: JSON.stringify({
            assets: ["contextful-control.rb", "contextful-edge.rb", "contextful-full.rb", "contextful.rb", "SHA256SUMS", "install.sh"],
          }) };
        }
        const index = Number(id.split(":").at(-1));
        const profiles = ["contextful-control", "contextful-edge", "contextful-full"];
        const cells = profiles.flatMap((profile) =>
          (profile === "contextful-control" ? ["x86_64-unknown-linux-musl", "aarch64-unknown-linux-musl"] :
            ["x86_64-unknown-linux-musl", "aarch64-unknown-linux-musl", "x86_64-apple-darwin", "aarch64-apple-darwin"])
            .map((target) => ({ profile, target })));
        const cell = cells[index]!;
        const imageLayer = cell.target === "x86_64-unknown-linux-musl" ? {
          name: `${cell.profile}-0.5.0-linux-amd64.layer.tar.gz`,
          archiveName: `${cell.profile}-0.5.0-linux-amd64.oci.tar`,
          size: 3, digest: "a".repeat(64), diffId: "b".repeat(64),
        } : undefined;
        return { executionId: id, status: "success", summaryJson: JSON.stringify({ ...cell,
          manifest: JSON.stringify({ ...cell, archive: "archive.tar.gz", sha256: "a".repeat(64), sbom: "sbom.cdx.json" }),
          ...(imageLayer === undefined ? {} : { imageLayer }),
        }) };
      }) },
    });
    return Effect.gen(function* () {
      const result = yield* contextfulRelease.run({ repo, tag: "v0.5.0", sha, dryRun: true });
      expect(result).toMatchObject({ dryRun: true, cells: 10, assets: 36, releaseId: 0 });
      expect(handles.childRuns.spawned.filter((child) => child.run === "contextful-release-cell")).toHaveLength(10);
      expect(handles.childRuns.spawned.filter((child) => child.run === "contextful-release-formula")).toHaveLength(1);
      expect(handles.github.createReleaseCalls).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("publishes a draft only after ten cells, formula assets, and three images succeed", () => {
    const profiles = ["contextful-control", "contextful-edge", "contextful-full"];
    const cells = profiles.flatMap((profile) =>
      (profile === "contextful-control" ? ["x86_64-unknown-linux-musl", "aarch64-unknown-linux-musl"] :
        ["x86_64-unknown-linux-musl", "aarch64-unknown-linux-musl", "x86_64-apple-darwin", "aarch64-apple-darwin"])
        .map((target) => ({ profile, target })));
    const { layer, handles } = makeCFRuntimeTest({
      github: { files: { [`${repo}:Cargo.toml`]: '[workspace.package]\nversion = "0.5.0"\n' } },
      childRuns: { pollFn: (ids) => ids.map((id) => {
        if (id.startsWith("contextful-release-formula")) return { executionId: id, status: "success",
          summaryJson: JSON.stringify({ assets: ["contextful-control.rb", "contextful-edge.rb",
            "contextful-full.rb", "contextful.rb", "SHA256SUMS", "install.sh"] }) };
        const cell = cells[Number(id.split(":").at(-1))]!;
        const imageLayer = cell.target === "x86_64-unknown-linux-musl" ? {
          name: `${cell.profile}-0.5.0-linux-amd64.layer.tar.gz`, size: 3,
          archiveName: `${cell.profile}-0.5.0-linux-amd64.oci.tar`,
          digest: "a".repeat(64), diffId: "b".repeat(64),
        } : undefined;
        return { executionId: id, status: "success", summaryJson: JSON.stringify({ ...cell,
          manifest: JSON.stringify({ ...cell, archive: "archive.tar.gz", sha256: "a".repeat(64), sbom: "sbom.cdx.json" }),
          ...(imageLayer === undefined ? {} : { imageLayer }),
        }) };
      }) },
    });
    handles.github.tagCommits[`${repo}:v0.5.0`] = sha;
    return Effect.gen(function* () {
      const result = yield* contextfulRelease.run({ repo, tag: "v0.5.0", sha, dryRun: false });
      expect(result).toMatchObject({ dryRun: false, releaseId: 1, cells: 10, assets: 36 });
      expect(handles.github.createReleaseCalls).toHaveLength(1);
      expect(handles.github.createReleaseCalls[0]?.draft).toBe(true);
      expect(handles.github.publishContainerImageCalls).toHaveLength(3);
      expect(handles.github.publishReleaseCalls).toEqual([{ repo, releaseId: 1 }]);
      expect(handles.github.releases[`${repo}:v0.5.0`]?.draft).toBe(false);
    }).pipe(Effect.provide(layer));
  });
});
