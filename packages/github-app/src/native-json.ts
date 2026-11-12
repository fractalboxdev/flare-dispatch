import { GithubApiError } from "./errors";
import { ghHeaders, resolveClient } from "./http";

/** Native authenticated metadata shares a strict byte ceiling and a complete-read deadline. */
export const readNativeJson = async (opts: { readonly token: string; readonly apiBase?: string;
  readonly fetchImpl?: typeof fetch }, url: string, maxBytes: number,
  request?: { readonly method:"POST"; readonly body:string; readonly status:201 }): Promise<{ body: unknown; headers: Headers }> => {
  const refused = () => new GithubApiError("native authenticated metadata unavailable or exceeds its read bounds", 0, "");
  const abort = new AbortController();
  const until = Date.now() + 10_000;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { abort.abort(); reject(refused()); }, 10_000);
  });
  try {
    return await Promise.race([deadline, (async () => {
      const client=resolveClient(opts);
      const response = await client.doFetch(url.startsWith("/") ? `${client.apiBase}${url}` : url, {
        method: request?.method ?? "GET", body:request?.body, redirect: "manual",
        headers: ghHeaders(opts.token,{json:request !== undefined}), signal: abort.signal,
      });
      if (abort.signal.aborted || response.status !== (request?.status ?? 200) || response.body === null) {
        void response.body?.cancel().catch(() => {}); throw refused();
      }
      reader = response.body.getReader();
      const bytes = new Uint8Array(maxBytes); let size = 0;
      for (;;) {
        if (Date.now() >= until) throw refused();
        const { done, value } = await reader.read();
        if (Date.now() >= until) throw refused();
        if (done) break;
        if (!(value instanceof Uint8Array) || value.byteLength === 0
          || size + value.byteLength > maxBytes) throw refused();
        bytes.set(value, size); size += value.byteLength;
      }
      const body: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes.subarray(0, size)));
      if (Date.now() >= until) throw refused();
      return { body, headers: response.headers };
    })()]);
  } catch { throw refused(); }
  finally {
    clearTimeout(timer); abort.abort();
    if (reader !== undefined) { void reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
};
