import { Effect, Redacted, Schema } from "effect";
import { NativeApiEvidence, NativeControllerLogin, NativeReceiptRefused, NativeRequest,
  NativeRunCreatedAt } from "@fractalboxdev/flare-dispatch-core";
import { readNativeControllerIdentity, readNativeJson } from "@fractalboxdev/flare-dispatch-github-app";

const PositiveId = NativeApiEvidence.fields.runId;
const Permission = Schema.Literal("read","write");
const Installation = Schema.Struct({ id:PositiveId, app_id:PositiveId,
  account:Schema.Struct({login:Schema.String}), suspended_at:Schema.Null,
  permissions:Schema.Struct({actions:Schema.Literal("write")}) });
const Grant = Schema.Struct({ token:Schema.String.pipe(Schema.pattern(/^[\x21-\x7e]+$/)),
  expires_at:NativeRunCreatedAt, repository_selection:Schema.Literal("selected"),
  repositories:Schema.Array(Schema.Struct({name:Schema.String,full_name:NativeRequest.fields.repo})),
  permissions:Schema.Record({key:Schema.String,value:Permission}) });
const Now = Schema.Number.pipe(Schema.filter((n)=>Number.isSafeInteger(n) && n>0
  && Number.isFinite(new Date(n*1000).getTime())));
const refusal = () => new NativeReceiptRefused({reason:"native GitHub credential scope or metadata refused"});
type Options = {readonly appId:string;readonly appJwt:string;readonly repo:string;
  readonly apiBase?:string;readonly fetchImpl?:typeof fetch};

/** Each invocation authenticates its configured App and returns only an ephemeral narrowed grant. */
export const readNativeGithubContext = (options:Options, now:number) => Effect.gen(function* () {
  yield* Schema.decodeUnknown(Now)(now).pipe(Effect.mapError(refusal));
  const repo=yield* Schema.decodeUnknown(NativeRequest.fields.repo)(options.repo).pipe(Effect.mapError(refusal));
  const controller=yield* Effect.tryPromise({try:()=>readNativeControllerIdentity(options),catch:refusal});
  yield* Schema.decodeUnknown(NativeControllerLogin)(controller.actorLogin).pipe(Effect.mapError(refusal));
  const [owner,name]=repo.split("/");
  const client={token:options.appJwt,apiBase:options.apiBase,fetchImpl:options.fetchImpl};
  const installationRaw=yield* Effect.tryPromise({try:()=>readNativeJson(client,
    `/repos/${owner}/${name}/installation`,64*1024),catch:refusal});
  const installation=yield* Schema.decodeUnknown(Installation)(installationRaw.body).pipe(Effect.mapError(refusal));
  if (installation.app_id !== controller.appId || installation.account.login !== owner)
    return yield* Effect.fail(refusal());
  const grantRaw=yield* Effect.tryPromise({try:()=>readNativeJson(client,
    `/app/installations/${installation.id}/access_tokens`,64*1024,{method:"POST",status:201,
      body:JSON.stringify({repositories:[name],permissions:{actions:"write",metadata:"read"}})}),catch:refusal});
  const grant=yield* Schema.decodeUnknown(Grant)(grantRaw.body).pipe(Effect.mapError(refusal));
  const expiresAt=Date.parse(grant.expires_at)/1000;
  if (grant.repositories.length !== 1 || grant.repositories[0]?.full_name !== repo
    || grant.repositories[0]?.name !== name || expiresAt <= now
    || grant.permissions.actions !== "write"
    || Object.entries(grant.permissions).some(([key,value])=>key !== "actions" && !(key === "metadata" && value === "read")))
    return yield* Effect.fail(refusal());
  return {controller,installationId:installation.id,repo,expiresAt,token:Redacted.make(grant.token)};
});
