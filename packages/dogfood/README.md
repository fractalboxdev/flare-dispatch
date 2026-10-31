# `pnpm dogfood`

`pnpm dogfood [<git ref>]` runs FlareDispatch's own CI on this machine as a real execution through mameko's control plane and device executor. The ref defaults to `HEAD`, and any commit in this repository works, pushed or not.

## Isolation

MAMEKO-ISO-001 forbids job code on the device OS, and no conformant macOS runtime exists yet. The dogfood run therefore executes on the host, under your own user, and the command says so when it starts. It is reachable only under the `development` deployment:

- the Worker's committed `DEPLOYMENT` is `production`, whose dispatch route answers `403 forbidden` for a host execution, and only this command overrides it locally;
- the runner entry takes `development` only from `FD_DEPLOYMENT=development`; any other value empties its catalogue, so a lease answers `RunNotInCatalog`;
- the `production` profile refuses the key helper's software key at registration with `registration_refused`.

## What runs

| Stage         | Process or route                                                                                                                                                                                                                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Control plane | `apps/control-plane` under `wrangler dev`: local D1 and Durable Objects in a fresh state directory. It deploys nothing and needs no Cloudflare or GitHub credential; the command removes such variables from every child's environment.                                                           |
| Enrollment    | `mameko-key-helper --allow-software-key`, `mameko-cli identity`, then `POST /v1/executors/register`, which calls mameko's `registerDevice` under the `development` profile.                                                                                                                       |
| Device        | `mameko-device-executor` with `--free '{"batch":1}'`, the runner entry and the device extension from `packages/catalog`.                                                                                                                                                                          |
| Submit        | `POST /v1/dispatch/check`, class `batch`. The inputs carry the commit and the commands. A `batch` execution waits as a D1 row; the executor channel starts its `Execution` workflow at the winning claim (MAMEKO-ARCH-037).                                                                       |
| Run           | The device takes the lease and its runner child runs `check`: a shallow fetch of the commit from this repository into a clean directory under the OS temporary directory, then `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck` and `pnpm test`, stopping at the first that fails. |
| Verdict       | The result returns over `exec.result` and the `Execution` workflow writes the `executions` row, which is what the command prints.                                                                                                                                                                 |

Each step runs in its own process group with a timeout, with only `PATH`, `HOME`, `USER`, `LANG`, `LC_ALL`, `TMPDIR` and `PNPM_HOME` from the environment, plus `CI` and the `FD_*` fields.

The first run builds the device programs into `.tmp/target`. Each run keeps its logs and control-plane state under `.tmp/dogfood/<timestamp>`: `control-plane.log`, `key-helper.log`, and `device.log`, which holds the output of every step.

## Result

```text
verdict: failure (finding: lint: exit 1)
record: execution 01K..., run check, class batch, executor dogfood-mac, epoch 2, accepted epoch 2
github: output skipped, the control plane has no credentials; 1 outcome intent stays in the outbox
```

| Exit code | Meaning                                                                                                                      |
| --------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 0         | The verdict is `success`                                                                                                     |
| 1         | The verdict is `failure`; the reason names the failing step                                                                  |
| 3         | The verdict is `cancelled`                                                                                                   |
| 4         | The verdict is `skipped`                                                                                                     |
| 5         | No verdict: a process failed to start, no device took the lease within 120 s, or the execution ended `deferred` or `expired` |

The command stops every process it started on each of these paths, and on Ctrl-C, which exits 130. A failure of the checkout is `infra: checkout: ...`, an infrastructure failure rather than a finding about the commit.

GitHub output is skipped: the control plane holds no credentials, so nothing drains the outcome intent the `Execution` workflow writes to the outbox.
