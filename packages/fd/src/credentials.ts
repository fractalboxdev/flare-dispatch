// The Access token lives only in the operating system's credential store: the macOS keychain through `security`, or the
// Secret Service through `secret-tool` (FD-IFC-067). The token travels on stdin, never in an argument a process listing
// shows, and `fd` never writes it to a file or prints it.
import { spawn } from "node:child_process";
import { Context, Effect, Layer, Schema } from "effect";
import { controlPlaneUrl, type FdConfig } from "./config.ts";
import { EXIT, FdFailure } from "./outcome.ts";

export const SERVICE = "flare-dispatch";

export class CredentialStoreFailed extends Schema.TaggedError<CredentialStoreFailed>()(
  "CredentialStoreFailed",
  { message: Schema.String },
) {}

export class CredentialStore extends Context.Service<
  CredentialStore,
  {
    /** The secret stored for an account, or `undefined` when none is. */
    readonly get: (account: string) => Effect.Effect<string | undefined, CredentialStoreFailed>;
    readonly put: (account: string, secret: string) => Effect.Effect<void, CredentialStoreFailed>;
  }
>()("@fractalboxdev/flare-dispatch-fd/CredentialStore") {}

interface Ran {
  readonly code: number | null;
  readonly stdout: string;
}

const run = (command: string, args: readonly string[], stdin: string): Promise<Ran> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "ignore"] });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout }));
    child.stdin.end(stdin);
  });

const attempt = (what: string, thunk: () => Promise<Ran>) =>
  Effect.tryPromise({
    try: thunk,
    catch: (e) => new CredentialStoreFailed({ message: `${what}: ${String(e)}` }),
  });

/** The macOS keychain; `security -i` reads the add command from stdin. */
const keychain = CredentialStore.of({
  get: (account) =>
    attempt("security", () =>
      run("security", ["find-generic-password", "-a", account, "-s", SERVICE, "-w"], ""),
    ).pipe(Effect.map((r) => (r.code === 0 ? r.stdout.trim() || undefined : undefined))),
  put: (account, secret) =>
    attempt("security", () =>
      run(
        "security",
        ["-i"],
        `add-generic-password -U -a ${JSON.stringify(account)} -s ${SERVICE} -w ${JSON.stringify(secret)}\n`,
      ),
    ).pipe(
      Effect.flatMap((r) =>
        r.code === 0
          ? Effect.void
          : Effect.fail(new CredentialStoreFailed({ message: "the keychain refused the token" })),
      ),
    ),
});

/** The Secret Service; `secret-tool store` reads the secret from stdin. */
const secretService = CredentialStore.of({
  get: (account) =>
    attempt("secret-tool", () =>
      run("secret-tool", ["lookup", "service", SERVICE, "account", account], ""),
    ).pipe(Effect.map((r) => (r.code === 0 ? r.stdout.trim() || undefined : undefined))),
  put: (account, secret) =>
    attempt("secret-tool", () =>
      run(
        "secret-tool",
        ["store", `--label=${SERVICE} ${account}`, "service", SERVICE, "account", account],
        secret,
      ),
    ).pipe(
      Effect.flatMap((r) =>
        r.code === 0
          ? Effect.void
          : Effect.fail(
              new CredentialStoreFailed({ message: "the Secret Service refused the token" }),
            ),
      ),
    ),
});

const unsupported = (platform: string) => {
  const failure = Effect.fail(
    new CredentialStoreFailed({ message: `no operating-system credential store on ${platform}` }),
  );
  return CredentialStore.of({ get: () => failure, put: () => failure });
};

export const CredentialStoreLive = Layer.sync(CredentialStore, () =>
  process.platform === "darwin"
    ? keychain
    : process.platform === "linux"
      ? secretService
      : unsupported(process.platform),
);

/** The `exp` claim of a JWT, in seconds; `undefined` for a token that is not a JWT. */
export const tokenExpiry = (jwt: string): number | undefined => {
  const payload = jwt.split(".")[1];
  if (payload === undefined) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      exp?: unknown;
    };
    return typeof claims.exp === "number" ? claims.exp : undefined;
  } catch {
    return undefined;
  }
};

const noToken = (why: string) =>
  new FdFailure({
    code: "unauthenticated",
    message: `${why}; run fd login`,
    exitCode: EXIT.noVerdict,
  });

/** The stored, unexpired Access token for the control plane, or exit 5 naming `fd login` (FD-IFC-068). */
export const accessToken: Effect.Effect<string, FdFailure, CredentialStore | FdConfig> = Effect.gen(
  function* () {
    const url = yield* controlPlaneUrl;
    const store = yield* CredentialStore;
    const token = yield* store
      .get(url)
      .pipe(
        Effect.mapError((e) => noToken(`the credential store could not be read (${e.message})`)),
      );
    if (token === undefined) return yield* noToken("no Access token is stored");
    const exp = tokenExpiry(token);
    if (exp === undefined || exp <= Math.floor(Date.now() / 1000))
      return yield* noToken("the stored Access token has expired");
    return token;
  },
);
