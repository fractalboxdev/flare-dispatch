// Run: self-heal-pr — synthesize → agent → verify → writeback.
//
// The fix stage after `ci-triage-pr`'s diagnosis (specs/08-self-healing.md). Given
// an `incident/v1` pack, it runs the `flare-agent` coding agent in the agent-tier
// sandbox, VERIFIES the fix by re-running the repro in that same credential-free
// sandbox, and — only when the repro goes green — opens a draft PR through the
// writeback gate. An unverified/no-fix attempt is SILENT by default (no PR), per
// § 8: an evidence-only PR for a fix we couldn't verify is triage burden, not signal.
//
// CREDENTIAL-FREE (§ 6.1, § 6.3, § 10): the agent never holds the GitHub App key
// (the Worker opens the PR via writeback) nor a model key (it reaches the model
// only through the Worker model-proxy, with a per-execution capability token the
// Worker injects). The agent is untrusted code; verification happens in the
// egress-restricted sandbox, NOT in the consumer's secret-bearing CI.
//
// V0 scope: the CI class with a strong (command) repro. Application-class +
// derived-repro is V1 (experimental). Synthesis here is first-party/passthrough —
// the dispatched `incident` pack is used as-is.
//
// Mode: Action-mode dispatchable (`POST /v1/dispatch/self-heal-pr`) — a consumer
// (or `ci-triage-pr`'s escalation) dispatches it with an incident pack.

import { Effect, Schema } from "effect";
import {
  artifact,
  config,
  defineRun,
  Incident,
  io,
  sandbox,
  SignalArray,
  StepFailed,
  step,
  WRITEBACK_ARTIFACT,
} from "@fractalbox/flare-dispatch-core";
import { workspace } from "@fractalbox/flare-dispatch-core/primitives";

const PACK_PATH = "incident-pack.json";
const RESULT_PATH = "agent-result.json";

const Input = Schema.Struct({
  /** The incident/v1 context pack (synthesized by the caller / triage escalation). */
  incident: Incident,
  /** Optional extra signals folded into the pack (Action-mode parity with ci-triage). */
  signals: Schema.optionalWith(SignalArray, { default: () => [] }),
});

const Output = Schema.Struct({
  incidentId: Schema.String,
  /** The agent's outcome: patched | no-fix | needs-human (or "skipped"). */
  outcome: Schema.String,
  /** Did the repro go green on the patched tree (the gate for opening a PR)? */
  verified: Schema.Boolean,
  changedPaths: Schema.Array(Schema.String),
  /** Whether a writeback was staged (⇒ the Worker opens the draft PR). */
  prStaged: Schema.Boolean,
});

/** Write the incident pack into the container as a file the agent reads. The
 * pack is data (never a secret); passed via env to avoid shell-quoting a JSON. */
const STAGE_PACK_SCRIPT = `set -eu
node -e 'require("fs").writeFileSync(process.env.PACK_PATH, process.env.PACK_JSON)'
echo staged`;

/** Stage the writeback payload from git's working-tree view (same as
 * refresh-fixtures: git status --porcelain → manifest + blobs). */
const STAGE_WRITEBACK_SCRIPT = `
set -eu
out=artifacts/writeback
rm -rf "$out"; mkdir -p "$out/files"
: > "$out/.entries"
git status --porcelain | while IFS= read -r line; do
  status=$(printf '%s' "$line" | cut -c1-2)
  path=$(printf '%s' "$line" | cut -c4-)
  case "$status" in
    *D*) printf '{"path":"%s","deleted":true}\\n' "$path" >> "$out/.entries" ;;
    *)   mkdir -p "$out/files/$(dirname "$path")"
         cp "$path" "$out/files/$path"
         if [ -x "$path" ]; then mode=100755; else mode=100644; fi
         printf '{"path":"%s","mode":"%s"}\\n' "$path" "$mode" >> "$out/.entries" ;;
  esac
done
printf '{"entries":[%s]}\\n' "$(paste -sd, "$out/.entries")" > "$out/manifest.json"
git status --porcelain | cut -c4-
`;

