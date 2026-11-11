// The live `DeployTarget`: the Cloudflare API for the deployed Workers, their schedules, domains and Container
// applications and the record of the last deploy in the artifacts bucket; `wrangler` for D1 migrations and Worker
// deploys; the GitHub API with the App JWT for the App's registration and the default branch's ruleset; the Workers'
// own hostnames for the post-deploy probes; and the overlay's alert sink for `deploy-probe-failed`.
import { rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Effect, Layer } from "effect";
import { alarmMessage } from "../alarms.ts";
import {
  DeployTarget,
  scriptName,
  TargetFailed,
  type CanaryResult,
  type Deployed,
  type RenderedWorker,
} from "../deploy.ts";
import type { AppPermissions, DeployedSettings } from "../drift.ts";
import type { OverlayValues } from "../overlay.ts";
import { parseJsonc } from "../render.ts";
import { migrationTags, settingsFromApi, settingsFromConfig, type ApiWorker } from "../settings.ts";
import {
  appJwt,
  appliedMigrations,
  deployedVersion,
  wrangler,
  type CloudflareClient,
  type CommandRunner,
  type GithubClient,
} from "./clients.ts";

/** What the live target runs with. */
export interface LiveTargetConfig {
  readonly overlay: OverlayValues;
  readonly cloudflare: CloudflareClient;
  readonly github: GithubClient;
  readonly runner: CommandRunner;
  /** The repository root; each template path is relative to it. */
  readonly root: string;
  /** The account-scoped API token `wrangler` reads from `CLOUDFLARE_API_TOKEN`. */
  readonly apiToken: string;
  /** The GitHub App's private key, a Worker secret on the control plane and a repository secret in the workflow. */
  readonly appPrivateKey?: string;
  /** `<owner>/<repo>` whose default branch's ruleset the drift check reads. */
  readonly repository?: string;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  /** Writes a rendered configuration beside its template, for `wrangler -c`; removed after use. */
  readonly writeFile?: (path: string, text: string) => void;
  readonly removeFile?: (path: string) => void;
}

/**
 * The record of a Worker's last deploy (FD-OPS-015): its rendered configuration, the secret names present when it
 * deployed and its Container applications as deployed. The rendered configuration names each Container image by its
 * Dockerfile, and the Cloudflare API reports the registry image `wrangler` built from it, so the record keeps the
 * deployed Container applications for the drift check to compare like with like (FD-OPS-016).
 */
export interface DeployRecord {
  readonly rendered: string;
  readonly secrets: readonly string[];
  readonly containers?: DeployedSettings["containers"];
}

/** The artifacts-bucket key of a Worker's record of its last deploy. */
export const recordKey = (scriptName: string): string => `deploys/${scriptName}/last.json`;

const RECORD_BUCKET = "ARTIFACTS";

export { scriptName };

const arr = <T>(v: unknown): readonly T[] => (Array.isArray(v) ? (v as T[]) : []);

