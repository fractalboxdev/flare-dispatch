import { Effect, Schema } from "effect";
import { artifact, defineRun, github, handoffChildAdmission, sandbox, step } from "@fractalboxdev/flare-dispatch-core";
import { fanOut, waitForChildren, workspace } from "@fractalboxdev/flare-dispatch-core/primitives";

const REPO = "fractalboxdev/contextful";
const VERSION_TAG = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/;
const SHA = /^[a-f0-9]{40}$/;
const PROFILES = ["contextful-control", "contextful-edge", "contextful-full"] as const;
const LINUX = ["x86_64-unknown-linux-musl", "aarch64-unknown-linux-musl"] as const;
const DARWIN = ["x86_64-apple-darwin", "aarch64-apple-darwin"] as const;
const RELEASE_BUILD_TIMEOUT_SEC = 14400;
const RELEASE_STEP_HEADROOM_SEC = 60;
const CELLS = PROFILES.flatMap((profile) =>
  (profile === "contextful-control" ? LINUX : [...LINUX, ...DARWIN]).map((target) => ({
    profile,
    target,
  })),
);

const DeclaredReleaseCell = Schema.Struct({
  profile: Schema.Literal(...PROFILES),
  target: Schema.Literal(...LINUX, ...DARWIN, "x86_64-pc-windows-msvc", "aarch64-pc-windows-msvc"),
});

const discoverReleasePlan = (repo: string, sha: string) => Effect.gen(function* () {
  const checkout = yield* workspace({ repo, sha });
  const result = yield* sandbox.exec({ container: checkout.container, cwd: checkout.dir,
    command: ["cargo", "run", "--locked", "-q", "-p", "contextful-ci", "--", "release", "--plan"],
    timeoutSec: 1800 });
  if (result.exitCode !== 0 || result.stdout.length > 65536)
    return yield* Effect.die(new Error("authoritative release plan unavailable"));
  const lines = result.stdout.trim().split("\n");
  if (lines.length === 0 || lines.length > 64)
    return yield* Effect.die(new Error("authoritative release plan inventory invalid"));
  const cells = yield* Effect.forEach(lines, (line) => {
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 2) return Effect.die(new Error("authoritative release plan cell invalid"));
    return Schema.decodeUnknown(DeclaredReleaseCell)({ profile: fields[0], target: fields[1] }).pipe(Effect.orDie);
  });
  if (new Set(cells.map(cell => `${cell.profile}/${cell.target}`)).size !== cells.length)
    return yield* Effect.die(new Error("authoritative release plan contains duplicate cells"));
  return cells;
});

const ReleaseInput = Schema.Struct({
  repo: Schema.String,
  tag: Schema.String,
  sha: Schema.String,
  dryRun: Schema.optional(Schema.Boolean),
});

const ReleaseCellInput = Schema.Struct({
  repo: Schema.String,
  tag: Schema.String,
  sha: Schema.String,
  profile: Schema.String,
  target: Schema.String,
  releaseId: Schema.Number,
  dryRun: Schema.Boolean,
});

const ReleaseCellOutput = Schema.Struct({
  profile: Schema.String,
  target: Schema.String,
  manifest: Schema.String,
  assets: Schema.Array(Schema.String),
  imageLayer: Schema.optional(Schema.Struct({
    name: Schema.String, archiveName: Schema.String,
    size: Schema.Number, digest: Schema.String, diffId: Schema.String,
  })),
});

const FormulaInput = Schema.Struct({
  repo: Schema.String, tag: Schema.String, sha: Schema.String,
  releaseId: Schema.Number, dryRun: Schema.Boolean, manifests: Schema.String,
});
const FormulaOutput = Schema.Struct({ assets: Schema.Array(Schema.String) });

const ReleaseOutput = Schema.Struct({
  tag: Schema.String,
  sha: Schema.String,
  dryRun: Schema.Boolean,
  releaseId: Schema.Number,
  cells: Schema.Number,
  assets: Schema.Number,
});

const stem = (profile: string, version: string, target: string): string =>
  `contextful-${profile.replace(/^contextful-/, "")}-${version}-${target}`;

