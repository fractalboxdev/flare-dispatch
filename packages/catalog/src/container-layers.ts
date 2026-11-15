// The per-lease Layers of the Container pool's run catalogue (`cloud-runner-entry.ts`): the agentic recipes' services
// and the scan runs' services, each built inside the execution from its `ExecutionLease` and the runner's services. A
// value the lease lacks fails the Layer, so the run ends `infra: <tag>` before its body starts. Node process code: the
// runner child builds these Layers inside the gate image, where the Container is the job sandbox.
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  AgentLease,
  SuppressionLedger,
  SuppressionReadFailed,
  TriageIssuesInput,
} from "@fractalboxdev/flare-dispatch-agentic";
import {
  cloudAgenticLayers,
  issuesFileReadLayer,
  prefetchIssues,
  type ArtifactSink,
  type CloudAgenticServices,
} from "@fractalboxdev/flare-dispatch-agentic/executor";
import { Artifact, Exec, Workspace, type Intents } from "@fractalboxdev/mameko-run";
import { Effect, Layer, Schema } from "effect";
import { containerGateExec } from "./command.ts";
import { CloudLeaseMissing, ExecutionLease, type LeaseLayerFailure } from "./execution-lease.ts";
import { ScanLease } from "./inputs.ts";
import {
  AdvisorySnapshots,
  AdvisorySnapshotUnreadable,
  ScanBundleStore,
  ScanBundleUnreadable,
} from "./ports.ts";
import type { LeaseLayerContext } from "./runs.ts";
import { nodeScanImage } from "./scan-image.ts";
import { ScanSettings, type ScanServices } from "./security-gate.ts";

/** The lease's `cloudLease` decoded with `schema`, or `CloudLeaseMissing` naming why it does not decode. */
const cloudLeaseOf = <S extends Schema.Decoder<unknown>>(schema: S, input: unknown) =>
  Schema.decodeUnknownEffect(schema)(
    input !== null && typeof input === "object" && !Array.isArray(input)
      ? (input as { readonly cloudLease?: unknown }).cloudLease
      : undefined,
  ).pipe(Effect.mapError((e) => new CloudLeaseMissing({ detail: e.message })));

/** The workspace's root or base commit could not be read through the job sandbox. */
export class WorkspaceUnresolved extends Schema.TaggedError<WorkspaceUnresolved>()(
  "WorkspaceUnresolved",
  { detail: Schema.String },
) {}

/**
 * The checkout's root directory and its `HEAD`, read by one `git` command in the job sandbox, whose working directory
 * is the workspace the device executor checked the lease's source out into (MAMEKO-EXEC-010).
 */
const workspaceCheckout = (exec: Exec["Service"]) =>
  exec.run("workspace", { argv: ["git", "rev-parse", "--show-toplevel", "HEAD"] }).pipe(
    Effect.mapError((e) => new WorkspaceUnresolved({ detail: e._tag })),
    Effect.flatMap(({ exitCode, stdout, stderr }) => {
      const [root, head] = stdout.trim().split("\n");
      return exitCode === 0 &&
        root !== undefined &&
        head !== undefined &&
        /^[0-9a-f]{40,64}$/.test(head)
        ? Effect.succeed({ root, head })
        : Effect.fail(
            new WorkspaceUnresolved({ detail: `git rev-parse exit ${exitCode}: ${stderr.trim()}` }),
          );
    }),
  );

/**
 * An `ArtifactSink` over mameko's `Artifact`: each artifact's bytes go to a file in the workspace, which the device
 * executor reads and uploads under `artifact/<execution id>/<epoch>/<name>` outside the job sandbox
 * (MAMEKO-EXEC-020), and the file is removed after. A name mameko's artifact grammar refuses fails the put.
 */
const workspaceArtifactSink = (artifact: Artifact["Service"], workspace: string): ArtifactSink => ({
  put: async (name, bytes) => {
    const file = `.fd-artifact-${randomUUID()}`;
    await writeFile(join(workspace, file), bytes);
    try {
      await Effect.runPromise(
        artifact.upload(name, file).pipe(Effect.mapError((e) => new Error(`${e._tag}: ${name}`))),
      );
    } finally {
      await rm(join(workspace, file), { force: true });
    }
  },
});

/**
 * The suppression ledger where the job holds no binding of the control plane's database and the control plane serves
 * no ledger read (FD-AGT-043): every lookup fails, so a recipe concludes `suppression: read failed` and opens nothing.
 * An empty answer would read as "never proposed".
 */
