// An in-memory account's Access applications, for the `DeployTarget` fakes: the three Access methods over one map. A
// created application takes a new AUD tag and a replaced one keeps its own, as Cloudflare assigns them.
import { Effect } from "effect";
import type { AccessApplication, DeployedAccessApplication } from "./access-application.ts";

export const accessStore = (initial: readonly DeployedAccessApplication[] = []) => {
  const apps = new Map(initial.map((a) => [a.id, a]));
  let next = 0;
  return {
    apps,
    accessApplications: Effect.sync(() => [...apps.values()]),
    putAccessApplication: (application: AccessApplication, id: string | null) =>
      Effect.sync(() => {
        const key = id ?? `access-${++next}`;
        apps.set(key, { ...application, id: key, aud: apps.get(key)?.aud ?? `aud-${key}` });
      }),
    deleteAccessApplication: (id: string) => Effect.sync(() => void apps.delete(id)),
  };
};
