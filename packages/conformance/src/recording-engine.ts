// The control plane Worker with an `ExecutionEngine` that also records, in the object's own SQLite storage, each `start`
// and `grantLease` call it receives in the order it receives them. Every other export is the Worker's own.
import type { ExecutionPayload } from "@fractalboxdev/mameko-coordinator";
import { ExecutionEngine as ComposedEngine } from "../../../apps/control-plane/src/worker.ts";

export * from "../../../apps/control-plane/src/worker.ts";
export { default } from "../../../apps/control-plane/src/worker.ts";

/** One call the object received, in arrival order. */
export interface RecordedCall {
  readonly call: "start" | "grantLease";
  readonly detail: unknown;
}

const CALLS = `create table if not exists recorded_calls (
  seq integer primary key autoincrement, call text not null, detail text not null)`;

export class ExecutionEngine extends ComposedEngine {
  private note(call: RecordedCall["call"], detail: unknown): void {
    this.ctx.storage.sql.exec(CALLS);
    this.ctx.storage.sql.exec(
      "insert into recorded_calls (call, detail) values (?, ?)",
      call,
      JSON.stringify(detail),
    );
  }

  override start(payload: ExecutionPayload): Promise<void> {
    this.note("start", payload);
    return super.start(payload);
  }

  override grantLease(...args: Parameters<ComposedEngine["grantLease"]>): Promise<void> {
    this.note("grantLease", args[1]);
    return super.grantLease(...args);
  }

  /** The calls this object received, and how many workflow executions its DO-SQLite journal holds. */
  recorded(): { readonly calls: readonly RecordedCall[]; readonly journaled: number } {
    const sql = this.ctx.storage.sql;
    sql.exec(CALLS);
    const calls = sql
      .exec<{ call: RecordedCall["call"]; detail: string }>(
        "select call, detail from recorded_calls order by seq",
      )
      .toArray()
      .map((r) => ({ call: r.call, detail: JSON.parse(r.detail) as unknown }));
    const journal =
      sql
        .exec("select 1 from sqlite_master where type = 'table' and name = 'workflow_executions'")
        .toArray().length > 0;
    const journaled = journal
      ? Number(sql.exec<{ n: number }>("select count(*) as n from workflow_executions").one().n)
      : 0;
    return { calls, journaled };
  }
}
