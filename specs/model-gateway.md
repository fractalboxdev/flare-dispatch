# Model gateway

FlareDispatch routes every model call through mameko's model gateway. This file specifies the two route kinds FlareDispatch registers in the gateway's provider registry, `workers-ai` and `bedrock`, how a `workers-ai` model entry is priced, and the configuration check that reports a provider's own spend limit.

## Scope

mameko's [model-gateway.md](https://github.com/fractalboxdev/mameko/blob/8530203ba76ba00961e236b1fcea4f34b401bba1/specs/model-gateway.md) specifies the model request, routing by confidentiality mode, model-call tier and data location, the provider registry and its built-in route kinds, allowance enforcement, rate control, the fallback policy, the local model route on a device and the model-call records. FlareDispatch inherits them unchanged. The allowance is money: the gateway rejects a call whose cost the execution's allowance does not cover ([MAMEKO-MDL-026](https://github.com/fractalboxdev/mameko/blob/8530203ba76ba00961e236b1fcea4f34b401bba1/specs/model-gateway.md)), and FlareDispatch sets no separate input-token allowance. A `bulk` call on a device that advertises a local route goes to the local model first ([MAMEKO-MDL-012](https://github.com/fractalboxdev/mameko/blob/8530203ba76ba00961e236b1fcea4f34b401bba1/specs/model-gateway.md)).

This file depends on:

- [profile.md](profile.md) for the classes and the rate card, including the fallback price of a hosted model entry without one;
- [runs/agentic.md](runs/agentic.md) for the recipes that call models;
- [interfaces.md](interfaces.md) for `fd doctor`.

The decision behind the routing is mameko's [ADR-0014](https://github.com/fractalboxdev/mameko/blob/8530203ba76ba00961e236b1fcea4f34b401bba1/specs/adr/0014-model-routing.md).

## Model

### Registered route kinds

mameko lets an application register a route kind through the provider registry's extension point. A registered route receives a request after per-lease credential verification, routing, allowance reservation and rate control, and holds its credential only in the control plane. FlareDispatch registers two:

| Route kind | Reached from | Credential | Price |
| --- | --- | --- | --- |
| `workers-ai` | The control plane, through the Workers AI binding, a runtime-specific feature of `host-cloudflare` | The binding | A per-token rate derived from the model's Neurons price |
| `bedrock` | The control plane, SigV4-signed by the gateway | The role the control plane assumes | The model entry's price, or the fallback rate |

FlareDispatch composes only `host-cloudflare`, so the `workers-ai` route always has its binding.

## Requirements

### Provider registry

- **FD-MDL-020** · phase 0 · `V-DEPLOY` — FlareDispatch must register the route kinds `workers-ai` and `bedrock` and no other, so that configuration validation under [MAMEKO-MDL-021](https://github.com/fractalboxdev/mameko/blob/8530203ba76ba00961e236b1fcea4f34b401bba1/specs/model-gateway.md) accepts a model entry of route kind `workers-ai`, `bedrock`, `openai-compatible`, `anthropic-messages`, `cloudflare-ai-gateway` or `local`.
- **FD-MDL-021** · phase 0 · `V-UNIT` — The model gateway must not price a `workers-ai` model entry at the fallback rate of [MAMEKO-MDL-022](https://github.com/fractalboxdev/mameko/blob/8530203ba76ba00961e236b1fcea4f34b401bba1/specs/model-gateway.md).
- **FD-MDL-022** · phase 0 · `V-DEPLOY` — If a `workers-ai` model entry states no per-token rate derived from its Neurons price, then the deploy check must fail.
- **FD-MDL-024** · phase 0 · `V-UNIT` — The `bedrock` route must sign its requests in the control plane, and the control plane must be the only component that reaches `bedrock`.

### Configuration check

- **FD-MDL-067** · phase 0 · `V-DEPLOY` — Where a hosted provider offers an account spend limit, `fd doctor` may report whether it is set, as the application's configuration check of [MAMEKO-MDL-075](https://github.com/fractalboxdev/mameko/blob/8530203ba76ba00961e236b1fcea4f34b401bba1/specs/model-gateway.md); the gateway's allowance enforcement does not depend on it.

## Open items

- TODO(operator): set each class's share of the per-(provider, class) buckets of [MAMEKO-MDL-044](https://github.com/fractalboxdev/mameko/blob/8530203ba76ba00961e236b1fcea4f34b401bba1/specs/model-gateway.md) in the operator overlay: a reserved share for `interactive`, a share for `required` once a `required` run makes hosted calls, and the remainder for `batch`.
