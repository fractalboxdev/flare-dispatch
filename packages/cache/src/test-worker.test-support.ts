// The Worker the Miniflare suites run: the `CacheLedger` Durable Object class, and the compile-cache route mounted
// the way the control plane mounts it, with one ledger object per repository.
import { handleCompileCache } from "./compile-cache.ts";
import { ledgersOf } from "./ledger.ts";

export { CacheLedger } from "./ledger-object.ts";

interface Env {
  readonly CACHE: R2Bucket;
  readonly CACHE_LEDGER: DurableObjectNamespace;
  readonly COMPILE_CACHE_SECRET: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/ledger/")) {
      const [, , repo, op] = url.pathname.split("/");
      const ledger = ledgersOf(env.CACHE_LEDGER)(decodeURIComponent(repo!)) as unknown as Record<
        string,
        (arg: unknown) => Promise<unknown>
      >;
      // An RPC stub's method is called directly: `.call` on it would be a remote method named `call`.
      return Response.json(await ledger[op!]!(await request.json()));
    }
    return (
      (await handleCompileCache(request, {
        bucket: env.CACHE,
        ledgers: ledgersOf(env.CACHE_LEDGER),
        secret: env.COMPILE_CACHE_SECRET,
        now: Date.now,
        waitUntil: (p) => ctx.waitUntil(p),
      })) ?? new Response("not found", { status: 404 })
    );
  },
};
