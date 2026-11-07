// The `CacheLedger` Durable Object class. Bind it as `CACHE_LEDGER`, one object per repository by
// `idFromName(<owner/name>)`; the ledger logic is ledger.ts, run over the object's storage one call at a time.
import { DurableObject } from "cloudflare:workers";
import { makeCacheLedger, type CacheLedgerApi, type ReserveRequest } from "./ledger.ts";

export class CacheLedger extends DurableObject implements CacheLedgerApi {
  private readonly ledger = makeCacheLedger(this.ctx.storage);

  reserve(request: ReserveRequest) {
    return this.ledger.reserve(request);
  }
  commit(request: { readonly executionId: string; readonly bytes: number }) {
    return this.ledger.commit(request);
  }
  end(request: { readonly executionId: string; readonly expiresAt: number }) {
    return this.ledger.end(request);
  }
  release(request: { readonly bytes: number; readonly nowMs: number }) {
    return this.ledger.release(request);
  }
  measure(request: { readonly bytes: number; readonly nowMs: number }) {
    return this.ledger.measure(request);
  }
  usage() {
    return this.ledger.usage();
  }
}
