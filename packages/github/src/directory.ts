// Which GitHub App installation serves a repository. The applier, the actuator
// rate limit and the `installationOf` binding all read it, so it sits apart from
// each of them.
import { Context, type Effect } from "effect";
import type { GithubError } from "./client.ts";

/** Which GitHub App installation serves a tenant scope; null when none does. */
export class InstallationDirectory extends Context.Service<
  InstallationDirectory,
  { readonly installationFor: (scopeId: string) => Effect.Effect<number | null, GithubError> }
>()("@fractalboxdev/flare-dispatch-github/InstallationDirectory") {}