const requireValidRequest = (repo: string, tag: string, sha: string): void => {
  if (repo !== REPO || !VERSION_TAG.test(tag) || !SHA.test(sha)) {
    throw new Error("release requires the configured repository, a version tag, and a full SHA");
  }
};

export const contextfulReleaseCell = defineRun({
  name: "contextful-release-cell",
  version: "1.0.0",
  sandboxImage: "release",
  inputs: ReleaseCellInput,
  outputs: ReleaseCellOutput,
  limits: { maxDurationSec: 21600, admissionMaxQueueAgeSec: 21600 },
  run: (input) =>
    step("build-and-upload", () =>
      Effect.gen(function* () {
        requireValidRequest(input.repo, input.tag, input.sha);
        if (!CELLS.some((cell) => cell.profile === input.profile && cell.target === input.target)) {
          return yield* Effect.die(new Error("release cell is outside the ten-cell matrix"));
        }
        if (!Number.isSafeInteger(input.releaseId) || (!input.dryRun && input.releaseId <= 0)) {
          return yield* Effect.die(new Error("release cell requires a valid draft release id"));
        }
        const checkout = yield* workspace({ repo: input.repo, sha: input.sha });
        const version = input.tag.slice(1);
        const name = stem(input.profile, version, input.target);
        const result = yield* sandbox.exec({
          container: checkout.container,
          cwd: checkout.dir,
          command: [
            "cargo", "run", "--locked", "-q", "-p", "contextful-ci", "--", "release",
            "--builder", "zigbuild", "--profile", input.profile,
            "--target", input.target, "--target-dir", "target/release-artifacts", "--out", "dist",
          ],
          timeoutSec: RELEASE_BUILD_TIMEOUT_SEC,
        });
        if (result.exitCode !== 0) {
          return yield* Effect.die(new Error(`release build failed for ${input.profile}/${input.target}: ${result.exitCode}`));
        }
        const manifestPath = `${checkout.dir}/dist/${name}.release.json`;
        const manifest = yield* sandbox.readFile({ container: checkout.container, path: manifestPath }).pipe(Effect.orDie);
        const parsed = JSON.parse(manifest) as { profile: string; target: string; archive: string; sha256: string; sbom: string };
        if (parsed.profile !== input.profile || parsed.target !== input.target || parsed.archive !== `${name}.tar.gz` ||
          parsed.sbom !== `${name}.cdx.json` || !/^[a-f0-9]{64}$/.test(parsed.sha256)) {
          return yield* Effect.die(new Error("release cell manifest does not match its inputs"));
        }
        const checksum = yield* sandbox.readFile({ container: checkout.container,
          path: `${checkout.dir}/dist/${parsed.archive}.sha256` }).pipe(Effect.orDie);
        if (checksum.trim() !== `${parsed.sha256}  ${parsed.archive}`) {
          return yield* Effect.die(new Error("release checksum file differs from its manifest"));
        }
        const assets = [parsed.archive, `${parsed.archive}.sha256`, parsed.sbom];
        for (const name of assets) {
          const path = `${checkout.dir}/dist/${name}`;
          const digest = yield* sandbox.exec({ container: checkout.container, command: ["sha256sum", path], timeoutSec: 120 });
          const sha256 = digest.stdout.match(/^([a-f0-9]{64})\s/)?.[1];
          if (digest.exitCode !== 0 || sha256 === undefined) return yield* Effect.die(new Error(`missing SHA-256 for ${name}`));
          if (name === parsed.archive && sha256 !== parsed.sha256) {
            return yield* Effect.die(new Error("release archive digest differs from its manifest"));
          }
          yield* artifact.upload({ name, path, container: checkout.container });
          if (!input.dryRun) yield* github.publishReleaseAsset({
            repo: input.repo, releaseId: input.releaseId, artifactName: name,
            contentType: name.endsWith(".json") ? "application/json" : name.endsWith(".gz") ? "application/gzip" : "text/plain",
            sha256,
          });
        }
        let imageLayer: { name: string; archiveName: string; size: number; digest: string; diffId: string } | undefined;
        if (input.target === "x86_64-unknown-linux-musl") {
          const layerName = `${input.profile}-${version}-linux-amd64.layer.tar.gz`;
          const archiveName = `${input.profile}-${version}-linux-amd64.oci.tar`;
          const base = `${checkout.dir}/dist/${input.profile}-${version}-image`;
          const binary = `${checkout.dir}/target/release-artifacts/${input.target}/release/contextful`;
          const footprint = yield* sandbox.exec({ container: checkout.container, cwd: checkout.dir,
            command: ["cargo", "run", "--locked", "-q", "-p", "contextful-ci", "--", "footprint",
              "--profile", input.profile, binary], timeoutSec: 600 });
          if (footprint.exitCode !== 0) return yield* Effect.die(new Error(`image footprint failed for ${input.profile}`));
          const built = yield* sandbox.exec({ container: checkout.container, cwd: checkout.dir,
            command: ["/opt/build-oci-layer.sh", binary, `${base}/root`,
              `${checkout.dir}/dist/${layerName}`, `${checkout.dir}/dist/${archiveName}`, version],
            timeoutSec: 600 });
          const lines = built.stdout.trim().split("\n");
          const diffId = lines[0]?.match(/^([a-f0-9]{64})\s/)?.[1];
          const digest = lines[1]?.match(/^([a-f0-9]{64})\s/)?.[1];
          const size = Number(lines[2]);
          if (built.exitCode !== 0 || diffId === undefined || digest === undefined || !Number.isSafeInteger(size)) {
            return yield* Effect.die(new Error("OCI image layer failed"));
          }
          yield* artifact.upload({ name: layerName, path: `${checkout.dir}/dist/${layerName}`, container: checkout.container });
          yield* artifact.upload({ name: archiveName, path: `${checkout.dir}/dist/${archiveName}`, container: checkout.container });
          imageLayer = { name: layerName, archiveName, size, digest, diffId };
        }
        return { profile: input.profile, target: input.target, manifest, assets,
          ...(imageLayer !== undefined ? { imageLayer } : {}) };
      }),
      // Some cross-target release builds exceed 30 minutes. Match the
      // sandbox's bounded four-hour command timeout and leave upload headroom;
      // retrying would restart an expensive build from scratch.
      { timeoutSec: RELEASE_BUILD_TIMEOUT_SEC + RELEASE_STEP_HEADROOM_SEC, retries: 0 },
    ),
});

