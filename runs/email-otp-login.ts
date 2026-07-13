// Run: email-otp-login — provision a user through an OTP / magic-link flow.
//
// The worked example of the `mailbox` capability: a test/demo run signs up (or
// logs in) a FRESH user against an OTP-based auth API the way Auth0 / Clerk /
// Stytch / Supabase / your own app does it — with NO seeded fixture user and no
// shared mailbox.
//
//   1. provision a disposable inbox  (provisionInbox → mailbox.allocate)
//   2. POST the address to the auth API's "start" endpoint                (curl)
//   3. hibernate until the verification email lands       (waitForOtp → step.waitForEvent)
//   4. POST the extracted code (or GET the magic link) to "verify"        (curl)
//   5. assert the verify call succeeded → green / red check
//
// The email round-trips through the deploy's Cloudflare Email Routing catch-all
// into the `email()` handler, which signals this paused run. This is the
// API-level driver (no browser); the recipe README shows the browser/Playwright
// variant that drives a real login FORM and reads the code back via the
// container-side `/v1/mailbox/...` route.
//
// Mode: Action — dispatched by recipes/email-otp-login/ci.yml (manual /
//       scheduled / on a deploy). See specs/04-gha-integration.md § Action mode.
// DSL:  provisionInbox + waitForOtp (primitives) + sandbox.exec + io.log.

import { Effect, Schema } from "effect";
import { AcceptanceFailed, defineRun, io, sandbox, step } from "@fractalboxdev/flare-dispatch-core";
import { provisionInbox, waitForOtp } from "@fractalboxdev/flare-dispatch-core/primitives";

/** Substitute `{{email}}` / `{{code}}` placeholders in a JSON body template. */
export const fillTemplate = (
  template: string,
  vars: Readonly<Record<string, string>>,
): string => template.replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k] ?? "");

const Provider = Schema.Literal("generic", "auth0", "clerk", "stytch", "supabase");

const EmailOtpLoginInput = Schema.Struct({
  /** Auth API origin, e.g. `https://app.example.com`. Empty string → the run
   * is a logged no-op (`skipped`), the same opt-out shape product-demo uses. */
  baseURL: Schema.String,
  /** POST endpoint that begins the OTP flow (sends the email). */
  startPath: Schema.optionalWith(Schema.String, { default: () => "/api/auth/otp/start" }),
  /** JSON body for the start call; `{{email}}` is the provisioned address. */
  startBody: Schema.optionalWith(Schema.String, {
    default: () => `{"email":"{{email}}"}`,
  }),
  /** POST endpoint that verifies the code. */
  verifyPath: Schema.optionalWith(Schema.String, { default: () => "/api/auth/otp/verify" }),
  /** JSON body for the verify call; `{{email}}` + `{{code}}` are substituted. */
  verifyBody: Schema.optionalWith(Schema.String, {
    default: () => `{"email":"{{email}}","code":"{{code}}"}`,
  }),
  /** Provider label — documentary; tunes nothing today beyond the summary. */
  provider: Schema.optionalWith(Provider, { default: () => "generic" as const }),
  /** Override the OTP-code regex (first capture group). */
  codePattern: Schema.optional(Schema.String),
  /** Prefer magic links whose host matches this provider auth domain. */
  linkHost: Schema.optional(Schema.String),
  /** Expected HTTP status from a successful verify (default 200). */
  expectStatus: Schema.optionalWith(Schema.Number, { default: () => 200 }),
  /** Max seconds to wait for the verification email (default 120). */
  waitSeconds: Schema.optionalWith(Schema.Number, { default: () => 120 }),
});

const EmailOtpLoginOutput = Schema.Struct({
  /** The disposable address provisioned for this run (empty when skipped). */
  provisionedAddress: Schema.String,
  /** Did the verify call succeed? */
  loggedIn: Schema.Boolean,
  /** How the run authenticated: a numeric code, a magic link, or skipped. */
  mode: Schema.Literal("code", "link", "skipped"),
  /** Verify call's HTTP status (0 when skipped / never reached). */
  status: Schema.Number,
});

/** Run a single curl, returning `{ status, ok }` — mirrors probeHttp's classify. */
const curl = (args: readonly string[]) =>
  Effect.gen(function* () {
    const r = yield* sandbox.exec({
      command: ["curl", "-sS", "-o", "/dev/null", "-w", "%{http_code}", ...args],
    });
    const status = Number(r.stdout.trim());
    return { status, ok: r.exitCode === 0 && status >= 200 && status < 400 };
  });

