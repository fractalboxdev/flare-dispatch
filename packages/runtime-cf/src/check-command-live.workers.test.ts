import { env } from "cloudflare:test";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type {
  CheckCommandOwner,
  CheckCommandLogState,
  ExecResult,
} from "@fractalboxdev/flare-dispatch-core";
import { makeCheckCommandService } from "./check-command-live";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    CHECK_COMMAND_LOGS: R2Bucket;
  }
}

describe("durable command bounded log publication", () => {
  it("lost chunk acknowledgment replays scrubbed bytes and finalization preserves actual exits", async () => {
    for (const code of [0, 7]) {
      const secret = "opaque-secret-value";
      const output = "x".repeat(65530) + secret + "END";
      let logs: CheckCommandLogState = {
        stdoutOffset: 0,
        stderrOffset: 0,
        stdoutTail: "",
        stderrTail: "",
        chunks: [],
      };
      let receipt: ExecResult | undefined;
      let loseReceiptAck = true;
      let terminal = false;
      const containers: string[] = [];
      const owner: CheckCommandOwner = {
        async start() {},
        async observe() {
          return terminal
            ? { state: "exited", exitCode: code, durationMs: 27 }
            : { state: "running" };
        },
        async read(_h, stream, offset, length) {
          const text = stream === "stdout" ? output.slice(offset, offset + length) : "";
          return { text, bytes: new TextEncoder().encode(text).length };
        },
        async logs() {
          return logs;
        },
        async advanceLogs(_h, expected, next) {
          expect(logs).toEqual(expected);
          logs = next;
        },
        async receipt() {
          return receipt;
        },
        async finish(_h, result) {
          receipt ??= result;
          if (loseReceiptAck) {
            loseReceiptAck = false;
            throw new Error("lost final receipt acknowledgment");
          }
          return receipt;
        },
      };
      let lost = true;
      let uploads = 0;
      let loseFinalUploadAck = true;
      let failBeforeStream = true;
      let finalUploads = 0;
      const bucket: Pick<R2Bucket, "get" | "head" | "put"> = {
        get: env.CHECK_COMMAND_LOGS.get.bind(env.CHECK_COMMAND_LOGS),
        head: env.CHECK_COMMAND_LOGS.head.bind(env.CHECK_COMMAND_LOGS),
        put: async (key, value, options) => {
          if (failBeforeStream) {
            failBeforeStream = false;
            throw new Error("upload refused before stream consumption");
          }
          const result = await env.CHECK_COMMAND_LOGS.put(key, value, options);
          finalUploads++;
          if (loseFinalUploadAck) {
            loseFinalUploadAck = false;
            throw new Error("lost final upload acknowledgment");
          }
          return result;
        },
      };
      const service = makeCheckCommandService(
        `logs-${code}`,
        "default-box",
        (container) => {
          containers.push(container.id);
          return owner;
        },
        bucket,
        async (key, command, stdout, stderr) => {
          uploads++;
          await env.CHECK_COMMAND_LOGS.put(key, JSON.stringify({ command, stdout, stderr }) + "\n");
          if (lost) {
            lost = false;
            throw new Error("lost chunk acknowledgment");
          }
        },
        (text) => text.slice(-4096),
      );
      const opts = {
        command: `printf '${secret}'`,
        redactValues: [secret],
        container: { id: "explicit-box" },
        timeoutSec: 1800,
      };
      const handle = await Effect.runPromise(service.prepare({ ...opts, stepName: "exec" }));
      await expect(Effect.runPromise(service.observe(handle, opts))).rejects.toThrow(
        "lost chunk acknowledgment",
      );
      expect(logs.stdoutOffset).toBe(0);
      await Effect.runPromise(service.observe(handle, opts));
      terminal = true;
      await expect(Effect.runPromise(service.finalize(handle, opts))).rejects.toThrow(
        "upload refused before stream consumption",
      );
      await expect(Effect.runPromise(service.finalize(handle, opts))).rejects.toThrow(
        "lost final upload acknowledgment",
      );
      expect(receipt).toBeUndefined();
      await expect(Effect.runPromise(service.finalize(handle, opts))).rejects.toThrow(
        "lost final receipt acknowledgment",
      );
      const result = await Effect.runPromise(service.finalize(handle, opts));
      expect(result.exitCode).toBe(code);
      expect(result.durationMs).toBe(27);
      expect(result.stdout).toContain("***END");
      const object = await env.CHECK_COMMAND_LOGS.get(result.logPath);
      const published = await object!.text();
      expect(published).not.toContain(secret);
      expect(published).toContain("***END");
      expect(logs.chunks.length).toBeGreaterThan(1);
      const prior = uploads;
      expect(await Effect.runPromise(service.finalize(handle, opts))).toEqual(result);
      expect(uploads).toBe(prior);
      expect(finalUploads).toBe(2);
      expect(new Set(containers)).toEqual(new Set(["explicit-box"]));
    }
  });
});
