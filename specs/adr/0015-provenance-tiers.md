# ADR-0015: Provenance tiers; releases pinned to the cloud

Status: Accepted · 2026-10-24

## Context

FlareDispatch runs pull-request and gate work on owned devices first and places it on cloud executors after the claim deadline. A verdict or an artifact from a device is only as trustworthy as the device, and three facts bound that trust:

- An owned device is often a daily workstation. SLSA Build L2 and above require dedicated build infrastructure, so results from a workstation cap at Build L1.
- Root on a running device can ask its Secure Enclave to sign anything. Managed Device Attestation shows boot and SIP state at enrollment and at each re-attestation, days apart; it does not show the absence of malware.
- The control plane's signing keys are Worker secrets in the deploying organization's Cloudflare account, rotated by redeploy. Whoever controls that account can lease and countersign anything. The OIDC JWKS keeps one key at a time, so a rotation leaves no record of which key was valid when.

Three separate claims are in play: which machine built an output, from which inputs by which process, and whether the output is honest. A hardware key answers the first, a statement bound to a control-plane lease answers the second, and only an independent rebuild answers the third.

## Decision

- **Three tiers, one statement format.** Every executor emits an in-toto statement in a DSSE envelope. `device-signed` proves the attested device produced it. `platform` adds a lease the control plane issued, with a fresh nonce and the epoch, and a job that could not reach the signer. `reproduced` adds a second, cold build of the same inputs on a dedicated attested device, with subject digests equal to the cloud build's. A verifier assigns the tier; the verification policy decides which tier each artifact class needs.
- **The statement builder writes the statement, not the job.** FlareDispatch's statement builder, in its device extension, builds the statement from the output digests the device executor takes from the detached output volume after the job sandbox exits; the device executor signs it through the key helper with the device key in the Secure Enclave (mameko [executors.md § Run user and device extensions](https://github.com/fractalboxdev/mameko/blob/88770c64b14818ad32aed9615f1cfaf4bbc1f591/specs/executors.md#run-user-and-device-extensions)).
- **A separate provenance key countersigns.** The control plane countersigns each accepted statement with an ES256 provenance key distinct from the OIDC key and the log key, and signs cloud-built statements with it as the cloud builder.
- **Every statement is logged.** Public repositories log to the public Rekor log; every other repository logs to a private Merkle log in R2 whose checkpoints an external witness cosigns. Time comes from the log.
- **A signed verification policy with key history.** The operator signs each policy version with a policy root key held outside the control plane. The policy keeps every provenance key, log key and device key with its validity window; nothing is removed from it.
- **Releases are cloud-pinned.** `release` work builds only on cloud executors, cold, with one builder and a per-execution OIDC identity. The `reproduced` tier is an opt-in per release rule, and its second build runs on a dedicated attested device; the cloud build is always one of the two.
- **A verification surface, not a relay.** Statements and log entries carry digests, ids and names only, and the control plane serves them by execution id or subject digest, with no search, export or feed.

Requirements: [provenance.md](../provenance.md), FD-PROV-001 to FD-PROV-077.

## Options considered

| Option | What it buys | What it costs |
| --- | --- | --- |
| No provenance; verdicts only | Nothing to build or operate | A verifier cannot tell a device result from a cloud one; a compromised device's output is indistinguishable from an honest one |
| Device signature only | Proves which machine | Nothing binds a statement to a lease, so a stolen key signs ahead of time or replays; misuse leaves no trace |
| **Tiers with countersignature, log and policy (chosen)** | Each claim has its own mechanism; misuse outside a lease shows in the log; a verifier depends on a policy root it pins, not on the live account | A provenance key, a log key, a private log with a witness and a policy root key ceremony to operate; a Tamarin model to maintain |
| Keyless signing through short-lived certificates bound to an OIDC identity | No long-lived device key | Binds an identity, not hardware, so it loses the which-machine claim; for private repositories, identities land in a public log |
| Two-builder releases by default | A forger must compromise the cloud builder and a device | Every release pays for two builds and needs reproducible builds (pinned toolchains, `SOURCE_DATE_EPOCH`, sorted archives); a device outage blocks releases |
| Releases built on owned devices | No cloud build cost for releases | The release's trust rests on a workstation capped at Build L1 and on its host staying clean |

## Criteria

1. Forgery cost per artifact class: what an attacker must compromise to ship a tampered artifact under a valid statement.
2. Verifier independence: whether a verifier's decision survives a compromise of the control-plane account.
3. Release availability: whether a device outage can block a release.
4. Operating cost: keys, logs and witnesses to run, and the cloud build per release.

Criterion 1 ruled out device-only signing. Criterion 3 decided cloud-pinned releases over default two-builder releases: a release stays one cloud build, and a team that needs two builders opts in per rule and accepts the device dependency.

## Consequences

- A verifier checks two keys and an inclusion proof, against a policy whose root it pinned; a retired or revoked key fails on its window, read from log time.
- A compromised device signs only for its own leases while registered, and every such statement is in the log; it never reaches `reproduced`.
- Cost accepted: every release pays for a cloud build, and a `reproduced` release pays for a second one plus reproducible-build work.
- Cost accepted: the private log is trustworthy only with an external witness, which the operator must choose and keep running.
- Cost accepted: root on a running device still signs until detected; the tiers bound what it gains, they do not remove it.
- Cost accepted: the policy root key lives outside the control plane, so every key rotation and device revocation needs an operator signing step.
- Without a TLS interception CA in the job sandbox, HTTPS dependencies carry lockfile digests, not digests of fetched bytes.
- A protocol change touches the statement format, the acceptance checks and `formal/provenance.spthy` together ([ADR-0018](0018-formal-models.md)).

## Revisit triggers

- A customer requires independent builders for releases: make `reproduce: true` the release default.
- A dedicated device meets the SLSA Build L3 requirements: allow its tier a higher claimed level in the policy.
- Managed Device Attestation becomes available per step rather than days apart.
- The control plane runs as the portable Postgres container: the provenance and log keys need a key store outside Worker secrets.
- The public Rekor log changes its entry format or retention terms.
