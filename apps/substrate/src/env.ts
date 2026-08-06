// flare-dispatch substrate — typed binding environment.
//
// One field per binding declared in wrangler.jsonc, plus the Worker secrets.
// The admission D1 is bound to THIS worker only (ADR-0004) — the exclusivity
// is the structural half of "one admission path".
import type {
  SubstrateSandboxAgent,
  SubstrateSandboxBrowser,
  SubstrateSandboxLean,
  SubstrateSandboxTask,
} from "./sandbox-do";

export interface Env {
  /** Admission semaphore + denial events (migrations/0001). Substrate-only. */
  readonly ADMISSION_DB: D1Database;

  /** Backups + per-execution artifact prefixes (`artifacts/<containerId>/`). */
  readonly BACKUP_BUCKET: R2Bucket;

  readonly SANDBOX_LEAN: DurableObjectNamespace<SubstrateSandboxLean>;
  readonly SANDBOX_BROWSER: DurableObjectNamespace<SubstrateSandboxBrowser>;
  readonly SANDBOX_AGENT: DurableObjectNamespace<SubstrateSandboxAgent>;
  readonly SANDBOX_TASK: DurableObjectNamespace<SubstrateSandboxTask>;

  /**
   * Keys admission tickets (ADR-0004). A Worker secret
   * (`wrangler secret put TICKET_SECRET`); never shared with consumers — a
   * ticket is minted and verified entirely inside this worker.
   */
  readonly TICKET_SECRET: string;

  /**
   * Keys the per-execution model-proxy token (ADR-0006/0009). A Worker secret,
   * distinct from `TICKET_SECRET` so the one credential that *does* enter a
   * container cannot be confused with, or forged from, the key that gates
   * admission. Unset ⇒ no token can be minted and the proxy fails closed.
   */
  readonly MODEL_PROXY_SECRET?: string;

  // -------------------------------------------------------------------------
  // Injectable credentials (ADR-0006)
  //
  // Values the EGRESS HANDLER attaches to requests that pass a grant — never
  // passed into a container, never in an exec env. Reachable only through
  // `secrets.ts`, and only for the names on `INJECTABLE_SECRETS`; every other
  // binding above is unreachable from a descriptor by construction.
  // -------------------------------------------------------------------------

  /** `wrangler deploy` → `api.cloudflare.com`, under the `cf-api` profile. */
  readonly CLOUDFLARE_API_TOKEN?: string;

  /** Private-package reads on `registry.npmjs.org`, under `js-install`. */
  readonly NPM_TOKEN?: string;

  /** Idle window before a finished container sleeps. Optional; default "10m". */
  readonly SANDBOX_SLEEP_AFTER?: string;

  /** Optional JSON override of the per-pool caps, e.g. `{"lean":8,"task":4}`. */
  readonly POOL_CAPS?: string;

  /** Account Containers headroom the cap-sum must fit (see pools.ts). */
  readonly CONTAINERS_CEILING?: string;

  /**
   * `version_metadata` binding — identifies the deployed build, which is what a
   * canary verdict is keyed to (verify/store-d1.ts). Optional so an operator
   * overlay that omits it degrades to the semver rather than failing.
   */
  readonly VERSION_METADATA?: WorkerVersionMetadata;

  /**
   * Host the SDK-pin canary tries to reach from inside a container. Must be a
   * host that *would* answer if egress were open. Optional; defaults to
   * `example.com` (verify/probe.ts).
   */
  readonly CANARY_PROBE_HOST?: string;

  /** `owner/name` the dogfood round trip clones. Optional; defaults to a tiny public repo. */
  readonly DOGFOOD_REPO?: string;
}
