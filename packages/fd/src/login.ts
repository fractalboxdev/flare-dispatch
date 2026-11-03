// `fd login`: the developer signs in to Cloudflare Access in the browser, and `fd` stores the Access token it obtains in
// the operating system's credential store (FD-IFC-067). `cloudflared access login` runs the browser flow and
// `cloudflared access token` prints the token, which `fd` reads from the pipe and never echoes.
import { spawn } from "node:child_process";
import { Context, Effect, Layer, Schema } from "effect";

export class LoginFailed extends Schema.TaggedError<LoginFailed>()("LoginFailed", {
  message: Schema.String,
}) {}

export class BrowserLogin extends Context.Service<
  BrowserLogin,
  { readonly token: (origin: string) => Effect.Effect<string, LoginFailed> }
>()("@fractalboxdev/flare-dispatch-fd/BrowserLogin") {}

const run = (args: readonly string[], inheritStderr: boolean) =>
  Effect.tryPromise({
    try: () =>
      new Promise<{ readonly code: number | null; readonly stdout: string }>((resolve, reject) => {
        const child = spawn("cloudflared", args, {
          stdio: ["ignore", "pipe", inheritStderr ? "inherit" : "ignore"],
        });
        let stdout = "";
        child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, stdout }));
      }),
    catch: (e) => new LoginFailed({ message: `cloudflared could not run: ${String(e)}` }),
  });

export const CloudflaredLogin = Layer.succeed(BrowserLogin)({
  token: (origin) =>
    Effect.gen(function* () {
      const login = yield* run(["access", "login", "--quiet", origin], true);
      if (login.code !== 0)
        return yield* new LoginFailed({ message: "the Access login did not finish" });
      const token = yield* run(["access", "token", `-app=${origin}`], false);
      const jwt = token.stdout.trim();
      if (token.code !== 0 || jwt.split(".").length !== 3)
        return yield* new LoginFailed({ message: "cloudflared answered no Access token" });
      return jwt;
    }),
});