export const selfHealPr = defineRun({
  name: "self-heal-pr",
  version: "1.0.0",
  image: "registry.cloudflare.com/fractalbox/flare-dispatch-agent:latest",
  // Route to the agent-tier image (flare-agent + toolchain, mandatory egress
  // allowlist). specs/08-self-healing.md § 6.2.
  sandboxImage: "agent",

  inputs: Input,
  outputs: Output,

  limits: { maxDurationSec: 1800, maxConcurrency: 4 },

  // Writeback fires Worker-side ONLY on a successful run that staged a manifest.
  // The run stages one only when the fix VERIFIED — so an unverified heal returns
  // success with no manifest ⇒ no PR (the silent default). Per-incident branch.
  writeback: {
    branch: { prefix: "flare-dispatch/self-heal" },
    commitMessage:
      "fix: self-heal proposed fix\n\nGenerated + verified by flare-dispatch self-heal-pr.",
    pr: {
      title: "fix: self-heal proposed fix",
      body: "🤖 Draft opened by `flare-dispatch/self-heal-pr`. An agent reproduced the failure, applied a fix, and the repro is **green in the sandbox**. This is a proposed fix — review before merging; do NOT rely on the PR's own CI as the proof (it runs with secrets on agent-authored code, see specs/08 § 10.1).",
      draft: true,
      labels: ["self-heal", "self-heal:verified"],
    },
    // Agent-authored writeback: scope to source, and KEEP the sensitive-path +
    // workflows gates ON (postinstall/CI RCE vector, § 10.1). Operator can widen
    // `self-heal.path-allowlist` but never disable the sensitive gate for this run.
    pathAllowlist: ["src/**", "lib/**", "app/**", "**/*.test.*"],
    // allowWorkflows / allowSensitivePaths default OFF — never enabled here.
  },

  run: (input) =>
    Effect.gen(function* () {
      const pack = { ...input.incident, signals: [...(input.incident.signals ?? []), ...input.signals] };
      const empty = (outcome: string, verified: boolean) => ({
        incidentId: pack.incidentId,
        outcome,
        verified,
        changedPaths: [] as string[],
        prStaged: false,
      });

      // Self-heal needs a COMMAND repro — the deterministic oracle the verify
      // step re-runs in the credential-free sandbox. The `ci` class supplies the
      // exact failing command; the `demo` class supplies a TEST command (a demo
      // failure is verified by the agent writing a regression test, NOT by
      // re-running the browser demo — the sandbox has no Browser Run, the fix
      // lands in the repo not the deploy, and an LLM re-judging an LLM is
      // circular; spec § 8 + the demo-incident review). Anything without a
      // command repro (generic `application`, or a `demo` with no test command
      // configured) is left to triage — the V1 derived path stays experimental.
      const eligibleClass = pack.class === "ci" || pack.class === "demo";
      if (!eligibleClass || pack.repro?.kind !== "command" || pack.repro.command === undefined) {
        yield* step("log-skip", () =>
          io.log("info", `self-heal-pr: incident ${pack.incidentId} has no command repro (class=${pack.class}) — skipping`),
        );
        return empty("skipped", false);
      }
      const reproCommand = pack.repro.command;

      // The model-proxy URL + per-execution token. The Worker injects the token
      // (it holds the secret + mints it per execution); the run only reads it —
      // it never holds the signing key. specs/08 § 6.3.
      const proxyUrl = yield* step("resolve-proxy", () => config.get("self-heal.proxy-url"));
      const agentToken = yield* step("resolve-token", () => config.get("self-heal.agent-token"));
      if (proxyUrl === undefined || agentToken === undefined) {
        return yield* Effect.fail(
          new StepFailed({ step: "resolve-proxy", cause: "self-heal.proxy-url / self-heal.agent-token not injected" }),
        );
      }

      // Checkout the suspect head (installCached so the repro doesn't pay a cold
      // install). `workspace` returns { container, dir }.
      const { container, dir } = yield* step("checkout", () =>
        workspace({ repo: pack.repo, sha: pack.suspectRef?.head ?? "HEAD", install: true }),
      );

      // Stage the incident pack into the container (data, not a secret).
      yield* step("stage-pack", () =>
        sandbox.exec({
          container,
          cwd: dir,
          command: ["sh", "-lc", STAGE_PACK_SCRIPT],
          env: { PACK_PATH, PACK_JSON: JSON.stringify(pack) },
        }),
      );

      // Run the agent: it reaches the model ONLY via the proxy (no key here).
      // runDetached + waitForExit (NOT a plain exec): a 10–20-min indivisible
      // agent loop that replays from scratch on Worker eviction would re-spawn
      // the agent and double-spend the model budget (specs/08 § 11). The step is
      // I/O-bound awaiting the container, so the long wall-clock itself is fine.
      const agentHandle = yield* step("agent-start", () =>
        sandbox.runDetached({
          container,
          cwd: dir,
          command: ["flare-agent", "heal", "--pack", PACK_PATH],
          env: { INCIDENT_PACK: PACK_PATH, FLARE_MODEL_PROXY: proxyUrl, FLARE_AGENT_TOKEN: agentToken },
        }),
      );
      yield* step("agent-wait", () => sandbox.waitForExit({ handle: agentHandle }));

      // Read the agent's result (agent/v1).
      const resultRead = yield* step("read-result", () =>
        sandbox.exec({ container, cwd: dir, command: ["sh", "-lc", `cat ${RESULT_PATH} 2>/dev/null || echo '{}'`] }),
      );
      const outcome = ((): string => {
        try {
          return (JSON.parse(resultRead.stdout) as { outcome?: string }).outcome ?? "no-fix";
        } catch {
          return "no-fix";
        }
      })();
      if (outcome !== "patched") {
        yield* step("log-no-fix", () => io.log("info", `self-heal-pr: agent outcome ${outcome} — no PR`));
        return empty(outcome, false);
      }

      // VERIFY in the sandbox — re-run the repro on the patched tree. This is the
      // trusted gate, NOT the consumer's secret-bearing CI (§ 10.1).
      const verify = yield* step("verify", () =>
        sandbox.exec({ container, cwd: dir, command: ["sh", "-lc", reproCommand], timeoutSec: 600 }),
      );
      const verified = verify.exitCode === 0;
      if (!verified) {
        // Silent by default: annotate, open no PR (unless self-heal.open-unverified).
        yield* step("log-unverified", () =>
          io.log("warn", `self-heal-pr: fix did not pass the repro (exit ${verify.exitCode}) — silent, no PR`),
        );
        return empty("patched", false);
      }

      // Verified — stage the writeback; the Worker opens the draft PR on success.
      const staged = yield* step("stage-writeback", () =>
        sandbox.exec({ container, cwd: dir, command: ["sh", "-lc", STAGE_WRITEBACK_SCRIPT] }),
      );
      const changedPaths = staged.stdout.split("\n").map((s) => s.trim()).filter((s) => s.length > 0);

      yield* step("upload-writeback", () =>
        artifact.upload({ name: WRITEBACK_ARTIFACT, path: `${dir}/artifacts/writeback`, container }),
      );

      yield* io.log("info", `self-heal-pr: verified fix for ${pack.incidentId} (${changedPaths.length} files) — staging PR`);
      return { incidentId: pack.incidentId, outcome: "patched", verified: true, changedPaths, prStaged: true };
    }),
});
