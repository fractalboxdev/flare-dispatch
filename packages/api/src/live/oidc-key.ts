// The control plane's OIDC signing key from the `OIDC_SIGNING_JWK` Worker secret, a private JWK. The port answers it
// whole; the well-known route serves only its public members (FD-IFC-052).
import { Effect, Layer } from "effect";
import { OidcKey } from "../ports.ts";

/** The JWK the secret holds, or `undefined` while the secret is unset or not a JSON object (FD-IFC-051). */
export const parseSigningJwk = (
  secret: string | undefined,
): Readonly<Record<string, unknown>> | undefined => {
  if (secret === undefined || secret.trim() === "") return undefined;
  try {
    const parsed: unknown = JSON.parse(secret);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
};

export const oidcKeyFromSecret = (secret: string | undefined): Layer.Layer<OidcKey> =>
  Layer.succeed(OidcKey)({ publicJwk: Effect.succeed(parseSigningJwk(secret)) });
