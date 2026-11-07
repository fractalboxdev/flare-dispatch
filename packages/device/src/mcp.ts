// FlareDispatch's MCP server on the device: the tools `rehearse`, `get_verdict`, `get_failure_summary`, `cancel` and
// `lease_status` over stdio, each reaching the local scheduler only through its Unix socket (FD-LOCAL-038,
// specs/interfaces.md § MCP tools).
import { Effect, Match } from "effect";
import { SchedulerSocket, type SocketOperation } from "./scheduler-socket.ts";

export const PROTOCOL_VERSION = "2025-06-18";

interface Tool {
  readonly name: string;
  readonly description: string;
  readonly op: SocketOperation;
  /** The largest `wait_seconds` the tool accepts (FD-IFC-078). */
  readonly maxWait?: number;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

const id = { execution_id: { type: "string" } };
const wait = { wait_seconds: { type: "integer", minimum: 0 } };

export const TOOLS: readonly Tool[] = [
  {
    name: "rehearse",
    description: "Run a recipe on this device against the working tree and predict its verdict.",
    op: "submit",
    maxWait: 600,
    inputSchema: {
      type: "object",
      properties: {
        run: { type: "string" },
        inputs: { type: "object" },
        class: { type: "string" },
        ...wait,
      },
      required: ["run"],
    },
  },
  {
    name: "get_verdict",
    description: "The status and verdict of a local execution.",
    op: "outcome",
    maxWait: 60,
    inputSchema: { type: "object", properties: { ...id, ...wait }, required: ["execution_id"] },
  },
  {
    name: "get_failure_summary",
    description: "The incident/v1 pack of a failed local execution.",
    op: "failure_summary",
    inputSchema: { type: "object", properties: id, required: ["execution_id"] },
  },
  {
    name: "cancel",
    description: "Cancel a local execution.",
    op: "cancel",
    inputSchema: { type: "object", properties: id, required: ["execution_id"] },
  },
  {
    name: "lease_status",
    description: "The capacity lease's state, slots, remaining token allowance and offline flag.",
    op: "lease_status",
    inputSchema: { type: "object", properties: {} },
  },
];

interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id?: string | number;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

const toolResult = (structured: unknown, isError = false) => ({
  content: [{ type: "text", text: JSON.stringify(structured) }],
  structuredContent: structured,
  isError,
});

const callTool = (name: string, args: Record<string, unknown>) =>
  Effect.gen(function* () {
    const tool = TOOLS.find((t) => t.name === name);
    if (tool === undefined) return toolResult({ error: "unknown_tool", tool: name }, true);
    const waitSeconds = args["wait_seconds"];
    if (
      tool.maxWait !== undefined &&
      waitSeconds !== undefined &&
      (typeof waitSeconds !== "number" || waitSeconds < 0 || waitSeconds > tool.maxWait)
    )
      return toolResult({ error: "invalid_wait", max: tool.maxWait }, true);
    const socket = yield* SchedulerSocket;
    const sent = tool.name === "rehearse" ? { class: "rehearsal", ...args } : args;
    return yield* socket.call(tool.op, sent).pipe(
      Effect.map((result) => toolResult(result)),
      Effect.catchTags({
        SchedulerUnreachable: (e) =>
          Effect.succeed(toolResult({ error: "scheduler_unreachable", detail: e.detail }, true)),
        SchedulerRefused: (e) =>
          Effect.succeed(toolResult({ error: e.code, detail: e.message }, true)),
      }),
    );
  });

/** One JSON-RPC message answered; a notification answers `null`. */
export const handleMessage = (request: JsonRpcRequest) =>
  Effect.gen(function* () {
    if (request.id === undefined) return null;
    const respond = (result: unknown) => ({ jsonrpc: "2.0" as const, id: request.id, result });
    return yield* Match.value(request.method).pipe(
      Match.when("initialize", () =>
        Effect.succeed(
          respond({
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: "fd-local", version: "0.0.1" },
          }),
        ),
      ),
      Match.when("ping", () => Effect.succeed(respond({}))),
      Match.when("tools/list", () =>
        Effect.succeed(
          respond({
            tools: TOOLS.map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
            })),
          }),
        ),
      ),
      Match.when("tools/call", () =>
        Effect.map(
          callTool(
            String(request.params?.["name"] ?? ""),
            (request.params?.["arguments"] as Record<string, unknown> | undefined) ?? {},
          ),
          respond,
        ),
      ),
      Match.orElse((method) =>
        Effect.succeed({
          jsonrpc: "2.0" as const,
          id: request.id,
          error: { code: -32601, message: `method ${method} not found` },
        }),
      ),
    );
  });

/** Serves MCP over newline-delimited JSON on the given streams. */
export const serveStdio = (input: NodeJS.ReadableStream, output: NodeJS.WritableStream) =>
  Effect.gen(function* () {
    const socket = yield* SchedulerSocket;
    yield* Effect.callback<void>((resume) => {
      let buffer = "";
      input.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
          const line = buffer.slice(0, end).trim();
          buffer = buffer.slice(end + 1);
          if (line === "") continue;
          let request: JsonRpcRequest;
          try {
            request = JSON.parse(line) as JsonRpcRequest;
          } catch {
            output.write(
              `${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } })}\n`,
            );
            continue;
          }
          void Effect.runPromise(
            handleMessage(request).pipe(Effect.provideService(SchedulerSocket, socket)),
          ).then((reply) => {
            if (reply !== null) output.write(`${JSON.stringify(reply)}\n`);
          });
        }
      });
      input.on("end", () => resume(Effect.void));
    });
  });
