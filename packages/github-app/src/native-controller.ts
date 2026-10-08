import { GithubApiError } from "./errors";
import { ghHeaders, resolveClient } from "./http";

type Options = {
  readonly appId: string; readonly appJwt: string;
  readonly apiBase?: string; readonly fetchImpl?: typeof fetch;
};

/** The authenticated App supplies the trusted actor; workload evidence supplies no controller identity. */
export const readNativeControllerIdentity = async (opts: Options): Promise<{
  readonly appId: number; readonly actorLogin: string;
}> => {
  const refuse = (message: string, status = 0) => new GithubApiError(message, status, "");
  const appId = Number(opts.appId);
  if (!/^[1-9][0-9]*$/.test(opts.appId) || !Number.isSafeInteger(appId) || opts.appJwt.length === 0)
    throw refuse("native controller authentication configuration is invalid");
  const { apiBase, doFetch } = resolveClient(opts);
  let response: Response;
  try {
    response = await doFetch(`${apiBase}/app`, {
      method: "GET", redirect: "error", headers: ghHeaders(opts.appJwt),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw refuse("native controller authenticated identity read unavailable");
  }
  if (response.status !== 200 || response.body === null) {
    await response.body?.cancel().catch(() => undefined);
    throw refuse("native controller authenticated identity response refused", response.status);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 65_536) {
        await reader.cancel();
        throw refuse("native controller authenticated identity exceeds its body bound");
      }
      chunks.push(value);
    }
  } catch {
    throw refuse("native controller authenticated identity body refused");
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let body: unknown;
  try { body = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)); } catch {
    throw refuse("native controller authenticated identity encoding refused");
  }
  if (typeof body !== "object" || body === null || !("id" in body) || !("slug" in body)
    || body.id !== appId || typeof body.slug !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(body.slug))
    throw refuse("native controller authenticated identity does not match configured App");
  return { appId, actorLogin: `${body.slug}[bot]` };
};
