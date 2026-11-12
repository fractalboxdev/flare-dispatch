import { Effect } from "effect";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  accessClaims,
  actionsClaims,
  baseConfig,
  DISPATCHER,
  makeHarness,
  OPERATOR,
  type Harness,
} from "../api.test-support.ts";
import { apiConfigFromEnv, ConfigInvalid, type ApiConfigShape } from "../config.ts";
import { mcpGroup } from "../mcp/server.ts";

const SCANNER = "scan-bot.access";
const SCOPED = {
  identity: SCANNER,
  runs: ["security-rescan"],
  repositories: ["acme/widgets"],
  classCeiling: "batch",
} as const;

let h: Harness;
let config: ApiConfigShape;
beforeAll(async () => {
  h = await makeHarness([mcpGroup]);
  config = baseConfig({ scoped: [SCOPED] });
});
beforeEach(() => {
  h.doubles.intake = (s) =>
    Effect.succeed({ _tag: "Admitted", executionId: "01JSCOPED", class: s.class ?? "batch" });
});

const dispatchInit = (repository = "acme/widgets"): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ repository, inputs: {} }),
});

const dispatch = async (identity: string, run: string, repository?: string) =>
  h.fetch(`/v1/dispatch/${run}`, {
    ...(await h.asAccess(identity, dispatchInit(repository))),
    config,
  });

const errorOf = async (response: Response) =>
  ((await response.json()) as Record<string, unknown>)["error"];

