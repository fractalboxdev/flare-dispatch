// AWS Signature Version 4 for a POST request, on Web Crypto so it runs in the Worker. The control
// plane is the only component that signs, so the AWS credentials never leave it (FD-MDL-024).

export interface AwsCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** Present for credentials from an assumed role. */
  readonly sessionToken?: string;
}

export interface SignInput {
  readonly credentials: AwsCredentials;
  readonly region: string;
  readonly service: string;
  readonly host: string;
  /** The canonical URI: each path segment URI-encoded once more than on the wire. */
  readonly canonicalPath: string;
  readonly body: string;
  readonly now: Date;
  /** Additional headers sent with the request, including every `x-amz-*` header. */
  readonly headers?: Readonly<Record<string, string>>;
}

const encoder = new TextEncoder();

const hex = (buffer: ArrayBuffer): string =>
  [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");

export const sha256Hex = async (data: string): Promise<string> =>
  hex(await crypto.subtle.digest("SHA-256", encoder.encode(data)));

const hmac = async (key: ArrayBuffer | Uint8Array, message: string): Promise<ArrayBuffer> => {
  const k = await crypto.subtle.importKey(
    "raw",
    key as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", k, encoder.encode(message));
};

/** The signed headers of a `POST`: the supplied headers, `host`, the payload hash, the date and the token. */
export const signRequest = async (input: SignInput): Promise<Record<string, string>> => {
  const amzDate = input.now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;
  const payloadHash = await sha256Hex(input.body);
  const token = input.credentials.sessionToken;
  const headers = Object.entries({
    ...Object.fromEntries(
      Object.entries(input.headers ?? {}).map(([key, value]) => [
        key.toLowerCase(),
        value.trim().replace(/\s+/g, " "),
      ]),
    ),
    host: input.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    ...(token === undefined ? {} : { "x-amz-security-token": token }),
  }).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const signedHeaders = headers.map(([k]) => k).join(";");
  const canonicalRequest = [
    "POST",
    input.canonicalPath,
    "",
    ...headers.map(([k, v]) => `${k}:${v}`),
    "",
    signedHeaders,
    payloadHash,
  ].join("\n");
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256Hex(canonicalRequest)].join(
    "\n",
  );
  const kDate = await hmac(encoder.encode(`AWS4${input.credentials.secretAccessKey}`), dateStamp);
  const kRegion = await hmac(kDate, input.region);
  const kService = await hmac(kRegion, input.service);
  const kSigning = await hmac(kService, "aws4_request");
  const signature = hex(await hmac(kSigning, stringToSign));
  return {
    ...Object.fromEntries(headers),
    authorization: `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
};
