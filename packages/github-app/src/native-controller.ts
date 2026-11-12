import { GithubApiError } from "./errors";
import { resolveClient } from "./http";
import { readNativeJson } from "./native-json";

type Options = {
  readonly appId: string; readonly appJwt: string;
  readonly apiBase?: string; readonly fetchImpl?: typeof fetch;
};

/** Configured App IDs use the same canonical decimal admission before local or authenticated lookup. */
export const parseNativeControllerAppId = (raw: unknown): number => {
  if (typeof raw !== "string")
    throw new GithubApiError("native controller authentication configuration is invalid", 0, "");
  const appId = Number(raw);
  if (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(appId))
    throw new GithubApiError("native controller authentication configuration is invalid", 0, "");
  return appId;
};

/** The authenticated App supplies the trusted actor; workload evidence supplies no controller identity. */
export const readNativeControllerIdentity = async (opts: Options): Promise<{
  readonly appId: number; readonly actorLogin: string;
}> => {
  const refuse = (message: string, status = 0) => new GithubApiError(message, status, "");
  const appId = parseNativeControllerAppId(opts.appId);
  if (opts.appJwt.length === 0)
    throw refuse("native controller authentication configuration is invalid");
  const { apiBase } = resolveClient(opts);
  const { body } = await readNativeJson({ ...opts, token: opts.appJwt }, `${apiBase}/app`, 65_536);
  if (typeof body !== "object" || body === null || !("id" in body) || !("slug" in body)
    || body.id !== appId || typeof body.slug !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(body.slug))
    throw refuse("native controller authenticated identity does not match configured App");
  return { appId, actorLogin: `${body.slug}[bot]` };
};
