// The `sandbox-image` run: checks every build input is pinned, builds each image of the family for `linux/arm64` and
// `linux/amd64`, runs its smoke commands, and on a default-branch push publishes each image by digest
// (FD-GATE-076 to FD-GATE-080, FD-GATE-082).
import { Effect, Option, Schema } from "effect";
import { CommandExit, GateExec } from "./command.ts";
import { checkedOutWorkspace, jobEnv, sha256, uploadLog } from "./job.ts";
import type { SandboxImageInput } from "./inputs.ts";
import type { ImageSpec } from "./manifest.ts";
import { GateArtifacts } from "./ports.ts";
import { Outcome } from "./reasons.ts";

export const ARCHES = ["linux/arm64", "linux/amd64"] as const;
export type Arch = (typeof ARCHES)[number];
const BUILD_TIMEOUT_SEC = 1800;
const SMOKE_TIMEOUT_SEC = 300;

/** One Dockerfile's instructions, with continuation lines joined. */
const instructions = (dockerfile: string): readonly string[] =>
  dockerfile
    .replace(/\\\r?\n/g, " ")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"));

const TOOLCHAIN_CHANNEL =
  /(--default-toolchain|toolchain install|rustup default|--toolchain)\s+(stable|beta|nightly)\b/;
const DOWNLOAD = /\b(curl|wget)\b[^|;&]*?(https?:\/\/[^\s"'|;&)]+)/;

/**
 * The first build input of a Dockerfile that is not pinned (FD-GATE-078): a base image without an `@sha256:` digest,
 * a download in a `RUN` or `ADD` that no SHA-256 check covers, or a toolchain named by a channel.
 */
export const unpinnedInput = (dockerfile: string): string | undefined => {
  const stages = new Set<string>();
  for (const line of instructions(dockerfile)) {
    const [word = "", ...rest] = line.split(/\s+/);
    const op = word.toUpperCase();
    if (op === "FROM") {
      const args = rest.filter((a) => !a.startsWith("--"));
      const image = args[0] ?? "";
      // A stage built earlier in the file, or `scratch`, is no external input.
      const pinned =
        image === "scratch" ||
        stages.has(image.toLowerCase()) ||
        /@sha256:[0-9a-f]{64}$/.test(image);
      const as = args.findIndex((a) => a.toUpperCase() === "AS");
      if (as > 0 && args[as + 1] !== undefined) stages.add(args[as + 1]!.toLowerCase());
      if (!pinned) return image;
    } else if (op === "ADD") {
      const url = rest.find((a) => /^https?:\/\//.test(a));
      if (url !== undefined && !rest.some((a) => a.startsWith("--checksum=sha256:"))) return url;
    } else if (op === "RUN") {
      const channel = TOOLCHAIN_CHANNEL.exec(line);
      if (channel !== null) return `toolchain ${channel[2]}`;
      const download = DOWNLOAD.exec(line);
      if (download !== null && !/sha256sum|shasum -a 256|--checksum[= ]sha256/.test(line))
        return download[2];
    }
  }
  return undefined;
};

const tagOf = (image: ImageSpec, arch: Arch) => `fd-image-${image.name}:${arch.split("/")[1]}`;

const sh = (text: string): string => `'${text.replaceAll("'", `'\\''`)}'`;

export const buildCommand = (image: ImageSpec, arch: Arch): string =>
  `docker buildx build --platform ${arch} -f ${sh(image.dockerfile)} -t ${tagOf(image, arch)} --load ${sh(image.context ?? ".")}`;

export const smokeCommand = (image: ImageSpec, arch: Arch, command: string): string =>
  `docker run --rm --platform ${arch} ${tagOf(image, arch)} sh -c ${sh(command)}`;

export const publishCommand = (
  image: ImageSpec,
  registry: string,
  sha: string,
  metadata: string,
): string =>
  `docker buildx build --platform ${ARCHES.join(",")} -f ${sh(image.dockerfile)} -t ${registry}/${image.name}:${sha} --push --metadata-file ${sh(metadata)} ${sh(image.context ?? ".")}`;

const Metadata = Schema.Struct({
  "containerimage.digest": Schema.String.check(Schema.isPattern(/^sha256:[0-9a-f]{64}$/)),
});

/** The pushed image's digest from `buildx --metadata-file`, or `undefined`. */
export const digestOf = (metadata: string): string | undefined =>
  Option.getOrUndefined(
    Schema.decodeUnknownOption(Schema.fromJsonString(Metadata))(metadata).pipe(
      Option.map((m) => m["containerimage.digest"]),
    ),
  );

/** Whether this executor can run `linux/arm64` binaries under QEMU user-mode emulation (FD-GATE-082). */
export const EMULATION_PROBE = "test -e /proc/sys/fs/binfmt_misc/qemu-aarch64";

export const runSandboxImage = (input: SandboxImageInput) =>
  Effect.scoped(
    Effect.gen(function* () {
      const exec = yield* GateExec;
      const artifacts = yield* GateArtifacts;
      const dir = yield* checkedOutWorkspace(input);
      const logs: string[] = [];
      const run = (command: string, timeoutSec: number) =>
        exec
          .run({
            command,
            cwd: dir,
            env: jobEnv(input, "sandbox-image"),
            timeoutMs: timeoutSec * 1000,
          })
          .pipe(
            Effect.tap((r) => Effect.sync(() => logs.push(new TextDecoder().decode(r.output)))),
            Effect.map((r) => CommandExit.$is("Exited")(r.exit) && r.exit.code === 0),
          );
      const finish = (outcome: Outcome) =>
        uploadLog("sandbox-image", logs.join("")).pipe(Effect.as(outcome));

      for (const image of input.entry.images) {
        const bytes = yield* exec
          .readFile(`${dir}/${image.dockerfile}`)
          .pipe(Effect.catchTag("WorkspaceReadFailed", () => Effect.succeed(undefined)));
        if (bytes === undefined) return yield* finish(Outcome.failure("config: dockerfile"));
        const unpinned = unpinnedInput(new TextDecoder().decode(bytes));
        if (unpinned !== undefined)
          return yield* finish(Outcome.failure(`image: unpinned input ${unpinned}`));
      }
      const native = input.executorLabels.includes("linux-arm64");
      if (!native && !(yield* run(EMULATION_PROBE, 30)))
        return yield* finish(
          Outcome.failure(
            `image: ${input.entry.images[0]!.name} linux/arm64 emulation unavailable`,
          ),
        );
      for (const image of input.entry.images)
        for (const arch of ARCHES) {
          if (!(yield* run(buildCommand(image, arch), BUILD_TIMEOUT_SEC)))
            return yield* finish(Outcome.failure(`image: ${image.name} ${arch} build`));
          for (const command of image.smoke)
            if (!(yield* run(smokeCommand(image, arch, command), SMOKE_TIMEOUT_SEC)))
              return yield* finish(Outcome.failure(`image: ${image.name} ${arch} smoke`));
        }
      if (!input.publish) return yield* finish(Outcome.success());
      const registry = input.entry.registry;
      if (registry === undefined || registry.trim() === "")
        return yield* finish(Outcome.failure("config: registry"));
      const digests: Record<string, string> = {};
      for (const image of input.entry.images) {
        const metadata = `${dir}/.fd-image-${image.name}.json`;
        if (!(yield* run(publishCommand(image, registry, input.sha, metadata), BUILD_TIMEOUT_SEC)))
          return yield* finish(Outcome.failure(`image: ${image.name} ${ARCHES.join(",")} publish`));
        const digest = digestOf(new TextDecoder().decode(yield* exec.readFile(metadata)));
        if (digest === undefined)
          return yield* finish(Outcome.failure(`image: ${image.name} ${ARCHES.join(",")} digest`));
        digests[image.name] = `${registry}/${image.name}@${digest}`;
      }
      const body = new TextEncoder().encode(`${JSON.stringify(digests, null, 2)}\n`);
      yield* artifacts
        .upload("image-digests.json", body)
        .pipe(Effect.catchTag("ArtifactUploadFailed", () => Effect.void));
      process.stderr.write(`[sandbox-image] image-digests.json ${yield* sha256(body)}\n`);
      return yield* finish(Outcome.success());
    }),
  ).pipe(
    Effect.catchTags({
      CheckoutFailed: () => Effect.succeed(Outcome.failure("infra: CheckoutFailed")),
      WorkspaceReadFailed: () => Effect.succeed(Outcome.failure("infra: WorkspaceReadFailed")),
    }),
  );
