import { Effect } from "effect";
import { NativeReceiptRefused, admitNativeRequest } from "@fractalboxdev/flare-dispatch-core";
import { nativeWorkflowId } from "../native-workflow-policy";
import { readNativeControllerIdentity, signAppJwt } from "@fractalboxdev/flare-dispatch-github-app";
import type { Env } from "../env";

/** Local bindings execute the production class; this fixture exposes only its admitted instance-ID owner. */
export { NativeWorkflow } from "../native-workflow";
export default { fetch: async (request: Request, env: Env) => {
  if(new URL(request.url).pathname === "/fixture/default-context") {
    return Effect.runPromise(Effect.tryPromise({try:async()=>{
      const appId=env.GITHUB_APP_ID!;
      const appJwt=await signAppJwt({appId,privateKeyPem:env.GITHUB_APP_PRIVATE_KEY!});
      return Response.json(await readNativeControllerIdentity({appId,appJwt}));
    },catch:()=>new NativeReceiptRefused({reason:"fixture default context refused"})}).pipe(
      Effect.catchTag("NativeReceiptRefused",()=>Effect.succeed(new Response(null,{status:503}))),
    ));
  }
  if(new URL(request.url).pathname === "/fixture/direct-fetch") return fetch("https://api.github.com/app");
  const admitted = await Effect.runPromise(admitNativeRequest(await request.json()));
  return new Response(await nativeWorkflowId(admitted));
} };
