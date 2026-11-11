// The profile's `delivery.limit_key` binding as intake's admission calls it: the installation that serves the
// repository, else the repository itself (specs/github-output.md § Installation quota).
import { GithubNetworkError, InstallationDirectory } from "@fractalboxdev/flare-dispatch-github";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { installationLimitKey } from "./layer.ts";

const directory = Layer.succeed(InstallationDirectory, {
  installationFor: (scope) =>
    scope === "acme/down"
      ? Effect.fail(new GithubNetworkError({ sent: false, message: "unreachable" }))
      : Effect.succeed(scope === "acme/app" ? 7 : null),
});

const keyOf = (scopeId: string) =>
  Effect.runPromise(
    Effect.flatMap(installationLimitKey, (limitKey) => limitKey(scopeId)).pipe(
      Effect.provide(directory),
    ),
  );

describe("the admission limit key", () => {
  it("[FD-GH-056] is the id of the installation that serves the repository", async () => {
    expect(await keyOf("acme/app")).toBe("7");
  });

  it("[FD-GH-056] stays the repository when no installation serves it or the directory cannot be read", async () => {
    expect(await keyOf("acme/none")).toBe("acme/none");
    expect(await keyOf("acme/down")).toBe("acme/down");
  });
});
