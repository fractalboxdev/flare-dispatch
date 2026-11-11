// The run catalogue as intake reads it, built from FlareDispatch's catalogue package. A run's manifest key selects
// its parameter schema and its catalogue request decoder (specs/runs/gate.md § Recipes); the decoder takes the
// webhook as the catalogue's `WebhookDelivery`. A run with no gate manifest key answers dispatches only.
import {
  CheckStep,
  DeploySmokeEntrySchema,
  deploymentStatusDecoder,
  gateContextOf,
  lookupRun,
  MatrixEntrySchema,
  offloadTestDecoder,
  OxlintEntrySchema,
  oxlintDecoder,
  requestPlacement,
  SandboxImageEntrySchema,
  sandboxImageDecoder,
  WorkerDeployEntrySchema,
  workerDeployDecoder,
  type CatalogEntry,
  type CheckInput,
  type DispatchEvent as CatalogEvent,
  type WorkerDeployEntry,
} from "@fractalboxdev/flare-dispatch-catalog";
import type { Deployment } from "@fractalboxdev/flare-dispatch-profile";
import { Match, Option, Schema } from "effect";
import { catalogEventOf, type TriggerContext } from "./delivery.ts";
import type { DispatchEvent } from "./event.ts";
import type { EntryView, IntakeRun, RunCatalog } from "./runs.ts";

/** A `check` entry's parameters: the steps one execution runs in order (FD-GATE-019). */
export const CheckParams = Schema.Struct({
  steps: Schema.Array(CheckStep).check(Schema.isMinLength(1)),
});

type CatalogDecoder = (event: CatalogEvent) => Option.Option<unknown>;

/** What intake reads of one manifest key: the entry's parameter schema and the decoder its parameters bind. */
interface ManifestRecipe {
  readonly params: Schema.Decoder<unknown>;
  readonly decoder: (params: unknown, view: EntryView) => Option.Option<CatalogDecoder>;
}

const recipe = <A>(
  params: Schema.Decoder<A>,
  decoder: (params: A, view: EntryView) => CatalogDecoder,
): ManifestRecipe => ({
  params,
  decoder: (raw, view) =>
    Option.map(Schema.decodeUnknownOption(params)(raw), (p) => decoder(p, view)),
});

/** `check` on a gate event: one execution runs the entry's steps under the entry's label (FD-GATE-017, -019). */
const checkDecoder =
  (params: typeof CheckParams.Type, view: EntryView): CatalogDecoder =>
  (event) =>
    Match.value(event).pipe(
      Match.tag("webhook", ({ delivery }) =>
        Option.map(gateContextOf(delivery), (ctx): CheckInput => ({
          ...ctx,
          ...(view.skipAuthors === undefined ? {} : { skipAuthors: view.skipAuthors }),
          ...(view.label === null ? {} : { label: view.label }),
          steps: params.steps,
        })),
      ),
      Match.orElse(() => Option.none()),
    );

/** The manifest entry's label is the deploy's label, so the dedup key and the serial group agree (FD-GATE-062). */
const labelled = (params: WorkerDeployEntry, label: string | null): WorkerDeployEntry => {
  const { label: _ignored, ...rest } = params;
  return label === null ? rest : { ...rest, label };
};

/** Each gate manifest key's parameters and request decoder (specs/runs/gate.md § Recipes). */
const MANIFEST_RECIPES: Readonly<Record<string, ManifestRecipe>> = {
  check: recipe(CheckParams, checkDecoder),
  oxlint: recipe(OxlintEntrySchema, (p, view) => oxlintDecoder(p, view.skipAuthors)),
  offloadTest: recipe(MatrixEntrySchema, (p, view) => offloadTestDecoder(p, view.skipAuthors)),
  workerDeploy: recipe(WorkerDeployEntrySchema, (p, view) =>
    workerDeployDecoder(labelled(p, view.label)),
  ),
  deploySmoke: recipe(DeploySmokeEntrySchema, (p) => deploymentStatusDecoder(p)),
  sandboxImage: recipe(SandboxImageEntrySchema, (p) => sandboxImageDecoder(p)),
};

const manifestRecipeOf = (entry: CatalogEntry): ManifestRecipe | undefined =>
  entry.manifestKey !== null && Object.hasOwn(MANIFEST_RECIPES, entry.manifestKey)
    ? MANIFEST_RECIPES[entry.manifestKey]
    : undefined;

/** A run's request decoder: its manifest key's catalogue decoder over the webhook's delivery. */
export const requestDecoderOf =
  (entry: CatalogEntry) =>
  (event: DispatchEvent, view: EntryView, context: TriggerContext): Option.Option<unknown> => {
    const found = manifestRecipeOf(entry);
    if (found === undefined) return Option.none();
    return Option.flatMap(
      Option.all([found.decoder(view.params, view), catalogEventOf(event, context)]),
      ([decode, catalogEvent]) => decode(catalogEvent),
    );
  };

/** The deployment's runs; a run the deployment refuses to execute is not in its catalogue. */
export const catalogRuns =
  (deployment: Deployment): RunCatalog =>
  (name) =>
    Match.value(lookupRun(deployment, name)).pipe(
      Match.tag("Available", ({ entry }): IntakeRun | undefined => ({
        name: entry.spec.name,
        params: manifestRecipeOf(entry)?.params ?? Schema.Unknown,
        input: entry.input,
        trigger: requestDecoderOf(entry),
        defaultClass: entry.spec.limits.qosClass,
        qosCeiling: entry.spec.limits.qosCeiling,
        hostedModelCalls: entry.spec.needsModel,
        maxDurationSec: entry.spec.limits.maxDurationSec,
        ownsCheck: true,
        gating: true,
        retries: entry.spec.retries,
        grants: { setup: [...entry.spec.grants.setup], agent: [...entry.spec.grants.agent] },
        placement: (inputs) => requestPlacement(entry.spec, inputs),
      })),
      Match.orElse(() => undefined),
    );
