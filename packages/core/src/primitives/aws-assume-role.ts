// Primitive: awsAssumeRole — exchange an OIDC token for AWS STS credentials.
//
// The workload-identity-federation pattern AWS recommends in place of
// long-lived access keys in Worker Secrets:
//
//   1. `oidc.sign({audience: "sts.amazonaws.com", subject: <run>:<exec>})`
//      mints a short-lived OIDC token signed by the Dispatcher's stable key.
//   2. POST it to `sts.amazonaws.com` as
//      `sts:AssumeRoleWithWebIdentity` along with the target role ARN.
//   3. AWS verifies the token against the Dispatcher's `/.well-known/jwks.json`
//      (the OIDC provider it has been pre-registered as), and returns
//      short-lived credentials scoped by the role's trust policy.
//
// The run hands the credentials to whatever AWS SDK it uses — the DSL ships
// no Bedrock / S3 / KMS adapters.
//
// Spec: specs/03-dsl.md § awsAssumeRole, specs/05-byoc.md § AWS federation
// trust policy.

import { Effect } from "effect";
import { StsAssumeRoleFailed } from "../errors";
import { io } from "../services/io";
import { oidc } from "../services/oidc";

/** Short-lived AWS credentials returned by `sts:AssumeRoleWithWebIdentity`. */
export type AwsCredentials = {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken: string;
  /** Epoch ms when the credentials stop being valid. */
  readonly expiresAt: number;
};

/** Default session duration when the caller omits one (AWS caps at 3600). */
const DEFAULT_DURATION_SEC = 900;

/** Parse a single XML element body from an STS response. */
const xmlText = (xml: string, tag: string): string | undefined => {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`);
  const match = re.exec(xml);
  return match?.[1]?.trim();
};

/** STS endpoint host for the given region — `sts.{region}.amazonaws.com`. */
const stsHost = (region: string): string =>
  region === "us-east-1" ? "sts.amazonaws.com" : `sts.${region}.amazonaws.com`;

export const awsAssumeRole = (opts: {
  roleArn: string;
  sessionName?: string;
  durationSec?: number;
  region?: string;
  /** OIDC audience to sign — defaults to "sts.amazonaws.com". */
  audience?: string;
  /** Override the global `fetch` (tests). */
  fetchImpl?: typeof fetch;
}) =>
  Effect.gen(function* () {
    const audience = opts.audience ?? "sts.amazonaws.com";
    const durationSec = Math.min(opts.durationSec ?? DEFAULT_DURATION_SEC, 3600);
    const sessionName = opts.sessionName ?? `flare-dispatch-${yield* io.uuid}`;
    const region = opts.region ?? "us-east-1";
    const doFetch = opts.fetchImpl ?? fetch;

    // 1. Mint the OIDC token. A signing failure propagates as
    //    `OidcSigningFailed` (typed) into the run's error channel.
    const token = yield* oidc.sign({
      audience,
      // `subject` defaults to the Dispatcher-set `<run>:<exec>`; explicit
      // sessionName-based subject would defeat the per-run scoping the spec
      // recommends. Caller may set claims for additional context if needed.
    });

    // 2. POST the AssumeRoleWithWebIdentity request. STS's web-identity
    //    endpoint is anonymous (no sigv4 required when WebIdentityToken is
    //    present), so a plain form-encoded POST is enough.
    const url = `https://${stsHost(region)}/`;
    const body = new URLSearchParams({
      Action: "AssumeRoleWithWebIdentity",
      Version: "2011-06-15",
      RoleArn: opts.roleArn,
      RoleSessionName: sessionName,
      WebIdentityToken: token.jwt,
      DurationSeconds: String(durationSec),
    }).toString();

    const res = yield* Effect.tryPromise({
      try: () =>
        doFetch(url, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body,
        }),
      catch: (_cause) =>
        new StsAssumeRoleFailed({
          provider: "aws",
          status: 0,
          reason: "other",
        }),
    });

    if (!res.ok) {
      // Best-effort reason classification from the response body — AWS
      // wraps the cause in `<Code>...</Code>`.
      const text = yield* Effect.tryPromise({
        try: () => res.text(),
        catch: () => new StsAssumeRoleFailed({
          provider: "aws",
          status: res.status,
          reason: "other",
        }),
      });
      const code = xmlText(text, "Code") ?? "";
      const reason: "mistrusted-issuer" | "role-mismatch" | "audience-mismatch" | "other" =
        /InvalidIdentityToken|UnauthorizedClient|IDPRejectedClaim/.test(code)
          ? "mistrusted-issuer"
          : /AccessDenied|AssumeRolePolicy/.test(code)
            ? "role-mismatch"
            : /Audience/.test(code)
              ? "audience-mismatch"
              : "other";
      return yield* Effect.fail(
        new StsAssumeRoleFailed({ provider: "aws", status: res.status, reason }),
      );
    }

    // 3. Parse the XML body — STS returns
    //    `AssumeRoleWithWebIdentityResponse > AssumeRoleWithWebIdentityResult > Credentials`.
    const xml = yield* Effect.tryPromise({
      try: () => res.text(),
      catch: () => new StsAssumeRoleFailed({
        provider: "aws",
        status: res.status,
        reason: "other",
      }),
    });
    const accessKeyId = xmlText(xml, "AccessKeyId") ?? "";
    const secretAccessKey = xmlText(xml, "SecretAccessKey") ?? "";
    const sessionToken = xmlText(xml, "SessionToken") ?? "";
    const expiration = xmlText(xml, "Expiration") ?? "";
    const expiresMs = expiration ? Date.parse(expiration) : Date.now() + durationSec * 1000;

    if (accessKeyId === "" || secretAccessKey === "" || sessionToken === "") {
      return yield* Effect.fail(
        new StsAssumeRoleFailed({
          provider: "aws",
          status: res.status,
          reason: "other",
        }),
      );
    }

    return {
      accessKeyId,
      secretAccessKey,
      sessionToken,
      expiresAt: Number.isNaN(expiresMs) ? Date.now() + durationSec * 1000 : expiresMs,
    } satisfies AwsCredentials;
  });
