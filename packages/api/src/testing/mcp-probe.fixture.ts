// Effect 4.0.6's MCP server on workerd, over both Streamable HTTP transports it offers: the request-scoped endpoint
// (sessionless revision 2026-07-28) and the long-lived endpoint (sessionful revision 2025-06-18), each serving one
// tool. FD-IFC-072 rests on one of them working inside a Worker.
import { Effect, Layer, Schema } from "effect";
import { McpProtocol, McpServer, Tool, Toolkit } from "effect/ai";
import { HttpRouter, HttpServer } from "effect/http";

const GetVerdict = Tool.make("get_verdict", {
  description: "The verdict of one execution",
  parameters: Schema.Struct({ execution_id: Schema.String }),
  success: Schema.Struct({ execution_id: Schema.String, status: Schema.String }),
});

const Tools = Toolkit.make(GetVerdict);

const ToolsLive = Tools.toLayer({
  get_verdict: ({ execution_id }) => Effect.succeed({ execution_id, status: "done" }),
});

const requestScoped = McpServer.toolkit(Tools).pipe(
  Layer.provideMerge(
    McpServer.layerHttpRequestScoped({
      name: "probe",
      version: "0.0.0",
      path: "/mcp",
      protocols: [McpProtocol.v2026_07_28],
    }),
  ),
  Layer.provide(ToolsLive),
);

const sessionful = McpServer.toolkit(Tools).pipe(
  Layer.provideMerge(
    McpServer.layerHttp({
      name: "probe",
      version: "0.0.0",
      path: "/mcp-session",
      protocols: [McpProtocol.v2025_06_18],
    }),
  ),
  Layer.provide(ToolsLive),
);

const scoped = HttpRouter.toWebHandler(
  requestScoped.pipe(Layer.provide(HttpServer.layerServices)),
  {
    disableLogger: true,
  },
);
const longLived = HttpRouter.toWebHandler(
  sessionful.pipe(Layer.provide(HttpServer.layerServices)),
  {
    disableLogger: true,
  },
);

export default {
  fetch(request: Request): Promise<Response> {
    return new URL(request.url).pathname === "/mcp"
      ? scoped.handler(request)
      : longLived.handler(request);
  },
};
