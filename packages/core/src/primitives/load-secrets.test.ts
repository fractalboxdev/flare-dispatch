// Unit tests for the `loadSecrets` primitive.
//
// Drives `loadSecrets` against an in-memory `Secrets` Layer + the IO fake:
// present keys land in the env record, unset keys are omitted and logged at
// `warn`. Prefix is ignored (deprecated — secrets are bare Worker names).

import { Cause, Effect, Exit, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";
import { Secrets, type SecretsService } from "../services/secrets";
import { makeIOFake } from "../testing";
import { loadSecrets } from "./load-secrets";

/** A `Secrets` Layer whose `get` reads from a plain in-memory store. */
const secretsLayer = (store: Record<string, string>): Layer.Layer<Secrets> =>
  Layer.succeed(Secrets, {
    get: (name) => {
      const value = store[name];
      return Effect.succeed(value !== undefined && value !== "" ? value : undefined);
    },
  } satisfies SecretsService);

/** Run `loadSecrets` against `store`, returning the env record + the IO logs. */
const runLoad = async (
  keys: readonly string[],
  store: Record<string, string>,
  opts?: { prefix?: string },
) => {
  const io = makeIOFake();
  const env = await Effect.runPromise(
    loadSecrets(keys, opts).pipe(Effect.provide(Layer.merge(secretsLayer(store), io.layer))),
  );
  return { env, logs: io.state.logs };
};

describe("loadSecrets", () => {
  it("resolves present keys into an env record", async () => {
    const { env } = await runLoad(["CLERK_SECRET_KEY", "CF_API_TOKEN"], {
      CLERK_SECRET_KEY: "sk_test_x",
      CF_API_TOKEN: "tok_y",
    });
    expect(env).toEqual({
      CLERK_SECRET_KEY: "sk_test_x",
      CF_API_TOKEN: "tok_y",
    });
  });

  it("omits an unset key and logs it at warn instead of failing", async () => {
    const { env, logs } = await runLoad(["PRESENT", "MISSING"], {
      PRESENT: "v",
    });
    expect(env).toEqual({ PRESENT: "v" });
    expect(logs).toHaveLength(1);
    expect(logs[0]?.level).toBe("warn");
    expect(logs[0]?.msg).toContain("MISSING");
  });

  it("ignores prefix — looks up the bare Worker secret name", async () => {
    const { env } = await runLoad(
      ["CLERK_SECRET_KEY"],
      { CLERK_SECRET_KEY: "sk_live" },
      { prefix: "secret/" },
    );
    expect(env).toEqual({ CLERK_SECRET_KEY: "sk_live" });
  });

  it("returns an empty record for no keys", async () => {
    const { env, logs } = await runLoad([], {});
    expect(env).toEqual({});
    expect(logs).toHaveLength(0);
  });

  it("treats an empty-string value as missing", async () => {
    const { env, logs } = await runLoad(["EMPTY"], { EMPTY: "" });
    expect(env).toEqual({});
    expect(logs).toHaveLength(1);
    expect(logs[0]?.level).toBe("warn");
  });

  it("required: true fails with SecretsMissing listing the absent keys", async () => {
    const io = makeIOFake();
    const exit = await Effect.runPromiseExit(
      loadSecrets(["PRESENT", "ABSENT"], { required: true }).pipe(
        Effect.provide(Layer.merge(secretsLayer({ PRESENT: "v" }), io.layer)),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    const err = Exit.isFailure(exit)
      ? Option.getOrUndefined(Cause.failureOption(exit.cause))
      : undefined;
    expect((err as { _tag?: string } | undefined)?._tag).toBe("SecretsMissing");
    expect((err as { keys?: readonly string[] } | undefined)?.keys).toEqual(["ABSENT"]);
  });

  it("required: true succeeds when every key is present", async () => {
    const io = makeIOFake();
    const env = await Effect.runPromise(
      loadSecrets(["A", "B"], { required: true }).pipe(
        Effect.provide(Layer.merge(secretsLayer({ A: "1", B: "2" }), io.layer)),
      ),
    );
    expect(env).toEqual({ A: "1", B: "2" });
  });
});
