# Isolation and egress

FlareDispatch uses mameko's isolation and egress mechanism on every executor kind mameko defines. This file specifies the egress rules for FlareDispatch's own launcher kind `gha`, whose job sandbox is a GitHub-hosted runner VM: the runner job's egress firewall and the bar on grants that attach a deployment secret.

## Scope

mameko's [isolation-egress.md](https://github.com/fractalboxdev/mameko/blob/d12b8175d0a7f6020e5dc4ef1bc086c700fbe346/specs/isolation-egress.md) specifies the job sandbox per job on a device, the executor user, network isolation on a device, egress on the `cloudflare`, `device` and `aws` kinds, egress profiles, grants and the egress decision, the approval floor and per-lease credentials. Two of its rules carry what FlareDispatch requires of every kind: each outbound HTTPS request outside the current egress profile is denied ([MAMEKO-ISO-016](https://github.com/fractalboxdev/mameko/blob/d12b8175d0a7f6020e5dc4ef1bc086c700fbe346/specs/isolation-egress.md)), and each outbound connection that is not an HTTPS request through the egress proxy is dropped ([MAMEKO-ISO-017](https://github.com/fractalboxdev/mameko/blob/d12b8175d0a7f6020e5dc4ef1bc086c700fbe346/specs/isolation-egress.md)). A device starts run programs only from the run-catalogue bundle its device configuration pins ([MAMEKO-EXEC-143](https://github.com/fractalboxdev/mameko/blob/d12b8175d0a7f6020e5dc4ef1bc086c700fbe346/specs/executors.md)) and refuses a lease whose run definition is not in it with `RunNotInCatalog` ([MAMEKO-EXEC-147](https://github.com/fractalboxdev/mameko/blob/d12b8175d0a7f6020e5dc4ef1bc086c700fbe346/specs/executors.md)).

FlareDispatch's approval floor, base egress profiles and signing purposes are profile values ([profile.md](profile.md) § Approval floor, egress profiles and signing purposes).

This file depends on:

- [executors.md](executors.md) § GitHub Actions launcher for the runner job and its launch;
- [profile.md](profile.md) for the egress profiles and the launcher kind `gha`.

The decision behind the mechanism is mameko's [ADR-0011](https://github.com/fractalboxdev/mameko/blob/d12b8175d0a7f6020e5dc4ef1bc086c700fbe346/specs/adr/0011-device-isolation.md).

## Model

### Egress on `gha`

A `gha` job runs on a GitHub-hosted runner VM, which the deploying organization does not operate, and the runner shares that VM with the repository's commands. The runner job applies an egress firewall for the execution's current egress profile before the run program starts, and checks it with a probe to a host outside that profile. An execution whose egress profiles hold a grant that attaches a deployment secret is never placed on `gha`. A deployment secret is a secret the deployment holds beyond any one lease, such as the operator's Cloudflare API token, which `cf-api` attaches. No base grant attaches one: `package-registries` and `git-remote` attach nothing, and `model-gateway` attaches the execution's per-lease token. That token is a credential but not a deployment secret: the control plane mints it for one lease, scoped to the lease's tenant scope ([MAMEKO-ISO-052](https://github.com/fractalboxdev/mameko/blob/d12b8175d0a7f6020e5dc4ef1bc086c700fbe346/specs/isolation-egress.md)), accepts it only in the execution's current epoch ([MAMEKO-ISO-054](https://github.com/fractalboxdev/mameko/blob/d12b8175d0a7f6020e5dc4ef1bc086c700fbe346/specs/isolation-egress.md)) and revokes it within 30 s of the lease's end ([MAMEKO-ISO-053](https://github.com/fractalboxdev/mameko/blob/d12b8175d0a7f6020e5dc4ef1bc086c700fbe346/specs/isolation-egress.md)). A copy read on the shared runner VM therefore stops working with the lease, while a deployment secret read there keeps working until the operator rotates it. A run that holds only base grants, an agentic run included, keeps whatever `gha` eligibility the profile's other constraints leave it; a run that declares `cf-api` keeps none. Intake labels such an execution `deployment-secret-grant`, and the profile's constraint of that name removes `gha` ([profile.md](profile.md) § Placement).

**The runner job closes egress before the run program starts, or does not start it**

```mermaid
flowchart TD
  accTitle: Egress set-up of a GitHub Actions runner job
  start[Runner job holds its lease] --> fw["Apply firewall: drop every host outside the current egress profile"]
  fw --> probe{Probe to a host outside the profile succeeds?}
  probe -->|no| run[Start the run program]
  probe -->|yes| stop[Fail without starting the run program]
  class start accent
  class probe warn
  class run ok
  class stop danger
```

*`gha` egress · the firewall must hold before any run code executes.*

## Requirements

### `gha` egress

- **FD-ISO-021** · phase 4 · `V-CONF` — Before the run program starts, the GitHub Actions runner job must apply an egress firewall that drops every host outside the execution's current egress profile, and must fail without starting the run program when a probe to a host outside that profile succeeds.
- **FD-ISO-022** · phase 4 · `V-UNIT` — The control plane must not place on a `gha` executor an execution whose egress profiles contain a grant that attaches a deployment secret: a secret the deployment holds beyond any one lease, which excludes a per-lease credential.

## Open items

None.
