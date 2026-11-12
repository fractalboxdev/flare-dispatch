// A non-expiring external-write slot. Outbox claim expiry never proves that an HTTP mutation has stopped.
import type { D1Like } from "@fractalboxdev/mameko-host-cloudflare/d1";
import { Effect, Schema } from "effect";
import { GithubNetworkError } from "./client.ts";

const Write = Schema.Struct({ token: Schema.NonEmptyString, receipt: Schema.NonEmptyString });
export type CommentWrite = typeof Write.Type;
export interface CommentWriteStore {
  readonly read: (resource: string) => Effect.Effect<CommentWrite | null, GithubNetworkError>;
  readonly claim: (
    resource: string,
    write: CommentWrite,
  ) => Effect.Effect<boolean, GithubNetworkError>;
  readonly release: (resource: string, token: string) => Effect.Effect<void, GithubNetworkError>;
}

/** All marked comments of one PR share a slot: different public markers may select the same GitHub object. */
export const commentWriteResource = (repo: string, issue: number) =>
  JSON.stringify([repo.toLowerCase(), issue]);
export const commentWriteReceipt = (token: string, intent: string) =>
  `<!-- flare-dispatch:comment-write ${token} -->\n\n${intent}`;

/**
 * A sending slot has no TTL. Only its owner before sending, a settled successful response, or an authoritative read
 * of its unique attempt footer may release it. An uncertain send whose footer is absent blocks newer writes; no
 * finite lease or a missing marker can prove that the old HTTP request will never arrive.
 */
export const d1CommentWrites = (db: D1Like): CommentWriteStore => {
  let ready: Promise<unknown> | undefined;
  const run = <A>(f: () => Promise<A>) =>
    Effect.tryPromise({
      try: async () => {
        await (ready ??= db
          .prepare(`create table if not exists fd_comment_writes (
        resource text primary key, token text not null, receipt text not null
      )`)
          .run()
          .catch((e: unknown) => {
            ready = undefined;
            throw e;
          }));
        return f();
      },
      catch: () =>
        new GithubNetworkError({ sent: false, message: "comment write ownership unavailable" }),
    });
  return {
    read: (resource) =>
      run(async () => {
        const { results } = await db
          .prepare("select token, receipt from fd_comment_writes where resource = ?")
          .bind(resource)
          .all();
        return results.length === 0 ? null : Schema.decodeUnknownSync(Write)(results[0]);
      }),
    claim: (resource, write) =>
      run(async () => {
        const { results } = await db
          .prepare(`insert into fd_comment_writes (resource, token, receipt) values (?, ?, ?)
        on conflict(resource) do nothing returning token`)
          .bind(resource, write.token, write.receipt)
          .all();
        return results.length === 1;
      }),
    release: (resource, token) =>
      run(async () => {
        await db
          .prepare("delete from fd_comment_writes where resource = ? and token = ?")
          .bind(resource, token)
          .run();
      }),
  };
};