export const contextfulReleaseFormula = defineRun({
  name: "contextful-release-formula",
  version: "1.0.0",
  sandboxImage: "release",
  inputs: FormulaInput,
  outputs: FormulaOutput,
  limits: { maxDurationSec: 7200, admissionMaxQueueAgeSec: 21600 },
  run: (input) => step("generate-and-upload", () => Effect.gen(function* () {
    requireValidRequest(input.repo, input.tag, input.sha);
    const manifests = JSON.parse(input.manifests) as unknown[];
    if (manifests.length !== CELLS.length) return yield* Effect.die(new Error("formula needs ten release manifests"));
    const checkout = yield* workspace({ repo: input.repo, sha: input.sha });
    const formula = yield* sandbox.exec({
      container: checkout.container, cwd: checkout.dir,
      command: ["sh", "-lc", "mkdir -p dist && printf %s \"$FD_RELEASE_MANIFEST\" > dist/release-manifest.json && cargo run --locked -q -p contextful-ci -- formula --manifest dist/release-manifest.json --dist dist --base-url \"$FD_RELEASE_BASE_URL\""],
      env: { FD_RELEASE_MANIFEST: input.manifests, FD_RELEASE_BASE_URL: `https://github.com/${REPO}/releases/download/${input.tag}` },
      timeoutSec: 1800,
    });
    if (formula.exitCode !== 0) return yield* Effect.die(new Error(`formula generation failed: ${formula.exitCode}`));
    const assets = ["contextful-control.rb", "contextful-edge.rb", "contextful-full.rb", "contextful.rb", "SHA256SUMS", "install.sh"];
    for (const name of assets) {
      const path = name.endsWith(".rb") ? `${checkout.dir}/dist/Formula/${name}` : name === "install.sh" ? `${checkout.dir}/install.sh` : `${checkout.dir}/dist/${name}`;
      const digest = yield* sandbox.exec({ container: checkout.container, command: ["sha256sum", path], timeoutSec: 120 });
      const sha256 = digest.stdout.match(/^([a-f0-9]{64})\s/)?.[1];
      if (digest.exitCode !== 0 || sha256 === undefined) return yield* Effect.die(new Error(`missing SHA-256 for ${name}`));
      yield* artifact.upload({ name, path, container: checkout.container });
      if (!input.dryRun) yield* github.publishReleaseAsset({ repo: input.repo, releaseId: input.releaseId, artifactName: name,
        contentType: "text/plain", sha256 });
    }
    return { assets };
  })),
});

