// The run catalogue as intake reads it, built from FlareDispatch's catalogue package. A run's manifest key selects
// its parameter schema and its request decoder (specs/runs/gate.md § Recipes, specs/runs/agentic.md § Recipes): a gate
// recipe's catalogue decoder takes the webhook as the catalogue's `WebhookDelivery`; `pr-review` reads the
// `pull_request` payload and `improve-pr` answers its schedule. A run with no manifest recipe answers dispatches only.
import {
  ImprovePrParams,
  improvePrRequest,
  PrReviewParams,
  prReviewRequest,
} from "@fractalboxdev/flare-dispatch-agentic";
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
  WorkerDeployInput,
  workerDeploySerialGroup,
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

/** A run's input for an event intake received, or none when the run does not answer it. */
type RequestDecoder = (event: DispatchEvent, context: TriggerContext) => Option.Option<unknown>;

/** What intake reads of one manifest key: the entry's parameter schema and the decoder its parameters bind. */
interface ManifestRecipe {
  readonly params: Schema.Decoder<unknown>;
  readonly decoder: (params: unknown, view: EntryView) => Option.Option<RequestDecoder>;
}

const recipe = <A>(
  params: Schema.Decoder<A>,
  decoder: (params: A, view: EntryView) => RequestDecoder,
): ManifestRecipe => ({
  params,
  decoder: (raw, view) =>
    Option.map(Schema.decodeUnknownOption(params)(raw), (p) => decoder(p, view)),
});

/** A gate recipe: its catalogue decoder over the webhook's `WebhookDelivery`; it answers no other trigger. */
const gateRecipe = <A>(
  params: Schema.Decoder<A>,
  decoder: (params: A, view: EntryView) => CatalogDecoder,
): ManifestRecipe =>
  recipe(params, (p, view) => {
    const decode = decoder(p, view);
    return (event, context) => Option.flatMap(catalogEventOf(event, context), decode);
  });

/** `pr-review` on a `pull_request` webhook it starts on (FD-AGT-045); a dispatch carries its input whole. */
const prReviewDecoder =
  (params: PrReviewParams): RequestDecoder =>
  (event) =>
    Match.value(event).pipe(
      Match.tag("webhook", (w) =>
        w.event === "pull_request" ? prReviewRequest(w.action, w.payload, params) : Option.none(),
      ),
      Match.orElse(() => Option.none()),
    );

/**
 * `improve-pr` on its schedule: one execution for the entry's dimension, whose pull request targets the branch the
 * tick pinned the execution to (FD-AGT-060, FD-INT-052).
 */
const improvePrDecoder =
  (params: ImprovePrParams): RequestDecoder =>
  (event) =>
    Match.value(event).pipe(
      Match.tag("cron", (c) => Option.some(improvePrRequest(params, c.branch))),
      Match.orElse(() => Option.none()),
    );

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

/**
 * Each manifest key's parameters and request decoder: the gate recipes' (specs/runs/gate.md § Recipes) and the
 * agentic recipes' that intake starts from the manifest (specs/runs/agentic.md § Recipes).
 */
const MANIFEST_RECIPES: Readonly<Record<string, ManifestRecipe>> = {
  check: gateRecipe(CheckParams, checkDecoder),
  oxlint: gateRecipe(OxlintEntrySchema, (p, view) => oxlintDecoder(p, view.skipAuthors)),
  offloadTest: gateRecipe(MatrixEntrySchema, (p, view) => offloadTestDecoder(p, view.skipAuthors)),
  workerDeploy: gateRecipe(WorkerDeployEntrySchema, (p, view) =>
    workerDeployDecoder(labelled(p, view.label)),
  ),
  deploySmoke: gateRecipe(DeploySmokeEntrySchema, (p) => deploymentStatusDecoder(p)),
  sandboxImage: gateRecipe(SandboxImageEntrySchema, (p) => sandboxImageDecoder(p)),
  "pr-review": recipe(PrReviewParams, prReviewDecoder),
  "improve-pr": recipe(ImprovePrParams, improvePrDecoder),
};

const manifestRecipeOf = (entry: CatalogEntry): ManifestRecipe | undefined =>
  entry.manifestKey !== null && Object.hasOwn(MANIFEST_RECIPES, entry.manifestKey)
    ? MANIFEST_RECIPES[entry.manifestKey]
    : undefined;

/** A run's request decoder: its manifest key's decoder, bound to the entry's parameters. */
export const requestDecoderOf =
  (entry: CatalogEntry) =>
  (event: DispatchEvent, view: EntryView, context: TriggerContext): Option.Option<unknown> => {
    const found = manifestRecipeOf(entry);
    if (found === undefined) return Option.none();
    return Option.flatMap(found.decoder(view.params, view), (decode) => decode(event, context));
  };

/**
 * The serial group of a request to a run that declares `serialize`: a `worker-deploy` request joins its repository,
 * branch and label's group (FD-GATE-063); an input that does not decode joins none.
 */
const serialKeyOf = (entry: CatalogEntry): Pick<IntakeRun, "serialKey"> =>
  entry.spec.serialize === true && entry.spec.name === "worker-deploy"
    ? {
        serialKey: (inputs) =>
          Option.match(Schema.decodeUnknownOption(WorkerDeployInput)(inputs), {
            onNone: () => null,
            onSome: (i) => workerDeploySerialGroup(i.scope, i.branch, i.entry.label),
          }),
      }
    : {};

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
        ...serialKeyOf(entry),
      })),
      Match.orElse(() => undefined),
    );
