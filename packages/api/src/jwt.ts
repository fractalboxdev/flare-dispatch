// RS256 JWT verification against a JWKS lives beside the GitHub client, which the `gha` launcher's runner claim shares
// with the Access gate and the Actions OIDC check of a dispatch.
export {
  JWKS_TTL_MS,
  JwksSource,
  JwksSourceLive,
  JwksUnavailable,
  verifyJwt,
  verifyWithJwks,
  type Claims,
  type Jwk,
  type JwtRejection,
  type JwtResult,
  type VerifyParams,
} from "@fractalboxdev/flare-dispatch-github/jwks";
