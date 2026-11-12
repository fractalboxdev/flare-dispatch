// The Worker the Miniflare suites run: the `CacheLedger` Durable Object class, a `TransparencyLog` that records the
// alarms it raises, and the compile-cache route mounted the way the control plane mounts it, with one ledger object
// per repository.
import { AlarmPort, type Alarm } from "@fractalboxdev/mameko-ports";
import { Effect, Layer } from "effect";
import { handleCompileCache } from "./compile-cache.ts";
import { ledgersOf } from "./ledger.ts";
import { parseProvenanceKey } from "./provenance/dsse.ts";
import {
  PRIVATE_LOG_PREFIX,
  TransparencyLog as LogObject,
  type TransparencyLogConfig,
} from "./provenance/log-object.ts";

export { CacheLedger } from "./ledger-object.ts";

interface Env {
  readonly CACHE: R2Bucket;
  readonly CACHE_LEDGER: DurableObjectNamespace;
  readonly COMPILE_CACHE_SECRET: string;
  readonly LOG_KEY?: string;
}

/**
 * The `TransparencyLog` with its alarms recorded in its own storage, and its R2 prefix settable, so each suite writes
 * under a prefix of its own and an alarm armed by one suite's object never writes into another's. `failLeafWrites(n)`
 * makes the next `n` leaf puts write their object and then reject, as a put whose answer is lost does.
 */
export class TransparencyLog extends LogObject<Env> {
  private recorder() {
    const sql = this.ctx.storage.sql;
    sql.exec("create table if not exists test_alarms (alarm text not null)");
    sql.exec("create table if not exists test_prefix (prefix text not null)");
    sql.exec("create table if not exists test_failing_writes (n integer not null)");
    return sql;
  }

  /** The `CACHE` bucket, whose leaf puts reject after writing while `test_failing_writes` counts any down. */
  private bucket(sql: SqlStorage): R2Bucket {
    const cache = this.env.CACHE;
    const failNext = () => {
      const n = sql.exec<{ n: number }>("select n from test_failing_writes").toArray()[0]?.n ?? 0;
      if (n > 0) sql.exec("update test_failing_writes set n = ?", n - 1);
      return n > 0;
    };
    const put: R2Bucket["put"] = async (key, value, options) => {
      const written = await cache.put(key, value, options);
      if (key.includes("/leaf/") && failNext()) throw new Error("the put's answer was lost");
      return written;
    };
    return new Proxy(cache, {
      get: (target, prop) =>
        prop === "put"
          ? put
          : (Reflect.get(target, prop) as (...a: unknown[]) => unknown).bind(target),
    });
  }

  protected config(): TransparencyLogConfig {
    const sql = this.recorder();
    const prefix = sql
      .exec<{ prefix: string }>("select prefix from test_prefix")
      .toArray()[0]?.prefix;
    return {
      bucket: this.bucket(sql),
      prefix: prefix ?? PRIVATE_LOG_PREFIX,
      origin: "ci.example.com/private-log",
      logKey: parseProvenanceKey(this.env.LOG_KEY),
      alarms: Layer.succeed(AlarmPort, {
        deliver: (alarm: Alarm) =>
          Effect.sync(() => {
            sql.exec("insert into test_alarms (alarm) values (?)", JSON.stringify(alarm));
          }),
      }),
      witnesses: Effect.succeed([]),
      fetch: (url, init) => fetch(url, init),
    };
  }

  usePrefix(prefix: string): void {
    const sql = this.recorder();
    sql.exec("delete from test_prefix");
    sql.exec("insert into test_prefix (prefix) values (?)", prefix);
  }

  failLeafWrites(n: number): void {
    const sql = this.recorder();
    sql.exec("delete from test_failing_writes");
    sql.exec("insert into test_failing_writes (n) values (?)", n);
  }

  delivered(): readonly Alarm[] {
    return this.recorder()
      .exec<{ alarm: string }>("select alarm from test_alarms")
      .toArray()
      .map((row) => JSON.parse(row.alarm) as Alarm);
  }
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
