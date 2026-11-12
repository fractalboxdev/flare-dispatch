import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";
import { CommandExit } from "./command.ts";
import type { DispatchEvent } from "./dispatch-event.ts";
import { ctx, fakeArtifacts, fakeExec, SHA, type Scripted } from "./gate.test-support.ts";
import type { SandboxImageInput } from "./inputs.ts";
import { EMULATION_PROBE, runSandboxImage, unpinnedInput } from "./sandbox-image.ts";
import { sandboxImagePlacement } from "./spec.ts";
import { sandboxImageDecoder } from "./triggers.ts";

const PINNED = `FROM docker.io/library/node:22@sha256:${"1".repeat(64)}\nRUN echo ok\n`;
const DIGEST = `sha256:${"d".repeat(64)}`;

const imageInput = (
  publish: boolean,
  labels: readonly string[] = ["linux-arm64"],
): SandboxImageInput => ({
  ...ctx,
  entry: {
    images: [{ name: "gate", dockerfile: "infra/Dockerfile.gate", smoke: ["node --version"] }],
    registry: "ghcr.io/o/r",
  },
  publish,
  executorLabels: labels,
});

const build = (input: SandboxImageInput, script: readonly Scripted[] = [], dockerfile = PINNED) => {
  const exec = fakeExec(script, {
    "infra/Dockerfile.gate": dockerfile,
    ".fd-image-gate.json": JSON.stringify({ "containerimage.digest": DIGEST }),
  });
  const artifacts = fakeArtifacts();
  return Effect.runPromise(
    runSandboxImage(input).pipe(Effect.provide(Layer.mergeAll(exec.layer, artifacts.layer))),
  ).then((outcome) => ({
    outcome,
    commands: exec.ran.map((r) => r.command).filter((c) => !c.startsWith("git")),
    artifacts,
  }));
};

