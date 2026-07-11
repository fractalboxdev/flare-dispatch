// @fractalbox/flare-dispatch-bedrock-sigv4 — SigV4 signing core for AWS Bedrock InvokeModel
// routed through the Cloudflare AI Gateway forwarder.
//
// AWS Bedrock's HTTPS host is `bedrock-runtime.<region>.amazonaws.com`, but AI
// Gateway exposes a forwarder at
// `gateway.ai.cloudflare.com/v1/<acct>/<gw>/aws-bedrock/bedrock-runtime/<region>/model/<modelId>/invoke`
// that takes the same Bedrock body and the same SigV4-signed AWS headers and
// forwards them to AWS verbatim. The signature targets the ORIGINAL AWS host;
// the request is then `fetch()`-d at the gateway URL with those same signed
// headers — the gateway doesn't re-sign in this BYOC mode, it just adds caching
// + observability + per-org cost dashboards (it never sees the AWS creds, which
// ride in the SigV4 Authorization header it forwards).
//
// This module is the shared signing core. Two callers wrap it with their own
// request body shape + response parsing — `runtime-cf` (text-only, Worker side)
// and `demo-agent` (Anthropic Messages with tool_use, container side) — which
// previously each carried a byte-identical copy of everything below.
//
// Zero dependencies: Web Crypto (`crypto.subtle`) + `fetch`, both global in
// Workers and Node 20+, so this bundles cleanly into either target.
//
// Spec: specs/05-byoc.md § AWS federation; CF docs:
// https://developers.cloudflare.com/ai-gateway/usage/providers/bedrock/

/** Short-lived AWS credentials minted by `awsAssumeRole`. */
export type AwsCreds = {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken: string;
};

/** A Bedrock InvokeModel request to SigV4-sign and POST through the gateway. */
export type BedrockSignedRequest = {
  readonly creds: AwsCreds;
  readonly region: string;
  readonly modelId: string;
  /** The pre-serialized JSON request body (caller owns the dialect/shape). */
  readonly payload: string;
  /** Cloudflare account id — first segment of the gateway URL. */
  readonly cloudflareAccountId: string;
  /** AI Gateway slug — second segment of the gateway URL. */
  readonly gatewayId: string;
  /**
   * Optional `cf-aig-authorization` token — only when the operator's gateway
   * has [Authenticated Gateway](https://developers.cloudflare.com/ai-gateway/configuration/authentication/)
   * turned on. Orthogonal to the AWS SigV4 signature.
   */
  readonly gatewayAuthToken?: string;
  /** Optional `fetch` override for tests. */
  readonly fetchImpl?: typeof fetch;
};

/**
 * SigV4-sign `payload` for Bedrock InvokeModel and POST it through the AI
 * Gateway forwarder. The signature targets the ORIGINAL AWS hostname
 * (`bedrock-runtime.<region>.amazonaws.com`); the actual `fetch()` goes to the
 * gateway URL carrying those signed headers — the gateway forwards to AWS
 * verbatim. Returns the raw 2xx `Response` (the caller parses the body, since
 * the body shape is dialect-specific). Throws on non-2xx with the response body
 * inlined (truncated) so the caller's error boundary can name the cause.
 */
export const invokeBedrockSigned = async (
  req: BedrockSignedRequest,
): Promise<Response> => {
  const awsHost = `bedrock-runtime.${req.region}.amazonaws.com`;
  // SigV4 canonical URI requires path segments URL-encoded TWICE for canonical
  // signing. For an inference-profile id like `us.anthropic.claude-opus-4-6-v1`
  // the encoding is a no-op; for ids with `:` (older versioned ARNs) the colon
  // goes `:` → `%3A` (wire URL) → `%253A` (canonical).
  const wirePath = `/model/${encodeURIComponent(req.modelId)}/invoke`;
  const canonicalPath = `/model/${encodeURIComponent(encodeURIComponent(req.modelId))}/invoke`;
  const payload = req.payload;
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const algorithm = "AWS4-HMAC-SHA256";
  const service = "bedrock";
  const credentialScope = `${dateStamp}/${req.region}/${service}/aws4_request`;

  const payloadHash = await sha256Hex(payload);

  // The signed `host` header MUST be the AWS hostname even though the request
  // goes to the gateway — AWS validates the signature against this value, and
  // the gateway forwards the header pair through unchanged.
  const canonicalHeaders =
    `host:${awsHost}\n` +
    `x-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${amzDate}\n` +
    `x-amz-security-token:${req.creds.sessionToken}\n`;
  const signedHeaders =
    "host;x-amz-content-sha256;x-amz-date;x-amz-security-token";

  const canonicalRequest =
    `POST\n${canonicalPath}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  const stringToSign =
    `${algorithm}\n${amzDate}\n${credentialScope}\n${await sha256Hex(canonicalRequest)}`;

  const signingKey = await deriveSigningKey(
    req.creds.secretAccessKey,
    dateStamp,
    req.region,
    service,
  );
  const signature = await hmacHex(signingKey, stringToSign);

  const authorization =
    `${algorithm} Credential=${req.creds.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const gatewayUrl =
    `https://gateway.ai.cloudflare.com/v1/${req.cloudflareAccountId}/${req.gatewayId}` +
    `/aws-bedrock/bedrock-runtime/${req.region}${wirePath}`;
  const doFetch = req.fetchImpl ?? fetch;

  const headers: Record<string, string> = {
    host: awsHost,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    "x-amz-security-token": req.creds.sessionToken,
    authorization,
    "content-type": "application/json",
    accept: "application/json",
  };
  if (req.gatewayAuthToken !== undefined) {
    // Authenticated Gateway — gates access to the gateway itself, not to AWS.
    headers["cf-aig-authorization"] = `Bearer ${req.gatewayAuthToken}`;
  }

  const res = await doFetch(gatewayUrl, {
    method: "POST",
    headers,
    body: payload,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Bedrock InvokeModel via AI Gateway failed: HTTP ${res.status} — ${text.slice(0, 500)}`,
    );
  }
  return res;
};

// --- SubtleCrypto helpers (no AWS SDK) ---------------------------------------

const sha256Hex = async (data: string): Promise<string> => {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(data),
  );
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
};

const hmac = async (
  key: ArrayBuffer | Uint8Array,
  msg: string,
): Promise<ArrayBuffer> => {
  const k = await crypto.subtle.importKey(
    "raw",
    key as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg));
};

const hmacHex = async (key: ArrayBuffer, msg: string): Promise<string> => {
  const buf = await hmac(key, msg);
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
};

const deriveSigningKey = async (
  secret: string,
  dateStamp: string,
  region: string,
  service: string,
): Promise<ArrayBuffer> => {
  const kDate = await hmac(new TextEncoder().encode(`AWS4${secret}`), dateStamp);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  return hmac(kService, "aws4_request");
};
