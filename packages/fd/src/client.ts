// The HTTP API client `fd` and the dispatch action use: derived from the one declaration (FD-IFC-002), so each call is
// encoded and decoded by the route's own schemas. A route's error decodes to its error-model class.
import { FlareDispatchApi } from "@fractalboxdev/flare-dispatch-api/declaration";
import { isApiError } from "@fractalboxdev/flare-dispatch-api/errors";
import { Context, Effect, Layer } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { routeFailure, transportFailure, type FdFailure } from "./outcome.ts";

export type ApiClient = HttpApiClient.ForApi<typeof FlareDispatchApi>;

/** How a request proves its identity: an Access token, or an Actions OIDC token as a bearer. */
export type Credential =
  | { readonly _tag: "Access"; readonly token: string }
  | { readonly _tag: "Bearer"; readonly token: string };

const withCredential = (credential: Credential) => (request: HttpClientRequest.HttpClientRequest) =>
  credential._tag === "Access"
    ? HttpClientRequest.setHeader(request, "cf-access-token", credential.token)
    : HttpClientRequest.bearerToken(request, credential.token);

/** A client for one control plane and one credential. `fetch` is the platform's unless a test supplies its own. */
export const makeClient = (
  origin: string,
  credential: Credential,
  fetch?: typeof globalThis.fetch,
): Effect.Effect<ApiClient> =>
  HttpApiClient.make(FlareDispatchApi, {
    baseUrl: origin,
    transformClient: HttpClient.mapRequest(withCredential(credential)),
  }).pipe(
    Effect.provide(
      fetch === undefined
        ? FetchHttpClient.layer
        : FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch)(fetch))),
    ),
  );

/** Any client error as a command failure: a route's error by its code, anything else as transport. */
export const toFailure = (error: unknown): FdFailure =>
  isApiError(error)
    ? routeFailure(error)
    : transportFailure(
        typeof error === "object" && error !== null && "message" in error
          ? String((error as { message: unknown }).message)
          : String(error),
      );

/** Runs one client call, its errors as command failures. */
export const call = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, FdFailure, R> =>
  Effect.mapError(effect, toFailure);

/** The `fetch` the client sends with; a test replaces it with the router in process. */
export const FdFetch = Context.Reference<typeof globalThis.fetch>(
  "@fractalboxdev/flare-dispatch-fd/FdFetch",
  {
    defaultValue: () => globalThis.fetch,
  },
);
