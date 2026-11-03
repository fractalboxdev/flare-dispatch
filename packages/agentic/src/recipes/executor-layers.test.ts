import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { checkoutLayer, editLoopLayer, shellLayer } from "./executor-layers.ts";
import { Checkout, EditLoop, Shell } from "./services.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

describe("executor layers", () => {
  it("runs a command in the checkout and answers null for one that cannot start", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fd-shell-"));
    dirs.push(dir);
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const shell = yield* Shell;
        return yield* shell.run("pwd && exit 3");
      }).pipe(Effect.provide(shellLayer(dir))),
    );
    expect(out.exitCode).toBe(3);
    expect(out.stdout.trim().endsWith(dir.split("/").at(-1) as string)).toBe(true);
    const missing = await Effect.runPromise(
      Effect.gen(function* () {
        const loop = yield* EditLoop;
        return yield* loop.run("prompt");
      }).pipe(Effect.provide(editLoopLayer(dir, ["/nonexistent/agent"]))),
    );
    expect(missing.exitCode).toBeNull();
  });

  it("writes checkout files and refuses a path outside the checkout", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fd-checkout-"));
    dirs.push(dir);
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const checkout = yield* Checkout;
        yield* checkout.write("specs/a.md", "# A");
        const listed = yield* checkout.list("specs");
        const refused = yield* Effect.result(checkout.write("../escape.md", "x"));
        return { listed, refused };
      }).pipe(Effect.provide(checkoutLayer(dir))),
    );
    expect(result.listed).toEqual(["specs/a.md"]);
    expect(result.refused._tag).toBe("Failure");
    expect(await readFile(join(dir, "specs/a.md"), "utf8")).toBe("# A");
  });
});
