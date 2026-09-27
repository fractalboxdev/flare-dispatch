// Offline replay of the GitLab MR review against REAL diffs — the large-MR gate.
//
// Runs the SAME step wiring the GitlabReviewWorkflow runs (runChunkedReview:
// prepare → one step per chunk → reduce) with:
//   * scm    — a FAKE that serves a saved diff. It cannot post: nothing reaches
//              the MR, no webhook fires, the live bot is never involved.
//   * model  — the production ModelGateway Layer over a REST shim of the
//              Workers AI binding (`/accounts/<id>/ai/run/<model>`), so the
//              streaming + deadline code under test is the code that ships.
//   * config — a JSON snapshot of CONFIG_KV plus optional overrides.
//
// Not part of `pnpm test` (own config). Run:
//
//   REPLAY_DIR=/tmp/fd-replay REPLAY_MRS=304,252 \
//   REPLAY_ACCOUNT_ID=<cf account> REPLAY_AI_TOKEN_FILE=<file> \
//   npx vitest run --config vitest.replay.config.ts
//
// Inputs in REPLAY_DIR: `<iid>.diff` (the MR diff), `kv.json` (CONFIG_KV
// snapshot), optional `overrides.json`. Outputs: `<iid>.note.md` (the note the
// review would post) and `results.json` (one row per MR). The token is read
// from the file at call time and never logged.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "vitest";
import { Effect, Layer } from "effect";
import { makeConfigFake, makeScmFake } from "@fractalboxdev/flare-dispatch-core/testing";
import { scm } from "@fractalboxdev/flare-dispatch-core";
// By path: the runtime-cf index also loads the container runtime, which does
// not import under plain Node.
import { type AiBinding, makeModelGatewayLive } from "../../../packages/runtime-cf/src/model-gateway-cf";
import { makeGitlabScmLive } from "../../../packages/runtime-cf/src/scm-gitlab";
import type { MrReviewInput } from "@fractalboxdev/flare-dispatch-runs/mr-review";
import { runChunkedReview } from "../src/gitlab-review-chunked";

const env = (k: string): string => {
  const v = process.env[k];
  if (v === undefined || v === "") throw new Error(`${k} is not set`);
  return v;
};

/** The Workers AI binding, over REST. A stream call returns the SSE body. */
const restAi = (accountId: string, tokenFile: string, log: (m: string) => void): AiBinding => ({
  run: async (model, inputs) => {
    const t0 = Date.now();
    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${readFileSync(tokenFile, "utf8").trim()}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(inputs),
    });
    if (!res.ok) {
      const text = await res.text();
      let msg = text.slice(0, 300);
      try {
        const e = (JSON.parse(text) as { errors?: Array<{ code: number; message: string }> }).errors?.[0];
        if (e !== undefined) msg = `${e.code}: ${e.message}`;
      } catch {
        /* keep the raw text */
      }
      log(`  ${model} HTTP ${res.status} ${msg} (${Date.now() - t0} ms)`);
      throw new Error(msg);
    }
    if ((inputs as { stream?: boolean }).stream === true && res.body !== null) return res.body;
    return ((await res.json()) as { result: never }).result;
  },
});

const PRICES: Record<string, [number, number]> = {};

/**
 * Save an MR's diff exactly as the Worker would fetch it — the production
 * GitLab `scm.fetchDiff` (GET requests only; this Layer is never asked to post).
 * Needs REPLAY_GITLAB_PROJECT and REPLAY_GITLAB_TOKEN_FILE.
 */
const fetchDiffOnce = async (iid: number, path: string): Promise<void> => {
  const project = env("REPLAY_GITLAB_PROJECT");
  const token = readFileSync(env("REPLAY_GITLAB_TOKEN_FILE"), "utf8").trim();
  const mr = (await (
    await fetch(`https://gitlab.com/api/v4/projects/${encodeURIComponent(project)}/merge_requests/${iid}`, {
      headers: { "private-token": token },
    })
  ).json()) as { diff_refs: { base_sha: string; head_sha: string } };
  const fetched = await Effect.runPromise(
    scm
      .fetchDiff({ project, number: iid, headSha: mr.diff_refs.head_sha, baseSha: mr.diff_refs.base_sha })
      .pipe(Effect.provide(makeGitlabScmLive({ token }))),
  );
  writeFileSync(path, fetched.diff, { mode: 0o600 });
};