const unreachableSuppressionLedger: Layer.Layer<SuppressionLedger> = Layer.succeed(
  SuppressionLedger,
  {
    lookup: (key) =>
      Effect.fail(
        new SuppressionReadFailed({
          key,
          detail: "no suppression ledger read reaches this executor",
        }),
      ),
  },
);

/** The scratch directory of one execution, outside the checkout, removed when the execution's Layers close. */
const scratchDir = (prefix: string) =>
  Effect.acquireRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), prefix))),
    (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
  );

/** The run whose issue read happens in the setup phase, and the workspace file it reads in the agent phase. */
export const SETUP_ISSUES_READER = "triage-issues";
export const ISSUES_FILE = ".fd-triage-issues.json";

/**
 * `triage-issues`' issue read before the setup phase ends: its open issues, fetched under the setup grants to the issues
 * file in the workspace, and the `IssuesRead` over that file its agent phase uses. Its agent phase reaches no host but
 * the model gateway, because it reads untrusted issues beside private data (FD-AGT-005). Any other run reads nothing
 * here.
 */
const setupIssuesRead = (
  run: string,
  input: unknown,
  workspace: string,
  fetch: typeof globalThis.fetch,
) =>
  Effect.gen(function* () {
    if (run !== SETUP_ISSUES_READER) return undefined;
    const { repo } = yield* Schema.decodeUnknownEffect(TriageIssuesInput)(input).pipe(
      Effect.mapError((e) => new CloudLeaseMissing({ detail: e.message })),
    );
    const file = join(workspace, ISSUES_FILE);
    yield* prefetchIssues(`${repo.owner}/${repo.name}`, file, fetch);
    return issuesFileReadLayer(file);
  });

/** What the Container entry fixes for every agentic lease. */
export interface ContainerAgenticOptions {
  /** The job's `fetch`; every request leaves through the Container's outbound handler. */
  readonly fetch: typeof globalThis.fetch;
  /** The runner's environment; a sandboxed command inherits only its allowlisted variables. */
  readonly env: NodeJS.ProcessEnv;
  /** The image's coding-agent command; an executable the image lacks ends the edit loop unstarted (FD-AGT-067). */
  readonly editLoop: readonly [string, ...string[]];
}

/**
 * The agentic recipes' services for one execution on a Container: the lease's model route and control-plane origin
 * from its `cloudLease`; the execution id from the payload; the checkout the device executor placed in the workspace,
 * verified through mameko's `Workspace` and read at its `HEAD` as the staged write's base commit; artifacts through
 * mameko's `Artifact`; and the suppression ledger that fails every read. The setup egress phase ends once the checkout is
 * read, and for `triage-issues` once its issues are read to the workspace, so the edit loop and every model call run
 * under the `agent` grants (FD-AGT-005, FD-AGT-010). The runner holds no credential, so no model request is refused for
 * carrying one (FD-AGT-011).
 */
export const containerAgenticLayers = (
  options: ContainerAgenticOptions,
): Layer.Layer<CloudAgenticServices, LeaseLayerFailure, LeaseLayerContext> =>
  Layer.unwrap(
    Effect.gen(function* () {
      const lease = yield* ExecutionLease;
      const config = yield* cloudLeaseOf(AgentLease, lease.input);
      yield* (yield* Workspace).checkout();
      const exec = yield* Exec;
      const checkout = yield* workspaceCheckout(exec);
      const issuesRead = yield* setupIssuesRead(
        lease.run,
        lease.input,
        checkout.root,
        options.fetch,
      );
      yield* exec.endSetup();
      const artifact = yield* Artifact;
      const stagingDir = yield* scratchDir("fd-staging-");
      return cloudAgenticLayers({
        executionId: lease.executionId,
        checkout: checkout.root,
        baseCommit: checkout.head,
        stagingDir,
        editLoop: options.editLoop,
        modelGatewayUrl: config.modelGatewayUrl,
        controlPlaneUrl: config.controlPlaneUrl,
        fetch: options.fetch,
        artifacts: workspaceArtifactSink(artifact, checkout.root),
        env: options.env,
        credentials: [],
        suppressionLedger: unreachableSuppressionLedger,
        ...(issuesRead === undefined ? {} : { issuesRead }),
      });
    }),
  );

