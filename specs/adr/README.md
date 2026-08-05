# Architecture decision records

Decisions that settle a direction the rest of the repo then assumes. One file per
decision, numbered, never edited after acceptance — a superseding decision gets a new
record that names the one it replaces. Format: Status / Context / Decision / Rationale /
Consequences / Revisit triggers.

| ADR | Decision |
| --- | --- |
| [0001](./0001-cloudflare-workflows-scope.md) | How runs use Cloudflare Workflows: one instance per dispatch, hibernation reserved for bounded human decisions, entity lifecycles keep state in the system of record |
