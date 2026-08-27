// redactWsEndpoint tests — the security-critical transform that keeps CDP
// WebSocket credentials (bearer tokens in the query string, userinfo) out of
// error objects and log lines. A regression here is a credential leak into
// the dispatcher's logs on every failed attach.

import { describe, expect, it } from "vitest";
import { AX_NODE_BUDGET, serializeAxTree, redactWsEndpoint } from "./cdp.js";

describe("redactWsEndpoint", () => {
  it("strips the query string (where Browser Rendering tokens ride)", () => {
    expect(
      redactWsEndpoint("wss://browser-rendering.example/ws?token=abc123&recording=true"),
    ).toBe("wss://browser-rendering.example/ws");
  });

  it("strips userinfo", () => {
    expect(
      redactWsEndpoint("wss://user:secret@host.example:9222/devtools"),
    ).toBe("wss://host.example:9222/devtools");
  });

  it("strips both userinfo and query", () => {
    expect(
      redactWsEndpoint("wss://user:secret@host.example/ws?token=abc"),
    ).toBe("wss://host.example/ws");
  });

  it("strips the fragment", () => {
    expect(
      redactWsEndpoint("wss://host.example/ws?token=abc#frag"),
    ).toBe("wss://host.example/ws");
  });

  it("keeps a bare endpoint unchanged", () => {
    expect(redactWsEndpoint("wss://host.example/ws")).toBe(
      "wss://host.example/ws",
    );
  });

  it("redacts an unparseable endpoint at the first ? or #", () => {
    expect(redactWsEndpoint("not a url?token=abc")).toBe("not a url");
  });

  it("drops the fragment even on a minimal parseable endpoint", () => {
    expect(redactWsEndpoint("wss://broken#frag")).toBe("wss://broken/");
  });
});

// serializeAxTree tests — the snapshot encoding is 73-77% of the agent's token
// spend, so this transform is where the bill lives. The properties that matter:
// no scalar is lost (the model reasons about `disabled`, `value`, `checked`),
// and the node budget cuts at a node boundary with a stated remainder rather
// than truncating mid-structure the way a `slice` on the old JSON did.

describe("serializeAxTree", () => {
  it("renders role and name as one indented line per node", () => {
    expect(
      serializeAxTree({
        role: "WebArea",
        name: "Home",
        children: [{ role: "button", name: "Add game" }],
      }),
    ).toBe('WebArea "Home"\n  button "Add game"');
  });

  it("keeps every scalar property, so state the model reasons about survives", () => {
    const out = serializeAxTree({
      role: "textbox",
      name: "Paste a store URL",
      value: "https://play.google.com/x",
      disabled: true,
      level: 2,
    });
    expect(out).toContain('value="https://play.google.com/x"');
    expect(out).toContain("disabled");
    expect(out).toContain("level=2");
  });

  it("drops false booleans the way puppeteer's own serializer does", () => {
    expect(serializeAxTree({ role: "checkbox", name: "Opt in", checked: false })).toBe(
      'checkbox "Opt in"',
    );
  });

  it("quotes names so an embedded quote or newline cannot forge a node line", () => {
    expect(serializeAxTree({ role: "button", name: 'Say "hi"\nrole fake' })).toBe(
      'button "Say \\"hi\\"\\nrole fake"',
    );
  });

  it("is smaller than the JSON encoding it replaces", () => {
    const tree = {
      role: "WebArea",
      name: "Billing",
      children: Array.from({ length: 50 }, (_, i) => ({
        role: "button",
        name: `Action ${i}`,
      })),
    };
    expect(serializeAxTree(tree).length).toBeLessThan(JSON.stringify(tree).length);
  });

  it("cuts at a node boundary and states how many nodes it did not show", () => {
    const wide = {
      role: "WebArea",
      name: "Huge",
      children: Array.from({ length: AX_NODE_BUDGET + 25 }, (_, i) => ({
        role: "button",
        name: `b${i}`,
      })),
    };
    const out = serializeAxTree(wide);
    const lines = out.split("\n");
    expect(lines).toHaveLength(AX_NODE_BUDGET + 1);
    expect(lines[lines.length - 1]).toContain("…truncated: 26 more nodes not shown");
    // Every retained line is a whole node, never a severed fragment.
    for (const line of lines.slice(0, -1)) expect(line.trim()).toMatch(/^\S+ "/);
  });

  it("counts unshown descendants, not just unshown siblings", () => {
    const deep = {
      role: "WebArea",
      name: "Nested",
      children: Array.from({ length: AX_NODE_BUDGET }, (_, i) => ({
        role: "group",
        name: `g${i}`,
        ...(i === AX_NODE_BUDGET - 1
          ? { children: [{ role: "button", name: "buried", children: [{ role: "text", name: "deep" }] }] }
          : {}),
      })),
    };
    // The one group that misses the budget carries two descendants, so the
    // remainder is 3 — a sibling-only count would have said 1.
    expect(serializeAxTree(deep)).toContain("…truncated: 3 more nodes not shown");
  });

  it("survives an empty snapshot", () => {
    expect(serializeAxTree(null)).toBe('WebArea ""');
    expect(serializeAxTree(undefined)).toBe('WebArea ""');
  });
});
