// An in-memory account's Access applications, for the `DeployTarget` fakes: the one Access read, over one map.
import { Effect } from "effect";
import type { DeployedAccessApplication } from "./access-application.ts";

export const accessStore = (initial: readonly DeployedAccessApplication[] = []) => {
  const apps = new Map(initial.map((a) => [a.id, a]));
  return {
    apps,
    accessApplications: Effect.sync(() => [...apps.values()]),
  };
};
