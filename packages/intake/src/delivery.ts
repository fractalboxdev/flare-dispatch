// The catalogue's `WebhookDelivery` read off a signed webhook, so each recipe's request decoder (MAMEKO-RUN-010)
// takes the event intake received (specs/run-model.md § Triggers). A payload that lacks a field its event's delivery
// needs, or names a malformed commit, is no delivery: no recipe answers it.
import {
  DispatchEvent as CatalogEvent,
  WebhookDelivery,
} from "@fractalboxdev/flare-dispatch-catalog";
import { Match, Option, Schema } from "effect";
import type { DispatchEvent } from "./event.ts";

/** What a request decoder reads of the repository beside the event: the default branch intake read for it. */
export interface TriggerContext {
  readonly defaultBranch: string;
}

const Repository = Schema.Struct({
  full_name: Schema.String,
  clone_url: Schema.optionalKey(Schema.String),
});

const PullRequestPayload = Schema.Struct({
  repository: Repository,
  pull_request: Schema.Struct({
    number: Schema.Number,
    draft: Schema.optionalKey(Schema.Boolean),
    user: Schema.optionalKey(Schema.NullOr(Schema.Struct({ login: Schema.String }))),
    head: Schema.Struct({ sha: Schema.String, ref: Schema.String }),
    base: Schema.Struct({ sha: Schema.String, ref: Schema.String }),
  }),
});

const PushPayload = Schema.Struct({
  repository: Repository,
  ref: Schema.String,
  before: Schema.optionalKey(Schema.String),
  after: Schema.String,
});

const MergeGroupPayload = Schema.Struct({
  repository: Repository,
  merge_group: Schema.Struct({
    head_sha: Schema.String,
    head_ref: Schema.String,
    base_ref: Schema.String,
  }),
});

const DeploymentStatusPayload = Schema.Struct({
  repository: Repository,
  deployment: Schema.Struct({
    sha: Schema.String,
    ref: Schema.String,
    environment: Schema.optionalKey(Schema.String),
  }),
  deployment_status: Schema.Struct({
    state: Schema.String,
    environment: Schema.optionalKey(Schema.String),
    environment_url: Schema.optionalKey(Schema.NullOr(Schema.String)),
  }),
});

const repositoryOf = (r: typeof Repository.Type, context: TriggerContext) => ({
  fullName: r.full_name,
  cloneUrl: r.clone_url ?? `https://github.com/${r.full_name}.git`,
  defaultBranch: context.defaultBranch,
});

/** The raw delivery of one event, before the catalogue's schema checks it. */
const rawDelivery = (
  event: string,
  action: string,
  payload: unknown,
  context: TriggerContext,
): Option.Option<unknown> =>
  Match.value(event).pipe(
    Match.when("pull_request", () =>
      Option.map(Schema.decodeUnknownOption(PullRequestPayload)(payload), (p) => ({
        event,
        action,
        repository: repositoryOf(p.repository, context),
        pullRequest: {
          number: p.pull_request.number,
          draft: p.pull_request.draft ?? false,
          author: p.pull_request.user?.login ?? "",
          headSha: p.pull_request.head.sha,
          headRef: p.pull_request.head.ref,
          baseRef: p.pull_request.base.ref,
          baseSha: p.pull_request.base.sha,
        },
      })),
    ),
    Match.when("push", () =>
      Option.map(Schema.decodeUnknownOption(PushPayload)(payload), (p) => ({
        event,
        action: "",
        repository: repositoryOf(p.repository, context),
        ref: p.ref,
        before: p.before ?? "",
        after: p.after,
      })),
    ),
    Match.when("merge_group", () =>
      Option.map(Schema.decodeUnknownOption(MergeGroupPayload)(payload), (p) => ({
        event,
        action,
        repository: repositoryOf(p.repository, context),
        headSha: p.merge_group.head_sha,
        headRef: p.merge_group.head_ref,
        baseRef: p.merge_group.base_ref,
      })),
    ),
    Match.when("deployment_status", () =>
      Option.flatMap(Schema.decodeUnknownOption(DeploymentStatusPayload)(payload), (p) => {
        const environment = p.deployment_status.environment ?? p.deployment.environment;
        if (environment === undefined) return Option.none();
        const url = p.deployment_status.environment_url;
        return Option.some({
          event,
          action,
          repository: repositoryOf(p.repository, context),
          state: p.deployment_status.state,
          environment,
          ...(url === undefined || url === null || url === "" ? {} : { environmentUrl: url }),
          sha: p.deployment.sha,
          ref: p.deployment.ref,
        });
      }),
    ),
    Match.orElse(() => Option.none()),
  );

/** A webhook's `WebhookDelivery`, or none for an event no recipe decodes or a payload that does not decode. */
export const deliveryOf = (
  event: string,
  action: string | null,
  payload: unknown,
  context: TriggerContext,
): Option.Option<WebhookDelivery> =>
  Option.flatMap(rawDelivery(event, action ?? "", payload, context), (raw) =>
    Schema.decodeUnknownOption(WebhookDelivery)(raw),
  );

/** The catalogue's `DispatchEvent` for a webhook intake received; none for every other trigger kind. */
export const catalogEventOf = (
  event: DispatchEvent,
  context: TriggerContext,
): Option.Option<CatalogEvent> =>
  Match.value(event).pipe(
    Match.tag("webhook", (w) =>
      Option.map(deliveryOf(w.event, w.action, w.payload, context), (delivery): CatalogEvent => ({
        _tag: "webhook",
        deliveryId: w.deliveryId,
        delivery,
      })),
    ),
    Match.orElse(() => Option.none()),
  );
