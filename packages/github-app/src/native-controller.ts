import { GithubApiError } from "./errors";
import { resolveClient } from "./http";
import { readNativeJson } from "./native-json";

type Options = {
  readonly appId: string; readonly appJwt: string;
  readonly apiBase?: string; readonly fetchImpl?: typeof fetch;
};

/** The authenticated App supplies the trusted actor; workload evidence supplies no controller identity. */
export const readNativeControllerIdentity = async (opts: Options): Promise<{
  readonly appId: number; readonly actorLogin: string;
}> => {
  const refuse = (message: string, status = 0) => new GithubApiError(message, status, "");
  const appId = Number(opts.appId);
  if (!/^[1-9][0-9]*$/.test(opts.appId) || !Number.isSafeInteger(appId) || opts.appJwt.length === 0)
    throw refuse("native controller authentication configuration is invalid");
  const { apiBase } = resolveClient(opts);
  const { body } = await readNativeJson({ ...opts, token: opts.appJwt }, `${apiBase}/app`, 65_536);
  if (typeof body !== "object" || body === null || !("id" in body) || !("slug" in body)
    || body.id !== appId || typeof body.slug !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(body.slug))
    throw refuse("native controller authenticated identity does not match configured App");
  return { appId, actorLogin: `${body.slug}[bot]` };
};