describe("scoped dispatch", () => {
  it("[FD-IFC-089]: a scoped identity naming a run outside its entry's runs answers 403 before the run is looked up", async () => {
    const before = h.doubles.calls.submissions.length;
    for (const run of ["check", "no-such-run"]) {
      const response = await dispatch(SCANNER, run);
      expect(response.status).toBe(403);
      expect(await errorOf(response)).toBe("forbidden");
    }
    expect(h.doubles.calls.submissions.length).toBe(before);
    const allowed = await dispatch(SCANNER, "security-rescan");
    expect(allowed.status).toBe(202);
    expect(h.doubles.calls.submissions.at(-1)).toMatchObject({
      run: "security-rescan",
      repository: "acme/widgets",
      caller: SCANNER,
    });
  });

  it("[FD-IFC-089]: the entry comes from the DISPATCH_SCOPED var, its identity matched without case", async () => {
    const fromEnv = apiConfigFromEnv(
      {
        ACCESS_TEAM_DOMAIN: "team.example.com",
        ACCESS_AUD: "aud-tag",
        DISPATCH_SCOPED: JSON.stringify([{ ...SCOPED, identity: "Scan-Bot.Access" }]),
      },
      "https://dispatcher.example.com",
    );
    expect(fromEnv).not.toBeInstanceOf(ConfigInvalid);
    const scoped = (fromEnv as ApiConfigShape).scoped;
    expect(scoped).toEqual([SCOPED]);
    const before = h.doubles.calls.submissions.length;
    const response = await h.fetch("/v1/dispatch/check", {
      ...(await h.asAccess(SCANNER, dispatchInit())),
      config: baseConfig({ scoped }),
    });
    expect(response.status).toBe(403);
    expect(h.doubles.calls.submissions.length).toBe(before);
  });

  it("[FD-IFC-089]: a DISPATCH_SCOPED var that does not decode, or names another class ceiling, is refused", () => {
    for (const value of [
      "not json",
      JSON.stringify([{ ...SCOPED, classCeiling: "release" }]),
      JSON.stringify([{ identity: SCANNER, runs: ["security-rescan"] }]),
    ])
      expect(apiConfigFromEnv({ DISPATCH_SCOPED: value }, "https://x")).toBeInstanceOf(
        ConfigInvalid,
      );
    const none = apiConfigFromEnv({ DISPATCH_SCOPED: "" }, "https://x") as ApiConfigShape;
    expect(none.scoped).toEqual([]);
  });

  it("[FD-IFC-090]: a scoped identity naming a repository outside its entry's repositories answers 403 before the run is looked up", async () => {
    const before = h.doubles.calls.submissions.length;
    for (const repository of ["acme/other", "other/widgets"]) {
      const response = await dispatch(SCANNER, "security-rescan", repository);
      expect(response.status).toBe(403);
      expect(await errorOf(response)).toBe("forbidden");
    }
    expect(h.doubles.calls.submissions.length).toBe(before);
    // GitHub compares repository names without case, and so does the entry.
    expect((await dispatch(SCANNER, "security-rescan", "Acme/Widgets")).status).toBe(202);
    // A dispatcher outside dispatch.scoped is held to no entry's repositories.
    expect((await dispatch(DISPATCHER, "check", "acme/other")).status).toBe(202);
  });

  it("[FD-IFC-091]: a scoped identity's dispatch carries its entry's classCeiling to intake; any other caller's none", async () => {
    expect((await dispatch(SCANNER, "security-rescan")).status).toBe(202);
    expect(h.doubles.calls.submissions.at(-1)).toMatchObject({
      run: "security-rescan",
      caller: SCANNER,
      classCeiling: "batch",
    });
    const interactive = await h.fetch("/v1/dispatch/security-rescan", {
      ...(await h.asAccess(SCANNER, dispatchInit())),
      config: baseConfig({ scoped: [{ ...SCOPED, classCeiling: "interactive" }] }),
    });
    expect(interactive.status).toBe(202);
    expect(h.doubles.calls.submissions.at(-1)?.classCeiling).toBe("interactive");
    expect((await dispatch(DISPATCHER, "check")).status).toBe(202);
    expect(h.doubles.calls.submissions.at(-1)).toMatchObject({ caller: DISPATCHER });
    expect(h.doubles.calls.submissions.at(-1)?.classCeiling).toBeUndefined();
  });

  it("[FD-IFC-093]: a dispatch of security-gate answers 403 for every identity", async () => {
    const before = h.doubles.calls.submissions.length;
    const listing = baseConfig({
      operators: [OPERATOR],
      dispatchers: [DISPATCHER, OPERATOR],
      scoped: [{ ...SCOPED, runs: ["security-gate", "security-rescan"] }],
    });
    const actions = await h.actions.sign(actionsClaims("acme/widgets"));
    const requests: RequestInit[] = [
      await h.asAccess(DISPATCHER, dispatchInit()),
      await h.asAccess(OPERATOR, dispatchInit()),
      await h.asAccess(SCANNER, dispatchInit()),
      {
        ...dispatchInit(),
        headers: { "content-type": "application/json", authorization: `Bearer ${actions}` },
      },
    ];
    for (const init of requests) {
      const response = await h.fetch("/v1/dispatch/security-gate", { ...init, config: listing });
      expect(response.status).toBe(403);
      expect(await errorOf(response)).toBe("forbidden");
    }
    expect(h.doubles.calls.submissions.length).toBe(before);
  });

  it("[FD-IFC-093]: the MCP dispatch tool refuses security-gate too", async () => {
    const before = h.doubles.calls.submissions.length;
    const response = await h.fetch("/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "tools/call",
        "mcp-name": "dispatch",
        "cf-access-jwt-assertion": await h.access.sign(accessClaims(DISPATCHER)),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "dispatch",
          arguments: { run: "security-gate", repo: "acme/widgets", inputs: {} },
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
      config,
    });
    const text = await response.text();
    const data = text
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim());
    const message = JSON.parse(data.at(-1) ?? text) as {
      result: { isError?: boolean; content: { text: string }[] };
    };
    expect(message.result.isError).toBe(true);
    expect(JSON.parse(message.result.content[0]!.text)).toMatchObject({ error: "forbidden" });
    expect(h.doubles.calls.submissions.length).toBe(before);
  });
});