export const emailOtpLogin = defineRun({
  name: "email-otp-login",
  version: "1.0.0",
  inputs: EmailOtpLoginInput,
  outputs: EmailOtpLoginOutput,
  limits: { maxDurationSec: 300 },

  run: (input) =>
    Effect.gen(function* () {
      // Opt-out: an empty baseURL is a logged no-op (the recipe leaves it unset
      // until the operator points it at a real auth API).
      if (input.baseURL.trim().length === 0) {
        yield* io.log("info", "email-otp-login: no baseURL configured — skipping");
        return {
          provisionedAddress: "",
          loggedIn: false,
          mode: "skipped" as const,
          status: 0,
        };
      }

      const base = input.baseURL.replace(/\/$/, "");
      const inbox = yield* provisionInbox();
      yield* io.log("info", `email-otp-login: provisioned ${inbox.address}`);

      // 1. Begin the OTP flow — POST the disposable address.
      const start = yield* step("otp-start", () =>
        curl([
          "-X", "POST",
          "-H", "content-type: application/json",
          "-d", fillTemplate(input.startBody, { email: inbox.address }),
          `${base}${input.startPath}`,
        ]),
      );
      if (!start.ok) {
        return yield* Effect.fail(
          new AcceptanceFailed({
            exitCode: 1,
            summaryMd:
              `**email-otp-login** could not start the OTP flow — ` +
              `\`POST ${input.startPath}\` returned **${start.status}**.`,
          }),
        );
      }

      // 2. Hibernate until the verification email arrives, then extract.
      const otp = yield* waitForOtp({
        inbox,
        timeout: `${input.waitSeconds} seconds`,
        ...(input.codePattern !== undefined
          ? { codePattern: new RegExp(input.codePattern) }
          : {}),
        ...(input.linkHost !== undefined ? { linkHost: input.linkHost } : {}),
      });

      // 3. Verify — type the code, or follow the magic link.
      if (otp.code !== undefined) {
        const verify = yield* step("otp-verify", () =>
          curl([
            "-X", "POST",
            "-H", "content-type: application/json",
            "-d", fillTemplate(input.verifyBody, { email: inbox.address, code: otp.code! }),
            `${base}${input.verifyPath}`,
          ]),
        );
        const loggedIn = verify.status === input.expectStatus;
        yield* io.log(
          loggedIn ? "info" : "error",
          `email-otp-login: code verify → ${verify.status} (expected ${input.expectStatus})`,
        );
        if (!loggedIn) {
          return yield* Effect.fail(
            new AcceptanceFailed({
              exitCode: 1,
              summaryMd:
                `**email-otp-login** signed up \`${inbox.address}\` and received code ` +
                `\`${otp.code}\`, but \`POST ${input.verifyPath}\` returned ` +
                `**${verify.status}** (expected ${input.expectStatus}).`,
            }),
          );
        }
        return {
          provisionedAddress: inbox.address,
          loggedIn: true,
          mode: "code" as const,
          status: verify.status,
        };
      }

      if (otp.link !== undefined) {
        const follow = yield* step("otp-magic-link", () => curl([otp.link!]));
        yield* io.log(
          follow.ok ? "info" : "error",
          `email-otp-login: magic link → ${follow.status}`,
        );
        if (!follow.ok) {
          return yield* Effect.fail(
            new AcceptanceFailed({
              exitCode: 1,
              summaryMd:
                `**email-otp-login** received a magic link for \`${inbox.address}\` ` +
                `but following it returned **${follow.status}**.`,
            }),
          );
        }
        return {
          provisionedAddress: inbox.address,
          loggedIn: true,
          mode: "link" as const,
          status: follow.status,
        };
      }

      // The email arrived but carried neither a recognisable code nor link.
      return yield* Effect.fail(
        new AcceptanceFailed({
          exitCode: 1,
          summaryMd:
            `**email-otp-login** received the verification email for ` +
            `\`${inbox.address}\` but could not extract an OTP code or magic link ` +
            `from it. Tune \`codePattern\` / \`linkHost\` for the **${input.provider}** provider.`,
        }),
      );
    }),
});