describe("mr-review replay", () => {
  it("replays each MR through the chunked pipeline", { timeout: 60 * 60 * 1000 }, async () => {
    const dir = env("REPLAY_DIR");
    const accountId = env("REPLAY_ACCOUNT_ID");
    const tokenFile = env("REPLAY_AI_TOKEN_FILE");
    const mrs = env("REPLAY_MRS").split(",").map((s) => Number(s.trim()));
    const kv = JSON.parse(readFileSync(join(dir, "kv.json"), "utf8")) as Record<string, string>;
    let overrides: Record<string, string> = {};
    try {
      overrides = JSON.parse(readFileSync(join(dir, "overrides.json"), "utf8")) as Record<string, string>;
    } catch {
      /* none */
    }
    const cfg = { ...kv, ...overrides };
    for (const [k, v] of Object.entries(cfg)) {
      const m = /^pr-review\.pricing\.(.+)$/.exec(k);
      if (m !== null) {
        const [i, o] = v.split(",").map(Number);
        PRICES[m[1]!] = [i ?? 0, o ?? 0];
      }
    }
    const rows: unknown[] = [];
    for (const iid of mrs) {
      const lines: string[] = [];
      const log = (m: string) => {
        lines.push(m);
        console.log(`[!${iid}] ${m}`);
      };
      const diffPath = join(dir, `${iid}.diff`);
      if (!existsSync(diffPath)) await fetchDiffOnce(iid, diffPath);
      const diff = readFileSync(diffPath, "utf8");
      if (process.env.REPLAY_FETCH_ONLY === "1") {
        console.log(`[!${iid}] saved diff: ${diff.length} chars`);
        continue;
      }
      const input: MrReviewInput = {
        projectId: "replay",
        iid,
        headSha: "0000000000000000000000000000000000000000",
        baseSha: "0000000",
        projectWebUrl: "https://gitlab.com/replay/replay",
      };
      const layer = Layer.mergeAll(
        makeScmFake({ diff }).layer,
        makeModelGatewayLive(restAi(accountId, tokenFile, log), undefined),
        makeConfigFake(cfg),
      );
      const stepLog: Array<{ name: string; ms: number; ok: boolean; attempts: number }> = [];
      const t0 = Date.now();
      // Mirrors the Workflow: prepare/reduce and each chunk get ONE retry.
      const step = async <T,>(name: string, _kind: string, cb: () => Promise<T>): Promise<T> => {
        const s = Date.now();
        for (let attempt = 1; ; attempt++) {
          try {
            const r = await cb();
            stepLog.push({ name, ms: Date.now() - s, ok: true, attempts: attempt });
            return r;
          } catch (e) {
            if (attempt >= 2) {
              stepLog.push({ name, ms: Date.now() - s, ok: false, attempts: attempt });
              throw e;
            }
          }
        }
      };
      const out = await runChunkedReview({
        input,
        step,
        run: (eff) => Effect.runPromise(eff.pipe(Effect.provide(layer))),
      });
      const wallMs = Date.now() - t0;
      const r = out.result;
      const usage = r.usage;
      let usd = 0;
      for (const [model, u] of Object.entries(usage?.byModel ?? {})) {
        const p = PRICES[model] ?? [0, 0];
        usd += (u.inputTokens * p[0] + u.outputTokens * p[1]) / 1e6;
      }
      writeFileSync(join(dir, `${iid}.note.md`), r.noteBody ?? "(no note)");
      const notReviewed = (r.noteBody ?? "").split("\n").filter((l) => l.startsWith("- `")).length;
      const row = {
        mr: iid,
        diffChars: diff.length,
        chunks: r.chunks?.length ?? 0,
        chunkStatus: r.chunks?.map((c) => `${c.status}:${c.models.join("+") || "-"}${c.fallbacks > 0 ? `(fb${c.fallbacks})` : ""}`),
        notReviewedFiles: notReviewed,
        calls: usage?.calls ?? 0,
        inTok: usage?.inputTokens ?? 0,
        outTok: usage?.outputTokens ?? 0,
        usd: Number(usd.toFixed(4)),
        wallS: Math.round(wallMs / 1000),
        status: r.status,
        verdict: r.output?.verdict ?? null,
        findings: r.output?.findings.length ?? 0,
        reason: r.reason,
        steps: stepLog,
        errors: lines,
      };
      rows.push(row);
      console.log(JSON.stringify({ ...row, steps: undefined, errors: lines.length }));
    }
    writeFileSync(join(dir, "results.json"), JSON.stringify(rows, null, 1));
  });
});
