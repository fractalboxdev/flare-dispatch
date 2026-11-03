// The entry of every `fd-<subcommand>` executable. mameko's `<cli>`, built as `fd`, runs `fd-<subcommand>` from `PATH`
// with the remaining arguments for every command it does not define (FD-IFC-084, MAMEKO-REL-039); the executable runs
// its one command and exits with the code of the exit-code table (FD-IFC-065). A usage error exits 2.
import { NodeServices } from "@effect/platform-node";
import { Cause, Effect, Exit, Layer } from "effect";
import { Command } from "effect/cli";
import { COMMANDS, type Subcommand } from "./commands.ts";
import { FdConfigLive } from "./config.ts";
import { CredentialStoreLive } from "./credentials.ts";
import { LocalSchedulerSocket } from "./local-scheduler.ts";
import { CloudflaredLogin } from "./login.ts";
import { OperabilityNotInstalled } from "./operability.ts";
import { EXIT, OutputLive } from "./outcome.ts";

export const VERSION = "0.0.1";

/** The services an executable runs with on a developer's device. */
export const FdLive = Layer.mergeAll(
  CredentialStoreLive,
  CloudflaredLogin,
  OperabilityNotInstalled,
  OutputLive,
  LocalSchedulerSocket,
).pipe(Layer.provideMerge(FdConfigLive));

/** Runs one subcommand with its arguments and answers its exit code; it never throws. */
export const runSubcommand = <R>(
  name: Subcommand,
  args: readonly string[],
): Effect.Effect<number, never, R> =>
  (
    Command.runWith(COMMANDS[name] as never, { version: VERSION })(args) as Effect.Effect<
      void,
      unknown,
      R
    >
  ).pipe(
    Effect.as(EXIT.ok as number),
    Effect.catch((error: unknown) =>
      Effect.succeed(
        typeof error === "object" &&
          error !== null &&
          (error as { _tag?: string })._tag === "FdExit"
          ? (error as { code: number }).code
          : EXIT.usage,
      ),
    ),
    Effect.catchDefect((defect) =>
      Effect.sync(() => {
        process.stderr.write(`internal: ${String(defect)}\n`);
        return EXIT.noVerdict;
      }),
    ),
  );

/** Runs an executable's command; a long-running one (`fd mcp`) that ends when its client closes stdin exits 0. */
export const main = (name: Subcommand): void => {
  void Effect.runPromiseExit(
    runSubcommand(name, process.argv.slice(2)).pipe(
      Effect.provide(Layer.merge(FdLive, NodeServices.layer)),
    ) as Effect.Effect<number>,
  ).then((exit) => {
    process.exitCode = Exit.isSuccess(exit)
      ? exit.value
      : Cause.hasInterruptsOnly(exit.cause)
        ? EXIT.ok
        : EXIT.noVerdict;
  });
};
