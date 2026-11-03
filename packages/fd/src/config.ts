// Where `fd` finds the control plane and the local scheduler: `FD_URL` and `FD_SCHEDULER_SOCKET`, else the `url` and
// `schedulerSocket` of `$XDG_CONFIG_HOME/flare-dispatch/config.json`. The file holds no credential (FD-IFC-067).
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Context, Effect, Layer, Schema } from "effect";
import { EXIT, FdFailure } from "./outcome.ts";

export interface FdConfigShape {
  /** The control plane's origin, with no trailing slash. */
  readonly url: string | undefined;
  /** The local scheduler's Unix socket. */
  readonly schedulerSocket: string | undefined;
}

export class FdConfig extends Context.Service<FdConfig, FdConfigShape>()(
  "@fractalboxdev/flare-dispatch-fd/FdConfig",
) {}

const ConfigFile = Schema.Struct({
  url: Schema.optionalKey(Schema.String),
  schedulerSocket: Schema.optionalKey(Schema.String),
});

const configPath = (env: NodeJS.ProcessEnv) =>
  join(env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config"), "flare-dispatch", "config.json");

const readConfigFile = (path: string): typeof ConfigFile.Type => {
  try {
    return Schema.decodeUnknownSync(Schema.fromJsonString(ConfigFile))(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
};

export const configFrom = (env: NodeJS.ProcessEnv): FdConfigShape => {
  const file = readConfigFile(configPath(env));
  const url = env["FD_URL"] ?? file.url;
  return {
    url: url?.replace(/\/+$/, ""),
    schedulerSocket: env["FD_SCHEDULER_SOCKET"] ?? file.schedulerSocket,
  };
};

export const FdConfigLive = Layer.sync(FdConfig, () => configFrom(process.env));

/** The control plane's origin, or a usage error naming how to set it. */
export const controlPlaneUrl = Effect.gen(function* () {
  const { url } = yield* FdConfig;
  if (url === undefined)
    return yield* new FdFailure({
      code: "not_configured",
      message: "no control plane: set FD_URL or url in the flare-dispatch config file",
      exitCode: EXIT.usage,
    });
  return url;
});
