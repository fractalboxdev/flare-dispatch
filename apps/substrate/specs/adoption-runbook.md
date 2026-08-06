# BYOC upgrade runbook — moving the dispatcher onto the substrate

The stage-2 exit in [platform.md](platform.md) § Adoption plan, written as the sequence an
operator runs. Two switches drive it and they are deliberately separate:

| Switch | Where | Decides |
| --- | --- | --- |
| `SUBSTRATE_BACKEND` | dispatcher `vars` (root `wrangler.jsonc`) | **where** a run executes — its own container fleet, or the substrate through the facade |
| per-run `rollout` | `apps/dispatcher/src/grant-catalog.ts` | **how much** of the egress floor is enforced once it is there: `legacy` → `report` → `enforce` |

Keeping them apart is what makes each step reversible. Flipping the backend moves execution
without changing what a run may reach; graduating a position changes what a run may reach
without moving it. A bad step is one revert, not two.

## 0. Preconditions

- The substrate worker is deployed and healthy, with `TICKET_SECRET` set and its D1 migrations
  applied. It deploys **first** — the dispatcher's `services` binding resolves at deploy time,
  so a dispatcher deploy against a missing substrate fails loudly rather than at 2am.
- `pnpm test` green. The catalog coverage test (`grant-catalog.test.ts`) fails the build if a
  registered run has no grant entry, so a run added since the last cutover cannot slip through.

## 1. Deploy the dispatcher with the binding, backend off

`SUBSTRATE_BACKEND` ships `"off"`. Every run still executes on the dispatcher's own containers;
the only change is that the `SUBSTRATE` service binding exists and resolves. Confirm the deploy
is healthy on the usual surfaces before touching the switch.

## 2. Flip the backend on

Set `SUBSTRATE_BACKEND: "on"` in the dispatcher's `vars` and deploy. From that moment every
**facade-capable** run executes on the substrate, at whatever rollout position its catalog entry
names — which is `legacy` for all of them, so egress behaviour is unchanged on the day of the
move. What changes is the execution path: admission is the substrate's ticket gate, the container
is the substrate's, and the exec fence wraps every command.

Runs that are **not** facade-capable keep running on the dispatcher's fleet regardless. They are
listed with a `facadeGaps` field in `apps/dispatcher/src/grant-catalog.ts`; today that is
`cdp-acceptance`, `product-demo`, `self-heal-pr` (detached processes and preview URLs),
plus the runs that tar a directory out of the container (`playwright-demo`, `demo-reel`,
`email-otp-login`). The facade has no method for either surface — see § Residuals.

What to watch, in order of how loudly it fails:

- `ContainerBusy` on a check-run summary means the substrate's pool is full, not that a container
  broke. Pool caps are § 5.
- A `substrate rejected the recipe: …` exec failure is a catalog problem — a profile a run selects
  that its recipe cannot satisfy. It fails before a container boots.
- A cached dependency install becomes a cold install: the R2 dep cache packs archives by exec'ing
  in the container over a DO binding, which the facade does not expose, so the cache is a
  pass-through on this path. Installs are slower; nothing fails.

To revert: set the var back to `"off"` and deploy. In-flight executions finish where they started.

## 3. Open a report window

Move a run's `rollout` from `legacy` to `report` and deploy. Its reachability does not change —
every host stays admitted — but every request is now decided against the grant it *would* get
under `enforce`, and each refusal is recorded as a per-execution denial event with a
`would-deny: ` reason.

Read the window from the substrate's `sub_denials` table, keyed by container id:

```sh
wrangler d1 execute flare-dispatch-substrate --remote --command \
  "SELECT host, method, path, reason, count FROM sub_denials \
   WHERE reason LIKE 'would-deny:%' ORDER BY count DESC LIMIT 50"
```

Each row is a grant the run needs and does not have. Two outcomes, and the difference matters:

- The host belongs in a profile the catalog already has → widen that profile in
  `apps/substrate/src/engine/profiles.ts`, with rules on method and path. A host admitted without
  rules is a host nobody inspects.
- The host belongs to nothing reviewed → that is the finding. Decide whether the run should reach
  it at all before authoring anything.

A window is clean when a full cycle of the run's real traffic — a working day for a webhook run, a
week for a Monday cron — produces no new `would-deny` rows.

## 4. Graduate to enforce

Move `rollout` to `enforce` and deploy. From then on the run's container carries deny-all: only the
composed profile hosts are admitted, each method/path-asserted, and anything else never leaves.
Denials are recorded without the `would-deny:` prefix — a row is now a request that did not happen.

Graduate one run at a time. The positions are per run precisely so a bad grant is one run's
problem.

## 5. Drain, delete, and raise the caps

Once **every** run is at `enforce` and no run needs the dispatcher's fleet:

1. **Drain.** Stop dispatching, and let in-flight executions finish. There is nothing to migrate:
   container leases live in D1, backups are cache, and the substrate rebuilds from the recipe — the
   DO state in the moving classes is disposable by design. Watch `executions` for a quiet window
   rather than counting containers.
2. **Delete the classes.** Remove the `containers` block, the three `RUNS_SANDBOX*` bindings, and
   `apps/dispatcher/src/sandbox.ts` from the dispatcher, and add a migration deleting
   `RunSandbox`, `RunSandboxBrowser` and `RunSandboxAgent`. After this, no `containers` stanza
   exists in any wrangler config except `apps/substrate/wrangler.jsonc` — the stage-2 exit test.
3. **Raise the pool caps.** The delete frees 40 container instances (16 + 16 + 8). Set the
   substrate's vars to the post-adoption partition, which
   `apps/substrate/src/admission/pools.ts` carries as `CONTAINERS_CEILING_POST_ADOPTION` and
   `POOL_CAPS_POST_ADOPTION`, and which its test asserts fits that headroom:

   ```jsonc
   "CONTAINERS_CEILING": "56",
   "POOL_CAPS": "{\"lean\":24,\"browser\":10,\"agent\":8,\"task\":12}"
   ```

   Deploy the substrate before raising them is unnecessary — they are vars, and
   `validatePoolCaps` refuses a partition over the ceiling at deploy time rather than degrading
   later. Raise the ceiling in the same change as the caps, never after.

Order matters in one direction only: the caps must not go up before the classes come down, or two
fleets are sized for a ceiling only one of them has left.

## Residuals

Stated rather than deferred, because each one bounds what this runbook can finish today.

- **The facade serves no detached-process or preview-URL surface.** A process that outlives the
  exec fence outlives the grant window the fence closes, which is a design question rather than a
  missing method — until it is answered, the runs in § 2's exclusion list cannot move, and § 5
  cannot run.
- **Container-mode artifact upload** (tar a directory out of the container to R2) has no facade
  equivalent either. The substrate mounts R2 at `/artifacts` inside the container, so the
  replacement is a run writing its own archive there rather than the Worker pulling one out — a
  per-run change, not a mechanical one.
- **A report window sees what the engine sees.** Requests reach the catch-all handler only for
  traffic the container runtime intercepts; a protocol it does not intercept is neither recorded
  nor, later, enforced. Treat a clean window as evidence about the traffic that was observed, not
  a proof about all of it.
- **A target resolved inside a run body is invisible to the recipe.** `playwright-e2e` falls back
  to `playwright-e2e.base-url` in `CONFIG_KV` when a webhook dispatch carries no `baseURL`; that
  value never reaches the grant, so the run stays at `report` until its target is a dispatch input.
