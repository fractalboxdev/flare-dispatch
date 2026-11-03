// AWS Signature Version 4 query-string presigning, as R2's S3 endpoint accepts it. The payload is
// `UNSIGNED-PAYLOAD`; a `PUT` signs `content-length`, so R2 refuses a body of another length.
import { asBuffer, hex, sha256Hex, utf8 } from "./crypto.ts";

export interface PresignInput {
  readonly method: "GET" | "PUT";
  readonly host: string;
  /** The URI path, already starting with `/`, unencoded. */
  readonly path: string;
  readonly query?: Readonly<Record<string, string>>;
  /** Headers to sign besides `host`, lowercase names. */
  readonly headers?: Readonly<Record<string, string>>;
  readonly region: string;
  readonly service: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** `YYYYMMDDTHHMMSSZ`. */
  readonly amzDate: string;
  readonly expiresSec: number;
}

/** RFC 3986 encoding as SigV4 requires: every byte but the unreserved set, `/` kept in a path. */
export const uriEncode = (text: string, keepSlash: boolean): string =>
  Array.from(utf8(text), (b) => {
    const c = String.fromCharCode(b);
    if (/[A-Za-z0-9\-._~]/.test(c) || (keepSlash && c === "/")) return c;
    return `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
  }).join("");

const hmac = async (key: ArrayBuffer | Uint8Array, message: string) => {
  const k = await crypto.subtle.importKey(
    "raw",
    key instanceof Uint8Array ? asBuffer(key) : key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, asBuffer(utf8(message))));
};

export const amzDateOf = (ms: number) =>
  new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

/** The presigned URL for `input`. */
export const presignV4 = async (input: PresignInput): Promise<string> => {
  const date = input.amzDate.slice(0, 8);
  const scope = `${date}/${input.region}/${input.service}/aws4_request`;
  const headers: Record<string, string> = { ...input.headers, host: input.host };
  const names = Object.keys(headers).sort();
  const signedHeaders = names.join(";");
  const query: Record<string, string> = {
    ...input.query,
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${input.accessKeyId}/${scope}`,
    "X-Amz-Date": input.amzDate,
    "X-Amz-Expires": String(input.expiresSec),
    "X-Amz-SignedHeaders": signedHeaders,
  };
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((k) => `${uriEncode(k, false)}=${uriEncode(query[k]!, false)}`)
    .join("&");
  const path = uriEncode(input.path, true);
  const canonicalRequest = [
    input.method,
    path,
    canonicalQuery,
    names.map((n) => `${n}:${headers[n]!.trim()}\n`).join(""),
    signedHeaders,
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    input.amzDate,
    scope,
    await sha256Hex(canonicalRequest),
  ].join("\n");
  let key = await hmac(utf8(`AWS4${input.secretAccessKey}`), date);
  for (const part of [input.region, input.service, "aws4_request"]) key = await hmac(key, part);
  const signature = hex(await hmac(key, stringToSign));
  return `https://${input.host}${path}?${canonicalQuery}&X-Amz-Signature=${signature}`;
};
