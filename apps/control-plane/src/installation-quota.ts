// The `InstallationQuota` Durable Object class: the applier rate limit of one GitHub App installation, shared by every
// isolate (specs/github-output.md § Installation quota, specs/architecture.md FD-ARCH-003). Bound as
// `INSTALLATION_QUOTA`, one object per limit key by `idFromName(<installation id>)`. The ledger and its decisions are
// the GitHub package's; the object keeps the ledger in its storage and decides one call at a time.
import {
  emptyQuotaLedger,
  quotaObjectOver,
  quotaOptionsDefault,
  type QuotaLedger,
  type QuotaObject,
  type QuotaObservation,
} from "@fractalboxdev/flare-dispatch-github";
import type { PermitRequest } from "@fractalboxdev/mameko-ports";
import { DurableObject } from "cloudflare:workers";

const LEDGER_KEY = "ledger";

export class InstallationQuota extends DurableObject implements QuotaObject {
  private ledger: QuotaLedger = emptyQuotaLedger;

  /** Each change is in memory before its write starts, so the next call decides on it. */
  private readonly object: QuotaObject = quotaObjectOver(quotaOptionsDefault, {
    read: () => this.ledger,
    write: async (next) => {
      this.ledger = next;
      await this.ctx.storage.put(LEDGER_KEY, next);
    },
  });

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    void ctx.blockConcurrencyWhile(async () => {
      this.ledger = (await ctx.storage.get<QuotaLedger>(LEDGER_KEY)) ?? emptyQuotaLedger;
    });
  }

  observe(limitKey: string, observation: QuotaObservation): Promise<void> {
    return this.object.observe(limitKey, observation);
  }

  acquire(request: PermitRequest, now: number) {
    return this.object.acquire(request, now);
  }

  release(permitId: string): Promise<void> {
    return this.object.release(permitId);
  }

  remainingShare(limitKey: string, now: number): Promise<number> {
    return this.object.remainingShare(limitKey, now);
  }
}