export const liveDeployTarget = (c: LiveTargetConfig): Layer.Layer<DeployTarget> => {
  const account = `/accounts/${c.overlay.accountId}`;
  const fetcher = c.fetch ?? fetch;
  const now = c.now ?? Date.now;
  const write = c.writeFile ?? ((p: string, t: string) => writeFileSync(p, t));
  const remove = c.removeFile ?? ((p: string) => rmSync(p, { force: true }));
  const bucket = c.overlay.r2[RECORD_BUCKET];

  /** Runs `wrangler` with the rendered configuration written beside its template. */
  const withRendered = <A>(
    r: RenderedWorker,
    use: (configPath: string) => Effect.Effect<A, TargetFailed>,
  ) =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const dir = r.templatePath === undefined ? c.root : dirname(join(c.root, r.templatePath));
        const path = join(dir, ".fd-rendered.jsonc");
        write(path, r.text);
        return path;
      }),
      use,
      (path) => Effect.sync(() => remove(path)),
    );

  const env = { CLOUDFLARE_API_TOKEN: c.apiToken, CLOUDFLARE_ACCOUNT_ID: c.overlay.accountId };

  const deployedSettings = (r: RenderedWorker) =>
    Effect.gen(function* () {
      const name = scriptName(r);
      const settings = (yield* c.cloudflare.json(
        "GET",
        `${account}/workers/scripts/${name}/settings`,
      )) as ApiWorker["settings"] | null;
      if (settings === null) return null;
      const schedules = (yield* c.cloudflare.json(
        "GET",
        `${account}/workers/scripts/${name}/schedules`,
      )) as {
        schedules?: { cron?: string }[];
      } | null;
      const domains = arr<{ hostname?: string }>(
        yield* c.cloudflare.json(
          "GET",
          `${account}/workers/domains?service=${encodeURIComponent(name)}`,
        ),
      );
      const applications = arr<{
        name?: string;
        max_instances?: number;
        configuration?: { image?: string };
      }>(yield* c.cloudflare.json("GET", `${account}/containers/applications`));
      return settingsFromApi({
        settings,
        crons: (schedules?.schedules ?? []).flatMap((s) => (s.cron === undefined ? [] : [s.cron])),
        routes: domains.flatMap((d) => (d.hostname === undefined ? [] : [d.hostname])),
        containers: applications
          .filter((a) => a.name?.startsWith(`${name}-`) === true)
          .map((a) => ({
            class_name: a.name!.slice(name.length + 1),
            max_instances: a.max_instances ?? 0,
            image: a.configuration?.image ?? "",
          })),
      });
    });

  const readRecord = (r: RenderedWorker) =>
    Effect.gen(function* () {
      if (bucket === undefined)
        return yield* new TargetFailed({
          operation: "record",
          message: "the overlay names no r2.ARTIFACTS bucket",
        });
      const raw = yield* c.cloudflare.raw(
        "GET",
        `${account}/r2/buckets/${bucket}/objects/${recordKey(scriptName(r))}`,
      );
      if (raw === null) return null;
      return JSON.parse(raw) as DeployRecord;
    });

  const jwt = Effect.gen(function* () {
    if (c.appPrivateKey === undefined || c.appPrivateKey === "")
      return yield* new TargetFailed({
        operation: "github-app",
        message: "GITHUB_APP_PRIVATE_KEY is not set",
      });
    return appJwt(c.overlay.github.appId, c.appPrivateKey, Math.floor(now() / 1000));
  });

  return Layer.succeed(DeployTarget, {
    deployedSettings,
    lastRecord: (r) =>
      Effect.map(readRecord(r), (rec): DeployedSettings | null => {
        if (rec === null) return null;
        const settings = settingsFromConfig(scriptName(r), parseJsonc(rec.rendered), rec.secrets);
        return rec.containers === undefined
          ? settings
          : { ...settings, containers: rec.containers };
      }),
    appRegistration: Effect.gen(function* () {
      const app = (yield* c.github.json("GET", "/app", yield* jwt)) as {
        permissions?: Record<string, "read" | "write" | "admin">;
        events?: string[];
      };
      return {
        default_permissions: app.permissions ?? {},
        default_events: app.events ?? [],
      } satisfies AppPermissions;
    }),
    requiredChecks: Effect.gen(function* () {
      const repo = c.repository;
      if (repo === undefined || !repo.includes("/"))
        return yield* new TargetFailed({
          operation: "ruleset",
          message: "GITHUB_REPOSITORY names no <owner>/<repo>",
        });
      const appToken = yield* jwt;
      const installation = (yield* c.github.json(
        "GET",
        `/repos/${repo}/installation`,
        appToken,
      )) as { id: number };
      const { token } = (yield* c.github.json(
        "POST",
        `/app/installations/${installation.id}/access_tokens`,
        appToken,
        {
          repositories: [repo.split("/")[1]],
          permissions: { administration: "read", metadata: "read" },
        },
      )) as { token: string };
      const { default_branch } = (yield* c.github.json("GET", `/repos/${repo}`, token)) as {
        default_branch: string;
      };
      const rules = arr<{
        type?: string;
        parameters?: { required_status_checks?: { context?: string }[] };
      }>(
        yield* c.github.json(
          "GET",
          `/repos/${repo}/rules/branches/${encodeURIComponent(default_branch)}`,
          token,
        ),
      );
      return rules
        .filter((rule) => rule.type === "required_status_checks")
        .flatMap((rule) => rule.parameters?.required_status_checks ?? [])
        .flatMap((check) => (check.context === undefined ? [] : [check.context]));
    }),
    applyD1Migrations: (rendered) =>
      Effect.gen(function* () {
        const applied: string[] = [];
        for (const r of rendered)
          for (const db of arr<{ database_name?: string; migrations_dir?: string }>(
            r.config["d1_databases"],
          )) {
            if (db.migrations_dir === undefined || db.database_name === undefined) continue;
            const stdout = yield* withRendered(r, (path) =>
              wrangler(
                c.runner,
                c.root,
                ["d1", "migrations", "apply", db.database_name!, "--remote", "-c", path],
                env,
              ),
            );
            applied.push(...appliedMigrations(stdout));
          }
        return applied;
      }),
    deployWorker: (r) =>
      Effect.gen(function* () {
        const name = scriptName(r);
        const deployments = (yield* c.cloudflare.json(
          "GET",
          `${account}/workers/scripts/${name}/deployments`,
        )) as {
          deployments?: { versions?: { version_id?: string }[] }[];
        } | null;
        const previous = deployments?.deployments?.[0]?.versions?.[0]?.version_id ?? null;
        const record = yield* readRecord(r);
        const before = new Set(record === null ? [] : migrationTags(parseJsonc(record.rendered)));
        const stdout = yield* withRendered(r, (path) =>
          wrangler(c.runner, c.root, ["deploy", "-c", path], env),
        );
        const version = deployedVersion(stdout);
        if (version === null)
          return yield* new TargetFailed({
            operation: `wrangler deploy ${name}`,
            message: "printed no version id",
          });
        return {
          worker: r.worker,
          version,
          previousVersion: previous,
          durableObjectMigrations: migrationTags(r.config).filter((t) => !before.has(t)),
        } satisfies Deployed;
      }),
    probe: (r) =>
      Effect.gen(function* () {
        const host = r.hostKey === undefined ? undefined : c.overlay.hostnames[r.hostKey];
        if (host === undefined)
          return yield* new TargetFailed({
            operation: `probe ${r.worker}`,
            message: "the overlay names no hostname",
          });
        const res = yield* Effect.tryPromise({
          try: () => fetcher(`https://${host}${r.probePath ?? "/health"}`, { redirect: "manual" }),
          catch: (e) => new TargetFailed({ operation: `probe ${r.worker}`, message: String(e) }),
        });
        return res.ok;
      }),
    floorCanary: (rendered) =>
      Effect.succeed<CanaryResult>(
        rendered.every((r) => arr(r.config["containers"]).length === 0)
          ? { status: "not-applicable", detail: "the deploy carries no Container class" }
          : {
              status: "failed",
              detail:
                "the coordinator exposes no floor canary to run on the deployed digest (MAMEKO-OPS-012)",
            },
      ),
    writeRecord: (r) =>
      Effect.gen(function* () {
        const deployed = yield* deployedSettings(r);
        if (bucket === undefined)
          return yield* new TargetFailed({
            operation: "record",
            message: "the overlay names no r2.ARTIFACTS bucket",
          });
        yield* c.cloudflare.raw(
          "PUT",
          `${account}/r2/buckets/${bucket}/objects/${recordKey(scriptName(r))}`,
          JSON.stringify({
            rendered: r.text,
            secrets: deployed?.secrets ?? [],
            containers: deployed?.containers ?? [],
          } satisfies DeployRecord),
        );
      }),
    raiseAlarm: (name, detail) =>
      Effect.gen(function* () {
        const alarm = {
          name,
          severity: "page" as const,
          dedupeKey: name,
          state: "raised" as const,
          detail,
        };
        const sink = c.overlay.alerts.sink;
        if (!sink.startsWith("https://")) {
          yield* Effect.logError(
            `${alarmMessage(alarm)} (the email sink ${sink} is reached by the control plane only)`,
          );
          return;
        }
        yield* Effect.tryPromise(() =>
          fetcher(sink, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              alarm: name,
              severity: "page",
              state: "raised",
              dedupe_key: name,
              runbook: "R4",
              detail,
              message: alarmMessage(alarm),
            }),
          }),
        ).pipe(Effect.catch((e) => Effect.logError(`alarm ${name}: ${String(e)}`)));
      }),
  });
};
