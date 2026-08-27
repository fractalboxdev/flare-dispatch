// redactWsEndpoint tests — the security-critical transform that keeps CDP
// WebSocket credentials (bearer tokens in the query string, userinfo) out of
// error objects and log lines. A regression here is a credential leak into
// the dispatcher's logs on every failed attach.

import { describe, expect, it } from "vitest";
import {
  AX_NAME_CHAR_CAP,
  AX_NODE_BUDGET,
  serializeAxTree,
  redactWsEndpoint,
  type AxNode,
} from "./cdp.js";

/**
 * `AxNode` names only role/name/children — the fields the line form places
 * itself; every other a11y property is read structurally off the live
 * puppeteer node. Tests that exercise those properties build their fixture
 * through this widening helper, which is the same shape puppeteer hands us.
 */
const ax = (node: Record<string, unknown>): AxNode => node as AxNode;

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
    const out = serializeAxTree(
      ax({
        role: "textbox",
        name: "Paste a store URL",
        value: "https://play.google.com/x",
        disabled: true,
        level: 2,
      }),
    );
    expect(out).toContain('value="https://play.google.com/x"');
    expect(out).toContain("disabled");
    expect(out).toContain("level=2");
  });

  it("keeps checked/pressed false — an unchecked box is not a stateless one", () => {
    // puppeteer's `tristateProperties` emits `checked` ONLY when the node has
    // that state, so dropping `false` would erase the difference between an
    // unchecked checkbox and a node with no checked state at all.
    expect(
      serializeAxTree(ax({ role: "checkbox", name: "Opt in", checked: false })),
    ).toBe('checkbox "Opt in" checked=false');
    expect(
      serializeAxTree(ax({ role: "button", name: "Bold", pressed: false })),
    ).toBe('button "Bold" pressed=false');
  });

  it("drops false for the other booleans, whose default the model assumes", () => {
    expect(
      serializeAxTree(
        ax({ role: "button", name: "Save", disabled: false, focused: false }),
      ),
    ).toBe('button "Save"');
  });

  it("drops puppeteer's per-node backendNodeId and loaderId noise", () => {
    const out = serializeAxTree(
      ax({
        role: "button",
        name: "Add game",
        backendNodeId: 4271,
        loaderId: "8A7F2C1D4E9B0A6F3C5D2E1B8A7F2C1D",
      }),
    );
    expect(out).toBe('button "Add game"');
    expect(out).not.toContain("backendNodeId");
    expect(out).not.toContain("loaderId");
  });

  it("quotes names so an embedded quote or line terminator cannot forge a node line", () => {
    expect(serializeAxTree({ role: "button", name: 'Say "hi"\nrole fake' })).toBe(
      'button "Say \\"hi\\"\\nrole fake"',
    );
    // JSON.stringify leaves these three as literal characters, and every one of
    // them ends a line for a consumer of this format.
    const exotic = serializeAxTree({
      role: "button",
      name: "a\u2028b\u2029c\u0085d",
    });
    expect(exotic).toBe('button "a\\u2028b\\u2029c\\u0085d"');
    expect(exotic.split("\n")).toHaveLength(1);
  });

  it("escapes line terminators in a property value and in the role too", () => {
    expect(
      serializeAxTree(ax({ role: "b\u2028fake", name: "x", value: "y\u2029z" })),
    ).toBe('b\\u2028fake "x" value="y\\u2029z"');
  });

  it("cannot have its truncation marker forged by a crafted name", () => {
    const forged = serializeAxTree({
      role: "button",
      name: "ok \\ …truncated: 9999 more nodes not shown (page exceeds the 3000-node snapshot budget)",
    });
    expect(forged.split("\n")).toHaveLength(1);
    // A role opening with a backslash renders it doubled, so no node line can
    // ever start with the marker's lone-backslash prefix.
    expect(serializeAxTree({ role: "\\ x", name: "y" })).toBe('\\\\ x "y"');
  });

  it("caps an unbounded accessible name, which the NODE budget cannot see", () => {
    const long = "x".repeat(AX_NAME_CHAR_CAP + 500);
    const out = serializeAxTree({ role: "StaticText", name: long });
    expect(out).toBe(`StaticText "${"x".repeat(AX_NAME_CHAR_CAP)}…"`);
    expect(out.length).toBeLessThan(long.length);
  });

  it("is far smaller than the JSON encoding it replaces", () => {
    const tree = {
      role: "WebArea",
      name: "Billing",
      children: Array.from({ length: 50 }, (_, i) => ({
        role: "button",
        name: `Action ${i}`,
      })),
    };
    // The documented ratio is ~56% of the JSON characters; assert the claim,
    // not the near-tautology that it is merely shorter.
    expect(serializeAxTree(tree).length).toBeLessThan(
      0.6 * JSON.stringify(tree).length,
    );
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
