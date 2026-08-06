# Contract versioning policy

`packages/substrate-contract` is the frozen surface consumers pin: plain structural types that
survive Workers RPC structured-clone, with no dependencies and no imports. Consumers pin it and
deploy on their own schedules from their own repositories, so a breaking change to it is a migration
someone has to run — not a refresh they pick up for free. This policy says what counts as breaking,
how a breaking change ships without stranding anyone, and what the migration actually costs.

## Two numbers, two jobs

`CONTRACT_VERSION` (an integer in `packages/substrate-contract/src/index.ts`, `1` today) is the
**wire-compatibility generation**. It answers one question: can a consumer built against contract
generation *N* talk correctly to a substrate deployment serving generation *M*?

The package's semver (`0.1.0`) is the **release identity** a consumer pins. Every release bumps it;
only a breaking change bumps `CONTRACT_VERSION` alongside it.

The generation is observable in production: `/health` on a deployed substrate returns
`contractVersion`, so an operator or a consumer maintainer can check which generation a deployment
serves without reading its source.

## What bumps `CONTRACT_VERSION`

The rule: **a change bumps the generation when a consumer that compiled against the previous one can
no longer be correct against the new one** — either because it will not compile, or, worse, because
it will compile and be wrong.

| Change | Bump? | Why |
| --- | --- | --- |
| Add an optional field to an input type (`SubstrateRecipe`, `ExecInput`) | No | Old call sites still compile; the substrate defaults it |
| Add a member to an **input** union (`GrantProfileName`) | No | Consumers produce these — a wider target accepts every value they already send |
| Add a member to an **output** union (`SubstrateRefusal`, `PoolName`) | **Yes** | Consumers match these exhaustively to render them; a new member reaches a branch that does not exist |
| Add a field to an output type (`ExecReceipt`, `PoolStatus`) | No | Consumers read the fields they know about |
| Add a required field to an input type | **Yes** | Old call sites stop compiling |
| Remove or rename anything exported | **Yes** | — |
| Narrow a type (`string` → a union, optional → required) | **Yes** | Values a consumer legitimately sent are now rejected |
| Change what a value *means* without changing its shape | **Yes** | Compiles and is silently wrong — the case the integer exists for |
| Add a method to `SubstrateFacade` | No | See below |
| Give `CheckpointReason` another documented value | No | Deliberately open (`string & {}`) so it can grow |

**Adding a facade method** is the one judgment call worth stating outright. It breaks consumers' test
doubles — a fake implementing `SubstrateFacade` stops compiling — but it is a build-time break with no
runtime component: a consumer that never calls the new method talks to the new deployment perfectly.
So it does not bump the generation, and the release note calls it out by name. The same reasoning
splits the two output-union rows above from the input-union one: **widen freely what you accept,
never what you emit.** The substrate emits refusals and consumers must render every kind, because a
default branch that logs "something failed" throws away the field that made the refusal actionable —
which is the exact failure `SubstrateRefusal` exists to prevent.

## How a breaking change ships: expand, migrate, contract

Deploy order makes the naive swap impossible. The substrate deploys before its consumers
([runbook](byoc-upgrade.md)), and consumers deploy from their own repositories on their own
schedules, so there is always a window in which a new substrate is serving old consumers. A breaking
change is three releases, not one:

1. **Expand.** The substrate ships the new shape *alongside* the old one — a new optional field, a new
   method, a new refusal kind emitted only on paths a consumer opted into. `CONTRACT_VERSION` bumps
   here, because the contract changed, and the deployment serves both generations at once.
2. **Migrate.** Each consumer bumps its pin, fixes what the compiler flags, and deploys, in whatever
   order suits it. `/health`'s `contractVersion` says what the deployment offers; the consumers'
   own version reporting says who has taken it.
3. **Contract.** Once every consumer of that deployment has moved, the old shape is removed in a later
   release. Removal is the step that actually breaks an unmigrated consumer, and it happens on the
   operator's evidence that nobody is left — never on a timer.

A change that cannot expand — a genuinely required new input field — inverts the order: consumers
start sending it while it is optional, and the substrate makes it required only after they all do.

For a single-org deployment where one team owns every consumer, steps 2 and 3 can land the same week.
The sequence still holds, because the alternative is a deploy window in which the substrate is up and
a consumer is broken, and that window is exactly when the substrate is least able to tell anyone why.

## What a consumer migration looks like

1. **Read the release note's migration section.** A generation bump must carry one, naming each
   changed shape and its mechanical fix.
2. **Bump the pin on a branch and typecheck. The compile errors are the checklist.** A generation bump
   that produces *no* compile errors is the dangerous case: it means the change was semantic, and the
   release note names those explicitly because nothing else will.
3. **Handle new refusal kinds at every render site**, not just the one the compiler pointed at first.
   Grep for `refusal.kind`; a consumer usually renders refusals in more than one place (a thread reply
   and a check-run summary, say).
4. **Deploy normally.** The substrate is already serving the new generation — expand shipped first —
   so a consumer deploy needs no coordination.
5. **Know your rollback target.** A consumer can only roll back to a pin the deployed substrate still
   serves, which is the whole reason step 3 of expand/migrate/contract waits for evidence.

## Known gap: the contract is not published

`packages/substrate-contract/package.json` is `"private": true` and exports TypeScript source
(`"exports": { ".": "./src/index.ts" }`) with no build step. ADR-0002 describes the contract as
published so out-of-repo consumers can pin it; today an out-of-repo consumer cannot install it from a
registry and must vendor the file or reference the repository.

Until it is published, "pin the package" means "pin the upstream commit", and both numbers above are
read out of the source rather than out of a registry version — which also means a consumer's pin is
invisible to `npm outdated` and to any dependency-update automation. Publishing is what makes the
semver half of this policy do any work at all.
