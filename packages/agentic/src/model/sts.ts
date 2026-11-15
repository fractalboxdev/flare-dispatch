// STS `AssumeRole` for the `bedrock` route (specs/model-gateway.md § Registered route kinds): the control plane signs
// the call with SigV4 under its base credentials and signs every InvokeModel with the role's temporary credentials,
// so no executor holds either (FD-MDL-024, FD-MDL-070).
import { ModelCallFailed } from "@fractalboxdev/mameko-gateway";
import { Effect } from "effect";
import { signRequest, type AwsCredentials } from "./sigv4.ts";

/** An assumed role's temporary credentials and the epoch milliseconds they expire at. */
export interface AssumedCredentials extends AwsCredentials {
  readonly sessionToken: string;
  readonly expiresAt: number;
}

export interface AssumeRoleConfig {
  /** The region of the STS endpoint the call signs for, `sts.<region>.amazonaws.com`. */
  readonly region: string;
  readonly roleArn: string;
  readonly sessionName: string;
  /** The credentials the `AssumeRole` call is signed with. */
  readonly credentials: AwsCredentials;
  readonly fetch: typeof globalThis.fetch;
  readonly now?: () => Date;
  /** The session's lifetime; 3600 s, STS's default, where unset. */
  readonly durationSeconds?: number;
}

const STS_VERSION = "2011-06-15";

const tag = (xml: string, name: string): string | undefined =>
  new RegExp(`<${name}>\\s*([^<]+?)\\s*</${name}>`).exec(xml)?.[1];

const failed = (detail: string) =>
  new ModelCallFailed({ reason: `upstream: sts AssumeRole ${detail.slice(0, 300)}` });

/** One STS `AssumeRole` call: the role's temporary credentials, or `ModelCallFailed` naming STS's answer. */
export const assumeRole = (
  config: AssumeRoleConfig,
): Effect.Effect<AssumedCredentials, ModelCallFailed> =>
  Effect.gen(function* () {
    const host = `sts.${config.region}.amazonaws.com`;
    const body = new URLSearchParams({
      Action: "AssumeRole",
      DurationSeconds: String(config.durationSeconds ?? 3600),
      RoleArn: config.roleArn,
      RoleSessionName: config.sessionName,
      Version: STS_VERSION,
    }).toString();
    const headers = yield* Effect.promise(() =>
      signRequest({
        credentials: config.credentials,
        region: config.region,
        service: "sts",
        host,
        canonicalPath: "/",
        body,
        now: (config.now ?? (() => new Date()))(),
        headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
      }),
    );
    const response = yield* Effect.tryPromise({
      try: () => config.fetch(`https://${host}/`, { method: "POST", headers, body }),
      catch: (cause) => failed(String(cause)),
    });
    const text = yield* Effect.promise(() => response.text().catch(() => ""));
    if (!response.ok) return yield* failed(`${response.status}: ${text}`);
    const accessKeyId = tag(text, "AccessKeyId");
    const secretAccessKey = tag(text, "SecretAccessKey");
    const sessionToken = tag(text, "SessionToken");
    const expiresAt = Date.parse(tag(text, "Expiration") ?? "");
    if (
      accessKeyId === undefined ||
      secretAccessKey === undefined ||
      sessionToken === undefined ||
      Number.isNaN(expiresAt)
    )
      return yield* failed("answered no credentials");
    return { accessKeyId, secretAccessKey, sessionToken, expiresAt };
  });

/** How long before expiry assumed credentials are replaced: 5 min. */
export const REFRESH_BEFORE_EXPIRY_MS = 5 * 60_000;

/**
 * The role's credentials, assumed on first use and reused until `REFRESH_BEFORE_EXPIRY_MS` before they expire. A
 * failed `AssumeRole` keeps nothing, so the next call assumes the role again.
 */
export const cachedAssumeRole = (
  config: AssumeRoleConfig,
): Effect.Effect<AwsCredentials, ModelCallFailed> => {
  let held: AssumedCredentials | undefined;
  const now = () => (config.now ?? (() => new Date()))().getTime();
  return Effect.gen(function* () {
    if (held !== undefined && now() < held.expiresAt - REFRESH_BEFORE_EXPIRY_MS) return held;
    const assumed = yield* assumeRole(config);
    held = assumed;
    return assumed;
  });
};
