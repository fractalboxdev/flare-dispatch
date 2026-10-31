# ADR-0009: Owned-device isolation: a VM per job, a dedicated user, egress profiles

Status: Superseded by mameko [ADR-0011](https://github.com/fractalboxdev/mameko/blob/da1249e8318d7ac67eae38c4d1419613590ad18e/specs/adr/0011-device-isolation.md) and [ADR-0019](https://github.com/fractalboxdev/mameko/blob/da1249e8318d7ac67eae38c4d1419613590ad18e/specs/adr/0019-device-platforms-and-job-runtimes.md) · 2026-10-24

## Context

An owned device is the most privileged machine in the fleet. A colocated workstation holds the operator's SSH keys, password-manager sessions, a logged-in `gh` and AI CLI sessions, and it sits on a local network and a tailnet. CI runs pull-request code and its dependencies, and agentic runs feed untrusted text to a model that issues commands. Published supply-chain attacks have turned developer machines and their AI CLIs into exfiltration tools.

The constraints:

- Placement already keeps fork-PR code, tags and P0 off owned devices (mameko's [placement-leases.md](https://github.com/fractalboxdev/mameko/blob/da1249e8318d7ac67eae38c4d1419613590ad18e/specs/placement-leases.md)), so a device runs code from people with write access, plus its dependencies.
- Devices are Apple silicon Macs. Apple's `container` runs each Linux container as its own lightweight VM on macOS 26. The Virtualization framework allows at most 2 macOS guests per host.
- Warm state is the reason to run on a device, so the workspace must be fast to create: virtiofs shares are slow for `node_modules`-sized trees.
- The same egress grants must hold on every executor kind, so a run behaves the same wherever it is placed.

## Decision

Every job on a device runs in its own VM: a Linux VM started by Apple `container`, or a macOS VM for `macos-arm64` jobs. The VM sees only an APFS copy-on-write workspace clone attached as a block device and the cache directories its lease names. The agent runs as a dedicated macOS user under `launchd`, listens on no network socket, and holds no long-lived bearer secret on disk. A packet-filter rule drops every packet from a job VM to private, link-local, loopback, tailnet and host addresses and to the internet directly; the per-VM egress proxy, reached over a host Unix socket forwarded into the VM, is the only path out. The proxy enforces the run's `setup` profile, then its `agent` profile, from the same grant catalog and decision package the Cloudflare outbound proxy uses. Credentials are minted per execution lease and attached by the proxy, never placed in the VM. [isolation-egress.md](../isolation-egress.md) specifies the requirements.

## Options considered

| Option | What it buys | What it costs |
| --- | --- | --- |
| Job processes on the host under a separate user | No VM boot; native speed; simplest launcher | One kernel and one filesystem with the operator's account. A local privilege escalation reaches every key on the machine. No network namespace, so blocking the LAN per job needs per-user firewall rules that macOS does not offer |
| One shared Linux VM for all jobs (Docker Desktop, colima, OrbStack) | One boot; mature container tooling | Jobs share a kernel and a Docker daemon, so one job escaping its container reaches every other job's workspace and credentials. Licensing terms for Docker Desktop in organizations |
| **A VM per job through Apple `container`** | A hypervisor boundary per job; no shared daemon; an exact list of what each VM sees | Requires macOS 26 on Apple silicon. Each job pays a VM start. A hypervisor bug reaches the agent user |
| A macOS VM per job through Tart or the Virtualization framework directly, for Linux jobs too | One VM technology for both platforms | macOS guests cap at 2 per host, so Linux concurrency would cap at 2; macOS images are tens of GiB |
| No egress control on devices, relying on code review | Nothing to build | A compromised dependency exfiltrates source and tokens; the device would be the one executor without the deny-all floor |
| DNS-based allowlist instead of a proxy | Simple to configure | Does not stop connections to literal IPs, cannot enforce method, path or body size, and cannot attach credentials |

## Criteria

1. No job reads a key, socket or file of the operator's account or of the agent user.
2. No job reaches the LAN, the tailnet or the host's own services.
3. Egress behaves the same on a device as in a Cloudflare Container, so placement does not change what a run may reach.
4. Workspace creation stays fast enough that warm state remains a net gain.

Criteria 1 and 2 decided it: the per-job VM is the only option that gives every job its own kernel, its own network interface for the packet-filter rule, and an explicit attachment list.

## Consequences

- Devices must be Apple silicon on macOS 26 or later; an older Mac or an Intel Mac cannot serve execution leases.
- Every job pays a VM start, unmeasured on the target device until phase 1.
- Exposed ports stay off execution leases on devices, so preview runs stay on Cloudflare for guaranteed work.
- A hypervisor or Secure Enclave zero-day remains an accepted risk: on a workstation, the agent user and the VM boundary are the only separation from the operator's account. Releases stay cloud-built for this reason.
- The isolation probe and the packet-filter rule become part of device health: a macOS update that changes the network stack drains the device until the probe passes again.
- The egress decision lives in one shared package, so the Cloudflare outbound proxy and the device proxy change together.

## Revisit triggers

- Apple `container` changes its VM model, drops a network capability the packet-filter rule depends on, or reaches end of support.
- Measured VM start p95 exceeds 10 s on the target device.
- A published VM escape for the Virtualization framework affects the macOS version the fleet runs.
- Devices other than Macs (Linux workstations) join the fleet and need a per-job VM technology of their own.
