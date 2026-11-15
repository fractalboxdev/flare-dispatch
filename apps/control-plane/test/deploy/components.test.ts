// The deploy suite of `V-DEPLOY` (specs/verification.md § Harness catalog) for the control plane's components
// (specs/architecture.md § Components): `fd deploy` over the committed control-plane template and the placeholder
// overlay renders a Worker whose every Durable Object and Container class is an export of the bundled Worker, with
// host-cloudflare's classes re-exported under their names and one host-cloudflare Container class per Container pool.
import {
  EpochAnchor as MamekoEpochAnchor,
  ExecutionEngine as MamekoExecutionEngine,
  ExecutorChannel as MamekoExecutorChannel,
  LivenessMonitor as MamekoLivenessMonitor,
  PoolController as MamekoPoolController,
} from "@fractalboxdev/mameko-host-cloudflare";
import { ControlPool } from "@fractalboxdev/mameko-host-cloudflare";
import { PoolContainer } from "@fractalboxdev/mameko-host-cloudflare/containers";
import { describe, expect, it } from "vitest";
import { POOL_DECLARATIONS } from "../../src/pools.ts";
import * as controlPlane from "../../src/worker.ts";
import { account } from "./support.ts";

const SECRETS = { WEBHOOK_SECRET: "webhook-secret-value" };

const named = (config: Record<string, unknown> | undefined, key: string): readonly string[] => {
  const value = config?.[key];
  const list = Array.isArray(value)
    ? value
    : ((value as { bindings?: unknown[] } | undefined)?.bindings ?? []);
  return (list as { class_name: string }[]).map((b) => b.class_name);
};

const exported = controlPlane as unknown as Readonly<Record<string, unknown>>;

/** An ES256 private JWK, as the launch signing key Worker secret holds it. */
const launchSigningKey = async (): Promise<string> => {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  return JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey));
};

describe("fd deploy and the control plane's components", () => {
  it("[FD-ARCH-001] every Durable Object and Container class the deployed configuration names is an export of the bundled Worker, host-cloudflare's under their own names, and each Container pool's class is host-cloudflare's PoolContainer", async () => {
    const deployed = account(SECRETS);
    expect((await deployed.deploy()).ok).toBe(true);
    const config = deployed.config();
    const bound = named(config, "durable_objects");
    const containers = named(config, "containers");
    for (const name of [...bound, ...containers])
      expect(typeof exported[name], `${name} is exported`).toBe("function");

    const mameko: Readonly<Record<string, unknown>> = {
      ExecutionEngine: MamekoExecutionEngine,
      ExecutorChannel: MamekoExecutorChannel,
      EpochAnchor: MamekoEpochAnchor,
      PoolController: MamekoPoolController,
      LivenessMonitor: MamekoLivenessMonitor,
    };
    for (const [name, base] of Object.entries(mameko)) {
      expect(bound).toContain(name);
      const cls = exported[name] as { prototype: object };
      expect(cls === base || cls.prototype instanceof (base as never), name).toBe(true);
    }

    // One Container class per Container pool: the declaration's binding names it and its admission cap sits below the
    // class's `max_instances`.
    const instances = Object.fromEntries(
      ((config?.["containers"] ?? []) as { class_name: string; max_instances: number }[]).map(
        (c) => [c.class_name, c.max_instances],
      ),
    );
    const doBindings = Object.fromEntries(
      (
        (
          config?.["durable_objects"] as
            | { bindings?: { name: string; class_name: string }[] }
            | undefined
        )?.bindings ?? []
      ).map((b) => [b.name, b.class_name]),
    );
    expect(Object.keys(POOL_DECLARATIONS).sort()).toEqual([
      "agent",
      "browser",
      "control",
      "lean",
      "release",
    ]);
    // The `control` pool's container is the pool controller's own binding, a mameko `ControlPool` with no Container
    // class (MAMEKO-EXEC-057).
    expect(doBindings[POOL_DECLARATIONS["control"]!.container]).toBe("PoolController");
    expect(containers).not.toContain("PoolController");
    expect(
      (exported["PoolController"] as { prototype: object }).prototype instanceof ControlPool,
    ).toBe(true);
    for (const [pool, declaration] of Object.entries(POOL_DECLARATIONS)) {
      if (pool === "control") continue;
      const className = doBindings[declaration.container]!;
      expect(containers, pool).toContain(className);
      expect(declaration.max_instances, pool).toBe(instances[className]);
      expect(declaration.admission_cap, pool).toBeLessThan(declaration.max_instances);
      // `PoolContainer` sets `enableInternet` false, no allowed host and HTTPS interception (MAMEKO-ISO-018).
      const cls = exported[className] as { prototype: object };
      expect(cls.prototype instanceof PoolContainer, className).toBe(true);
    }
    // The Containers runtime calls each outbound handler through the Worker's own `ContainerProxy` export.
    expect(typeof exported["ContainerProxy"]).toBe("function");
  });

  it("[FD-ARCH-001] the deployed Worker registers each Container pool as a cloudflare executor once it holds the launch signing key, and the control pool alone without it", async () => {
    const withKey = account({ ...SECRETS, LAUNCH_SIGNING_KEY: await launchSigningKey() });
    expect((await withKey.deploy()).ok).toBe(true);
    const mf = await withKey.serve();
    try {
      await (await mf.dispatchFetch("https://control-plane.example/")).arrayBuffer();
      const db = await mf.getD1Database("DB");
      const { results } = await db
        .prepare(
          "select executor_id, kind, slots_json from mameko_executors where kind = 'cloudflare'",
        )
        .all<{ executor_id: string; kind: string; slots_json: string }>();
      expect(
        Object.fromEntries(results.map((r) => [r.executor_id, JSON.parse(r.slots_json).total])),
      ).toEqual(
        Object.fromEntries(
          Object.entries(POOL_DECLARATIONS).map(([pool, d]) => [pool, d.admission_cap]),
        ),
      );
    } finally {
      await mf.dispose();
    }

    const withoutKey = account(SECRETS);
    expect((await withoutKey.deploy()).ok).toBe(true);
    const bare = await withoutKey.serve();
    try {
      await (await bare.dispatchFetch("https://control-plane.example/")).arrayBuffer();
      const db = await bare.getD1Database("DB");
      const { results } = await db
        .prepare("select executor_id from mameko_executors where kind = 'cloudflare'")
        .all();
      expect(results).toEqual([{ executor_id: "control" }]);
    } finally {
      await bare.dispose();
    }
  });
});
