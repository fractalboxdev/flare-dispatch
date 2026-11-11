// Test doubles for the recipe services: no model, GitHub or process is reached.
import { Effect, Layer } from "effect";
import * as WorkflowEngine from "effect/workflow/WorkflowEngine";
import type { Manifest } from "../staged-write/manifest.ts";
import {
  Artifacts,
  Checkout,
  EditLoop,
  ModelCallError,
  ModelClient,
  RecipeIntents,
  Shell,
  StagedWrites,
  SuppressionLedger,
  SuppressionReadFailed,
  type CommandResult,
  type ModelRequest,
  type SuppressionEntry,
} from "./services.ts";

export interface Recorder {
  readonly commands: string[];
  readonly modelCalls: ModelRequest[];
  readonly intents: { step: string; kind: string; payload: unknown }[];
  readonly artifacts: { name: string; access: string; text: string }[];
  readonly staged: Parameters<StagedWrites["Service"]["stage"]>[0][];
  readonly files: Map<string, string>;
  readonly prompts: string[];
  /** Every key the run looked up in the suppression ledger. */
  readonly suppressionLookups: string[];
}

export interface FakeOptions {
  readonly shell?: (command: string) => CommandResult;
  /** The model's answer per call; a thrown `ModelCallError` kind fails the call. */
  readonly model?: (request: ModelRequest, call: number) => string | ModelCallError;
  readonly files?: Record<string, string>;
  readonly editLoop?: (prompt: string, files: Map<string, string>) => number | null;
  /** The suppression ledger's row per key; `"fail"` fails the read. No row by default. */
  readonly suppression?: (key: string) => SuppressionEntry | null | "fail";
}

export const recorder = (files: Record<string, string> = {}): Recorder => ({
  commands: [],
  modelCalls: [],
  intents: [],
  artifacts: [],
  staged: [],
  files: new Map(Object.entries(files)),
  prompts: [],
  suppressionLookups: [],
});

export const fakeServices = (rec: Recorder, options: FakeOptions = {}) =>
  Layer.mergeAll(
    Layer.succeed(Shell, {
      run: (command) =>
        Effect.sync(() => {
          rec.commands.push(command);
          return options.shell?.(command) ?? { exitCode: 0, stdout: "", stderr: "" };
        }),
    }),
    Layer.succeed(ModelClient, {
      complete: (request) =>
        Effect.suspend(() => {
          rec.modelCalls.push(request);
          const answer = options.model?.(request, rec.modelCalls.length) ?? '{"findings":[]}';
          return typeof answer === "string" ? Effect.succeed(answer) : Effect.fail(answer);
        }),
    }),
    Layer.succeed(RecipeIntents, {
      append: (step, kind, payload) =>
        Effect.sync(() => void rec.intents.push({ step, kind, payload })),
    }),
    Layer.succeed(Artifacts, {
      put: (name, bytes, access) =>
        Effect.sync(
          () => void rec.artifacts.push({ name, access, text: new TextDecoder().decode(bytes) }),
        ),
    }),
    Layer.succeed(StagedWrites, {
      stage: (input) =>
        Effect.sync(() => {
          rec.staged.push(input);
          return {
            ...input,
            baseCommit: "b".repeat(40),
            entries: [],
          } satisfies Manifest;
        }),
    }),
    Layer.succeed(Checkout, {
      read: (path) => Effect.sync(() => rec.files.get(path) ?? null),
      write: (path, text) => Effect.sync(() => void rec.files.set(path, text)),
      list: (dir) =>
        Effect.sync(() => [...rec.files.keys()].filter((p) => p.startsWith(`${dir}/`)).sort()),
    }),
    Layer.succeed(EditLoop, {
      run: (prompt) =>
        Effect.sync(() => {
          rec.prompts.push(prompt);
          return { exitCode: options.editLoop?.(prompt, rec.files) ?? 0 };
        }),
    }),
    Layer.succeed(SuppressionLedger, {
      lookup: (key) =>
        Effect.suspend(() => {
          rec.suppressionLookups.push(key);
          const row = options.suppression?.(key) ?? null;
          return row === "fail"
            ? Effect.fail(new SuppressionReadFailed({ key, detail: "D1_ERROR: injected" }))
            : Effect.succeed(row);
        }),
    }),
    WorkflowEngine.layerMemory,
  );

export const payload = <I>(run: string, input: I, execution = "01HEXEC0000000000000000000") => ({
  workflow_version: 1,
  execution_id: execution,
  run,
  run_version: "2.0.0",
  scope_id: "scope",
  request_context: {},
  class: "interactive",
  epoch: 1,
  deadline_at: Date.now() + 3_600_000,
  attempt: 0,
  input,
});
