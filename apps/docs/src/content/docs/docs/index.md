---
title: Overview
description: FlareDispatch runs the expensive half of GitHub Actions on a Cloudflare stack you deploy into your own account.
---

FlareDispatch is BYOC CI/CD: an organization deploys one Dispatcher Worker and one GitHub App into its own Cloudflare account, and heavy jobs (agentic code review, Playwright e2e, acceptance suites, matrix fan-outs, security scans) run there instead of on GitHub-hosted runners. There is no multi-tenant service.

This section documents v1, the system that deploys today. [v1 and v2](/docs/v2/) states what v2 changes and how much of it exists. The [specifications](/specs/) define v2.

## What runs where

| Concern           | Cloudflare service | What it does                                                 |
| ----------------- | ------------------ | ------------------------------------------------------------ |
| Orchestration     | Workflows          | Each run is a durable Workflow instance with a step timeline |
| Job execution     | Containers         | Jobs run in sandboxed containers under deny-all egress       |
| Browser and e2e   | Browser Rendering  | Playwright e2e and recorded product demos over CDP           |
| Cache + artifacts | R2                 | Dependency cache, logs and artifacts                         |

## Triggers

A run starts from one of three sources:

- **GitHub Actions.** [`flare-dispatch-action`](/docs/actions/flare-dispatch-action/) signs a dispatch body with HMAC and POSTs it to the Dispatcher.
- **GitHub App webhook.** Repository events start runs directly. Tag-driven runs use the App's `push` event, so an App must subscribe to **Pushes**.
- **Cron schedule.** A scheduled run needs no repository event. Its inputs may name a branch, which the tick pins to that branch's head.

Every run reports its verdict as a `flare-dispatch/<run>` check-run on the commit. Branch protection gates on that name. The check-run summary links the run's logs; [Finding your logs](/docs/runs/#finding-your-logs) traces the path from the summary to the raw artifacts.

## Runs are programs

A run is a typed Effect-TS program, not YAML, written against three layers. **Capabilities** wrap Cloudflare primitives, **primitives** compose them into build, test and cache steps, and **recipes** are the named runs a Dispatcher registers. Steps are typed, errors are tagged, and matches are exhaustive. The [run catalog](/docs/runs/) lists every recipe with its inputs.

## Deployment

Deployment is `wrangler deploy` into your own account, from an operator overlay that holds your account's values. The committed configuration holds placeholders. [`deploy-dispatcher-action`](/docs/actions/deploy-dispatcher-action/) runs that deploy from a GitHub Actions workflow in your operator repository, pinned to one upstream commit.

## Start here

- [Offload a job](/docs/actions/flare-dispatch-action/): dispatch a run from a GitHub Actions step and gate on its check-run.
- [Deploy a Dispatcher](/docs/actions/deploy-dispatcher-action/): ship the Worker into your own account from an operator overlay.
- [Run catalog](/docs/runs/): the runs a Dispatcher registers, their inputs, and where their logs live.
- [Substrate](/docs/substrate/): the execution environment for agentic work, consumed through a service-binding facade.
- [Benchmarks](/benchmarks/): a modeled projection of each run's wall time and marginal cost.
