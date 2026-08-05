# Architecture decision records

Decisions that settle a direction the rest of the repo then assumes. One file per
decision, numbered, never edited after acceptance — a superseding decision gets a new
record that names the one it replaces. Format: Status / Context / Decision / Rationale /
Consequences / Revisit triggers.

A record is only binding once its Status reads `accepted`. Treat `proposed` rows as
under discussion — in particular, do not implement against a proposed record's
interfaces or assume they exist.

| ADR | Status | Decision |
| --- | --- | --- |
| [0001](./0001-cloudflare-workflows-scope.md) | proposed | How runs use Cloudflare Workflows: one instance per dispatch, hibernation reserved for bounded human decisions, entity lifecycles keep state in the system of record |
| [0002](./0002-memory-capability.md) | proposed | Org context is an optional, total `memory` capability with MCP-speaking adapters; runs consume, never produce |
| [0003](./0003-no-context-relay.md) | proposed | Context backends ingest GitHub directly; FlareDispatch builds no relay, export, or pull endpoint for them |