const sha256Stream = () => {
  const hash = createHash("sha256");
  const pass = new Transform({
    transform: (chunk: Buffer, _encoding, done) => {
      hash.update(chunk);
      done(null, chunk);
    },
  });
  return { pass, digest: () => hash.digest("hex") };
};

/**
 * `ScanBundleStore` over the lease's presigned read of `cas/<bundleDigest>`, which the Container's outbound handler
 * passes to the object store in every egress phase. A digest other than the lease's, or a lease with no read, answers
 * no object; a `404` answers no object; any other failure is `ScanBundleUnreadable`.
 */
const presignedScanBundleStore = (
  lease: ScanLease,
  fetch: typeof globalThis.fetch,
): Layer.Layer<ScanBundleStore> =>
  Layer.succeed(ScanBundleStore, {
    read: (digest) =>
      lease.bundleUrl === undefined || digest !== lease.bundleDigest
        ? Effect.succeed(null)
        : Effect.tryPromise({
            try: async () => {
              const response = await fetch(lease.bundleUrl!);
              if (response.status === 404) return null;
              if (!response.ok) throw new Error(`status ${response.status}`);
              return new Uint8Array(await response.arrayBuffer());
            },
            catch: (e) => new ScanBundleUnreadable({ digest, detail: String(e) }),
          }),
  });

/**
 * `AdvisorySnapshots` over the lease's recorded snapshots: reading an ecosystem places its archive at
 * `<advisoryDir>/osv-scanner/<ecosystem>/all.zip`, the layout OSV-Scanner reads offline, read-only and outside the
 * checkout (FD-GATE-104), from the lease's presigned read; an archive whose SHA-256 differs from the recorded digest is
 * `AdvisorySnapshotUnreadable`. An ecosystem the lease does not carry has no snapshot.
 */
const presignedAdvisorySnapshots = (
  lease: ScanLease,
  advisoryDir: string,
  fetch: typeof globalThis.fetch,
): Layer.Layer<AdvisorySnapshots> =>
  Layer.succeed(AdvisorySnapshots, {
    read: (ecosystem) => {
      const leased = lease.advisories.find((a) => a.ecosystem === ecosystem);
      if (leased === undefined) return Effect.succeed(null);
      return Effect.tryPromise({
        try: async () => {
          const response = await fetch(leased.url);
          if (!response.ok || response.body === null) throw new Error(`status ${response.status}`);
          const dir = join(advisoryDir, "osv-scanner", ecosystem);
          await mkdir(dir, { recursive: true });
          const file = join(dir, "all.zip");
          const hash = sha256Stream();
          await pipeline(
            Readable.fromWeb(response.body as unknown as Parameters<typeof Readable.fromWeb>[0]),
            hash.pass,
            createWriteStream(file, { flags: "wx" }),
          );
          const digest = hash.digest();
          if (digest !== leased.digest) {
            await rm(file, { force: true });
            throw new Error(`archive SHA-256 ${digest} differs from ${leased.digest}`);
          }
          await chmod(file, 0o444);
          return { ecosystem, digest: leased.digest, lastModified: leased.lastModified };
        },
        catch: (e) => new AdvisorySnapshotUnreadable({ ecosystem, detail: String(e) }),
      });
    },
  });

/**
 * The scan runs' services for one execution on a Container, from the lease's `cloudLease`: the deployment's
 * `scan.bundleDigest` and `scan.advisoryMaxAgeHours`, the scan bundle and advisory snapshots through the lease's
 * presigned reads, the image's scanners, and the host's processes with the setup phase ended through mameko's `Exec`,
 * so no egress host is reachable once a scanner starts (FD-GATE-110).
 */
export const containerScanLayers = (
  fetch: typeof globalThis.fetch,
): Layer.Layer<Exclude<ScanServices, Intents>, LeaseLayerFailure, LeaseLayerContext> =>
  Layer.unwrap(
    Effect.gen(function* () {
      const lease = yield* ExecutionLease;
      const config = yield* cloudLeaseOf(ScanLease, lease.input);
      const advisoryDir = yield* scratchDir("fd-advisories-");
      return Layer.mergeAll(
        containerGateExec,
        Layer.succeed(ScanSettings, {
          bundleDigest: config.bundleDigest,
          advisoryMaxAgeHours: config.advisoryMaxAgeHours,
          advisoryDir,
        }),
        presignedScanBundleStore(config, fetch),
        presignedAdvisorySnapshots(config, advisoryDir, fetch),
        nodeScanImage(),
      );
    }),
  );