describe("sandbox-image", () => {
  it("[FD-GATE-076] builds every image for both architectures, smokes each and publishes nothing on a pull request", async () => {
    const { outcome, commands, artifacts } = await build(imageInput(false));
    expect(outcome).toEqual({ _tag: "success" });
    expect(commands.filter((c) => c.includes("buildx build --platform linux/"))).toHaveLength(2);
    expect(commands.filter((c) => c.startsWith("docker run"))).toEqual([
      "docker run --rm --platform linux/arm64 --entrypoint sh fd-image-gate:arm64 -c 'node --version'",
      "docker run --rm --platform linux/amd64 --entrypoint sh fd-image-gate:amd64 -c 'node --version'",
    ]);
    expect(commands.some((c) => c.includes("--push"))).toBe(false);
    expect(artifacts.uploads.has("image-digests.json")).toBe(false);
  });

  it("[FD-GATE-077] publishes each image by digest on a default-branch push and uploads image-digests.json", async () => {
    const { outcome, commands, artifacts } = await build(imageInput(true));
    expect(outcome).toEqual({ _tag: "success" });
    expect(commands.filter((c) => c.includes("--push"))).toHaveLength(1);
    expect(JSON.parse(artifacts.uploads.get("image-digests.json")!)).toEqual({
      gate: `ghcr.io/o/r/gate@${DIGEST}`,
    });
  });

  it("[FD-GATE-076] and [FD-GATE-077] trigger on a change under sandboxImage.paths only", () => {
    const entry = imageInput(false).entry;
    const repository = { fullName: "o/r", cloneUrl: ctx.repo, defaultBranch: "main" };
    const pr = (changedPaths: string[]): DispatchEvent => ({
      _tag: "webhook",
      deliveryId: "d",
      delivery: {
        event: "pull_request",
        action: "synchronize",
        repository,
        pullRequest: {
          number: 7,
          draft: false,
          author: "a",
          headSha: SHA,
          headRef: "f",
          baseRef: "main",
          baseSha: SHA,
        },
        changedPaths,
      },
    });
    expect(
      Option.getOrUndefined(sandboxImageDecoder(entry)(pr(["infra/v2/Dockerfile.gate"])))?.publish,
    ).toBe(false);
    expect(Option.isNone(sandboxImageDecoder(entry)(pr(["README.md"])))).toBe(true);
    const push: DispatchEvent = {
      _tag: "webhook",
      deliveryId: "d",
      delivery: {
        event: "push",
        action: "",
        repository,
        ref: "refs/heads/main",
        before: SHA,
        after: SHA,
        changedPaths: ["infra/x"],
      },
    };
    expect(Option.getOrUndefined(sandboxImageDecoder(entry)(push))?.publish).toBe(true);
  });

  it("[FD-GATE-078] refuses an unpinned base image, an unchecked download or a channel toolchain before any build", async () => {
    expect(unpinnedInput("FROM node:22\n")).toBe("node:22");
    expect(unpinnedInput(`${PINNED}FROM base AS build\n`)).toBe("base");
    expect(
      unpinnedInput(`FROM docker.io/x@sha256:${"2".repeat(64)} AS build\nFROM build\n`),
    ).toBeUndefined();
    expect(unpinnedInput(`${PINNED}RUN curl -fsSL https://example.com/tool.tgz | tar xz\n`)).toBe(
      "https://example.com/tool.tgz",
    );
    expect(
      unpinnedInput(
        `${PINNED}RUN curl -fsSLo t.tgz https://example.com/t.tgz && \\\n  echo "abc  t.tgz" | sha256sum -c -\n`,
      ),
    ).toBeUndefined();
    expect(unpinnedInput(`${PINNED}ADD https://example.com/a /a\n`)).toBe("https://example.com/a");
    expect(
      unpinnedInput(`${PINNED}ADD --checksum=sha256:${"3".repeat(64)} https://example.com/a /a\n`),
    ).toBeUndefined();
    expect(unpinnedInput(`${PINNED}RUN rustup toolchain install stable\n`)).toBe(
      "toolchain stable",
    );
    const { outcome, commands } = await build(imageInput(true), [], "FROM node:22\n");
    expect(outcome).toEqual({ _tag: "failure", reason: "image: unpinned input node:22" });
    expect(commands).toEqual([]);
  });

  it("[FD-GATE-078] passes the v2 gate image's own Dockerfile", () => {
    const dockerfile = readFileSync(
      fileURLToPath(new URL("../../../infra/v2/Dockerfile.gate", import.meta.url)),
      "utf8",
    );
    expect(unpinnedInput(dockerfile)).toBeUndefined();
  });

  it("[FD-GATE-079] publishes nothing when a build or smoke fails on either architecture", async () => {
    const failures = [
      [
        { match: "buildx build --platform linux/amd64", exit: CommandExit.Exited({ code: 1 }) },
        "image: gate linux/amd64 build",
      ],
      [
        {
          match: "--platform linux/arm64 --entrypoint sh fd-image",
          exit: CommandExit.Exited({ code: 1 }),
        },
        "image: gate linux/arm64 smoke",
      ],
    ] as const;
    for (const [failure, reason] of failures) {
      const { outcome, commands, artifacts } = await build(imageInput(true), [failure]);
      expect(outcome).toEqual({ _tag: "failure", reason });
      expect(commands.some((c) => c.includes("--push"))).toBe(false);
      expect(artifacts.uploads.has("image-digests.json")).toBe(false);
    }
  });

  it("[FD-GATE-080] places a publish at release, cloud-pinned, on a container-artifact executor", () => {
    expect(sandboxImagePlacement(true)).toEqual({
      className: "release",
      constraints: ["cloud-pinned"],
      labels: ["container-artifact"],
    });
    expect(sandboxImagePlacement(false).className).toBe("required");
  });

  it("[FD-GATE-082] smokes arm64 under emulation off a linux-arm64 executor, and refuses where emulation is absent", async () => {
    const emulated = await build(imageInput(false, []));
    expect(emulated.commands[0]).toBe(EMULATION_PROBE);
    expect(emulated.outcome).toEqual({ _tag: "success" });
    const native = await build(imageInput(false));
    expect(native.commands).not.toContain(EMULATION_PROBE);
    const absent = await build(imageInput(true, []), [
      { match: "binfmt_misc", exit: CommandExit.Exited({ code: 1 }) },
    ]);
    expect(absent.outcome).toEqual({
      _tag: "failure",
      reason: "image: gate linux/arm64 emulation unavailable",
    });
    expect(absent.commands.some((c) => c.includes("buildx"))).toBe(false);
  });
});
