// The overlay values the Worker reads at runtime. The renderer writes each into the Worker's `vars` from its overlay
// path, so the deployed Worker and the overlay hold one value; secrets are Worker secrets (runbook R14).
import { Effect, Schema } from "effect";
import { decodeStrict } from "./decode.ts";

const NonEmpty = Schema.String.check(Schema.isMinLength(1));
/** A var the renderer writes from a JSON array, which wrangler delivers as the array or as its JSON text. */
const StringList = Schema.Union([
  Schema.Array(NonEmpty),
  Schema.fromJsonString(Schema.Array(NonEmpty)),
]);

/** The runtime configuration: `vars` rendered from the overlay plus the secrets the routes need. */
export const OpsConfig = Schema.Struct({
  /** `alerts.sink`. */
  ALERT_SINK: Schema.optional(NonEmpty),
  /** `access.teamDomain`, `access.aud`. */
  ACCESS_TEAM_DOMAIN: Schema.optional(Schema.String),
  ACCESS_AUD: Schema.optional(Schema.String),
  /** `operators`, `dispatchers`. */
  OPERATORS: Schema.optional(StringList),
  DISPATCHERS: Schema.optional(StringList),
  /** `github.fixtureRepo`. */
  GITHUB_FIXTURE_REPO: Schema.optional(NonEmpty),
  /** `alerts.webhookSilentHours`, default 24. */
  WEBHOOK_SILENT_HOURS: Schema.optional(Schema.Union([Schema.Number, Schema.NumberFromString])),
  /** A Worker secret: the install-state key (FD-OPS-073). The link bindings are the API configuration's. */
  INSTALL_STATE_KEY: Schema.optional(NonEmpty),
});
export type OpsConfig = typeof OpsConfig.Type;

const KEYS = Object.keys(OpsConfig.fields);

/** Reads the runtime configuration from a Worker's env, ignoring every binding outside `OpsConfig`. */
export const opsConfigFrom = (env: Readonly<Record<string, unknown>>) =>
  decodeStrict(
    OpsConfig,
    Object.fromEntries(
      KEYS.filter((k) => env[k] !== undefined && env[k] !== "").map((k) => [k, env[k]]),
    ),
  ).pipe(
    Effect.mapError(
      (issues) => new ConfigInvalid({ issues: issues.map((i) => `${i.path}: ${i.message}`) }),
    ),
  );

/** The runtime configuration does not decode; the routes that read it answer `misconfigured`. */
export class ConfigInvalid extends Schema.TaggedError<ConfigInvalid>()("ConfigInvalid", {
  issues: Schema.Array(Schema.String),
}) {}

export const webhookSilentHours = (c: OpsConfig): number => {
  const v = c.WEBHOOK_SILENT_HOURS;
  return typeof v === "number" && v >= 1 ? v : 24;
};