export const contextfulRelease = defineRun({
  name: "contextful-release",
  version: "1.0.0",
  sandboxImage: "lean",
  inputs: ReleaseInput,
  outputs: ReleaseOutput,
  limits: { maxDurationSec: 259200, admissionMaxQueueAgeSec: 21600 },
  triggers: [{
    event: "push",
    gate: ({ payload }) => payload.repository?.full_name === REPO &&
      typeof payload.ref === "string" && payload.ref.startsWith("refs/tags/v") &&
      typeof payload.after === "string" && SHA.test(payload.after) && payload.after !== "0".repeat(40),
    idempotencyKey: ({ payload }) => `contextful-release:${String(payload.ref)}:${String(payload.after)}`,
    inputs: ({ payload }) => ({ repo: REPO, tag: String(payload.ref).slice("refs/tags/".length), sha: String(payload.after), dryRun: false }),
  }],
  run: (input) => Effect.gen(function* () {
    requireValidRequest(input.repo, input.tag, input.sha);
    const dryRun = input.dryRun !== false;
    const tag = dryRun ? { refSha: input.sha, commitSha: input.sha } :
      yield* step("resolve-tag", () => github.tagTarget({ repo: input.repo, tag: input.tag }));
    if (!dryRun && input.sha !== tag.refSha && input.sha !== tag.commitSha) {
      return yield* Effect.die(new Error("release tag no longer names the dispatched SHA"));
    }
    const onDefaultBranch = yield* step("verify-default-branch", () =>
      github.commitOnDefaultBranch({ repo: input.repo, commitSha: tag.commitSha }));
    if (!onDefaultBranch) return yield* Effect.die(new Error("release tag commit is outside the default branch"));
    const cargoToml = yield* step("read-version", () => github.readTextFile({
      repo: input.repo, path: "Cargo.toml", ref: tag.commitSha,
    }));
    const sourceVersion = cargoToml.found ? cargoToml.content.match(/^version\s*=\s*"([^"]+)"/m)?.[1] : undefined;
    if (sourceVersion !== input.tag.slice(1)) {
      return yield* Effect.die(new Error("release tag version differs from Cargo.toml"));
    }
    const cells = yield* step("discover-release-plan", () => discoverReleasePlan(input.repo, tag.commitSha));
    const release = dryRun ? { id: 0 } : yield* step("draft-release", () => Effect.gen(function* () {
      const existing = yield* github.releaseByTag({ repo: input.repo, tag: input.tag });
      if (existing !== undefined) {
        if (!existing.draft) return yield* Effect.die(new Error("release is already published"));
        return existing;
      }
      return yield* github.createRelease({ repo: input.repo, tag: input.tag, target: tag.commitSha,
        name: input.tag, body: `Release ${input.tag}`, draft: true });
    }));
    if (!dryRun && release.id <= 0) return yield* Effect.die(new Error("draft release was not created"));
    const children: Array<{ executionId: string; status: string; summaryJson?: string }> = [];
    for (let offset = 0; offset < cells.length; offset += 3) {
      const batch = cells.slice(offset, offset + 3);
      const handles = yield* step(`spawn-release-cells-${offset}`, () => fanOut({
        run: contextfulReleaseCell.name,
        items: batch,
        toInput: (cell) => ({ ...cell, repo: input.repo, tag: input.tag, sha: tag.commitSha, releaseId: release.id, dryRun }),
      }));
      if (offset === 0) yield* step("handoff-admission", () => handoffChildAdmission());
      const settled = yield* step(`await-release-cells-${offset}`, () => waitForChildren({
        ids: handles.map((handle) => handle.executionId), timeout: "12 hours", pollEvery: "30 seconds",
      }));
      children.push(...settled);
      if (settled.some((child) => child.status !== "success" || !child.summaryJson)) {
        return yield* Effect.die(new Error(`release cell batch ${offset / 3 + 1} failed`));
      }
    }
    if (children.length !== cells.length || children.some((child) => child.status !== "success" || !child.summaryJson)) {
      return yield* Effect.die(new Error("one or more release cells failed"));
    }
    const manifests = children.map((child) => {
      const output = JSON.parse(child.summaryJson!) as { manifest: string };
      return JSON.parse(output.manifest) as Record<string, unknown>;
    });
    if (!dryRun) {
      const current = yield* step("verify-tag", () => github.tagTarget({ repo: input.repo, tag: input.tag }));
      if (current.refSha !== tag.refSha || current.commitSha !== tag.commitSha) {
        return yield* Effect.die(new Error("release tag moved during build"));
      }
    }
    const formulaHandle = yield* step("spawn-formula", () => fanOut({ run: contextfulReleaseFormula.name,
      items: [JSON.stringify(manifests)],
      toInput: (manifestJson) => ({ repo: input.repo, tag: input.tag, sha: tag.commitSha,
        releaseId: release.id, dryRun, manifests: manifestJson }),
    }));
    const formulaChildren = yield* step("await-formula", () => waitForChildren({
      ids: formulaHandle.map((handle) => handle.executionId), timeout: "8 hours",
    }));
    if (formulaChildren.length !== 1 || formulaChildren[0]?.status !== "success") {
      return yield* Effect.die(new Error("release formula failed"));
    }
    const formulaAssets = (JSON.parse(formulaChildren[0].summaryJson ?? "{}") as { assets?: string[] }).assets;
    if (formulaAssets?.length !== 6) return yield* Effect.die(new Error("release formula output is incomplete"));
    const imageChildren = children.filter((child) => {
      const output = JSON.parse(child.summaryJson ?? "{}") as { target?: string };
      return output.target === "x86_64-unknown-linux-musl";
    });
    if (imageChildren.length !== 3 || imageChildren.some((child) => {
      const output = JSON.parse(child.summaryJson ?? "{}") as { profile?: string; imageLayer?: { archiveName?: string } };
      return output.imageLayer?.archiveName !== `${output.profile}-${input.tag.slice(1)}-linux-amd64.oci.tar`;
    })) return yield* Effect.die(new Error("release needs three Linux amd64 OCI image archives"));
    if (dryRun) return { tag: input.tag, sha: tag.commitSha, dryRun: true, releaseId: 0,
      cells: cells.length, assets: cells.length * 3 + formulaAssets.length };
    for (const child of imageChildren) {
      const output = JSON.parse(child.summaryJson!) as {
        profile: string; imageLayer?: { name: string; archiveName: string; size: number; digest: string; diffId: string };
      };
      if (output.imageLayer === undefined) return yield* Effect.die(new Error("release image layer is missing"));
      yield* step(`publish-image-${output.profile}`, () => github.publishContainerImage({
        repo: input.repo, profile: output.profile, version: input.tag.slice(1),
        sourceExecutionId: child.executionId,
        layerArtifactName: output.imageLayer!.name, layerSize: output.imageLayer!.size,
        layerDigest: output.imageLayer!.digest, diffId: output.imageLayer!.diffId,
      }));
    }
    const verified = yield* step("verify-tag-for-publish", () => github.tagTarget({ repo: input.repo, tag: input.tag }));
    if (verified.refSha !== tag.refSha || verified.commitSha !== tag.commitSha) {
      return yield* Effect.die(new Error("release tag moved before publish"));
    }
    yield* step("publish-release", () => github.publishRelease({ repo: input.repo, releaseId: release.id }));
    return { tag: input.tag, sha: tag.commitSha, dryRun: false, releaseId: release.id,
      cells: cells.length, assets: cells.length * 3 + formulaAssets.length };
  }),
});
