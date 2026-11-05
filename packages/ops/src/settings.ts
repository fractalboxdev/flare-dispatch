// One shape for a Worker's settings, from either side of the drift check (FD-OPS-016): the record of the last deploy,
// which holds the rendered configuration and the secret names present when it deployed, and the deployed Worker as
// the Cloudflare API reports it.
import type { DeployedSettings } from "./drift.ts";
import type { WorkerConfig } from "./render.ts";

const arr = (v: unknown): readonly Record<string, unknown>[] =>
  Array.isArray(v) ? (v as Record<string, unknown>[]) : [];
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const sorted = (xs: readonly string[]) => [...xs].sort();
const byName = <T extends { name: string }>(xs: readonly T[]) =>
  [...xs].sort((a, b) => a.name.localeCompare(b.name));

/** The name of the Container application wrangler creates for a Worker's Container class. */
export const containerApplicationName = (worker: string, className: string): string =>
  `${worker}-${className.toLowerCase()}`;

/** A rendered configuration as the settings it deploys. */
export const settingsFromConfig = (
  worker: string,
  config: WorkerConfig,
  secrets: readonly string[],
): DeployedSettings => {
  const bindings: { name: string; type: string; target?: string }[] = [];
  const add = (name: unknown, type: string, target: unknown) => {
    const n = str(name);
    if (n === undefined) return;
    const t = str(target);
    bindings.push(t === undefined ? { name: n, type } : { name: n, type, target: t });
  };
  for (const d of arr(config["d1_databases"])) add(d["binding"], "d1", d["database_id"]);
  for (const k of arr(config["kv_namespaces"])) add(k["binding"], "kv_namespace", k["id"]);
  for (const r of arr(config["r2_buckets"])) add(r["binding"], "r2_bucket", r["bucket_name"]);
  for (const s of arr(config["services"])) add(s["binding"], "service", s["service"]);
  const dobs = (config["durable_objects"] as { bindings?: unknown } | undefined)?.bindings;
  for (const b of arr(dobs)) add(b["name"], "durable_object_namespace", b["class_name"]);
  const rawVars = (config["vars"] ?? {}) as Record<string, unknown>;
  const vars = Object.fromEntries(
    Object.entries(rawVars).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]),
  );
  const triggers = config["triggers"] as { crons?: unknown } | undefined;
  return {
    bindings: byName(bindings),
    vars,
    secrets: sorted(secrets),
    crons: sorted(Array.isArray(triggers?.crons) ? (triggers.crons as string[]) : []),
    routes: sorted(
      arr(config["routes"]).flatMap((r) =>
        str(r["pattern"]) === undefined ? [] : [r["pattern"] as string],
      ),
    ),
    compatibility_date: str(config["compatibility_date"]) ?? "",
    compatibility_flags: sorted(
      Array.isArray(config["compatibility_flags"])
        ? (config["compatibility_flags"] as string[])
        : [],
    ),
    containers: arr(config["containers"])
      .map((c) => ({
        class_name: (str(c["class_name"]) ?? "").toLowerCase(),
        max_instances: typeof c["max_instances"] === "number" ? c["max_instances"] : 0,
        image: str(c["image"]) ?? "",
      }))
      .sort((a, b) => a.class_name.localeCompare(b.class_name)),
  };
};

/** What the Cloudflare API reports for one deployed Worker. */
export interface ApiWorker {
  /** `GET /accounts/{account}/workers/scripts/{name}/settings` `result`. */
  readonly settings: {
    readonly bindings?: readonly Record<string, unknown>[];
    readonly compatibility_date?: string;
    readonly compatibility_flags?: readonly string[];
  };
  /** `GET .../scripts/{name}/schedules` `result.schedules[].cron`. */
  readonly crons: readonly string[];
  /** `GET /accounts/{account}/workers/domains?service={name}` hostnames. */
  readonly routes: readonly string[];
  /** The Worker's Container applications: class name, `max_instances` and image. */
  readonly containers: readonly {
    readonly class_name: string;
    readonly max_instances: number;
    readonly image: string;
  }[];
}

const API_TARGET: Readonly<Record<string, string>> = {
  d1: "id",
  kv_namespace: "namespace_id",
  r2_bucket: "bucket_name",
  service: "service",
  durable_object_namespace: "class_name",
};

/** The deployed Worker's settings: plain-text and JSON bindings as vars, secret bindings by name only. */
export const settingsFromApi = (api: ApiWorker): DeployedSettings => {
  const bindings: { name: string; type: string; target?: string }[] = [];
  const vars: Record<string, string> = {};
  const secrets: string[] = [];
  for (const b of api.settings.bindings ?? []) {
    const name = str(b["name"]);
    const type = str(b["type"]);
    if (name === undefined || type === undefined) continue;
    if (type === "plain_text") vars[name] = str(b["text"]) ?? "";
    else if (type === "json") vars[name] = JSON.stringify(b["json"]);
    else if (type === "secret_text") secrets.push(name);
    else {
      const key = API_TARGET[type];
      const target = key === undefined ? undefined : str(b[key]);
      bindings.push(target === undefined ? { name, type } : { name, type, target });
    }
  }
  return {
    bindings: byName(bindings),
    vars,
    secrets: sorted(secrets),
    crons: sorted(api.crons),
    routes: sorted(api.routes),
    compatibility_date: api.settings.compatibility_date ?? "",
    compatibility_flags: sorted(api.settings.compatibility_flags ?? []),
    containers: [...api.containers].sort((a, b) => a.class_name.localeCompare(b.class_name)),
  };
};

/** The Durable Object migration tags a configuration declares, in order. */
export const migrationTags = (config: WorkerConfig): readonly string[] =>
  arr(config["migrations"]).flatMap((m) =>
    str(m["tag"]) === undefined ? [] : [m["tag"] as string],
  );
