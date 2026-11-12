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
 * under a prefix of its own and an alarm armed by one suite's object never writes into another's.
 */
export class TransparencyLog extends LogObject<Env> {
  private recorder() {
    const sql = this.ctx.storage.sql;
    sql.exec("create table if not exists test_alarms (alarm text not null)");
    sql.exec("create table if not exists test_prefix (prefix text not null)");
    return sql;
  }

  protected config(): TransparencyLogConfig {
    const sql = this.recorder();
    const prefix = sql
      .exec<{ prefix: string }>("select prefix from test_prefix")
      .toArray()[0]?.prefix;
    return {
      bucket: this.env.CACHE,
      prefix: prefix ?? PRIVATE_LOG_PREFIX,
      origin: "ci.example.com/private-log",
      logKey: parseProvenanceKey(this.env.LOG_KEY),
      alarms: Layer.succeed(AlarmPort, {
        deliver: (alarm: Alarm) =>
          Effect.sync(() => {
            sql.exec("insert into test_alarms (alarm) values (?)", JSON.stringify(alarm));
          }),
      }),
    };
  }

  usePrefix(prefix: string): void {
    const sql = this.recorder();
    sql.exec("delete from test_prefix");
    sql.exec("insert into test_prefix (prefix) values (?)", prefix);
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
