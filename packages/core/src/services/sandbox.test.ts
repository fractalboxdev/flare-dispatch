// `flattenCommand` — the argv → shell-string boundary every container runtime
// executes through.
//
// The regression these lock down was live in production: an unquoted
// `join(" ")` re-split a `["sh", "-lc", script]` call on the script's own
// spaces, so `sh` received the script's FIRST WORD as its `-c` argument and the
// rest as positional args. Every run that passes a shell script — spec-drift,
// release-notes, self-heal, refresh-fixtures, org-spec-audit — was affected,
// and the symptom looked like the command misbehaving rather than a quoting
// bug.

import { describe, expect, it } from "vitest";
import { flattenCommand } from "./sandbox";

describe("flattenCommand", () => {
  it("passes a string command through untouched", () => {
    expect(flattenCommand("pnpm build && wrangler deploy")).toBe("pnpm build && wrangler deploy");
  });

  it("keeps a shell script as ONE argument to sh -lc", () => {
    const script = `for f in $(git ls-files 'specs/*.md'); do cat "$f"; done`;
    const flat = flattenCommand(["sh", "-lc", script]);
    expect(flat.startsWith("sh -lc '")).toBe(true);
    // The script's own single quotes are escaped out and back in, so what `sh`
    // receives as its `-c` argument is the script verbatim.
    expect(flat).toContain(`$(git ls-files '\\''specs/*.md'\\'')`);
    expect(flat).toContain(`do cat "$f"; done'`);
  });

  it("keeps flag values containing spaces together", () => {
    expect(flattenCommand(["sh", "-lc", 'git log --since="26 hours ago"'])).toBe(
      `sh -lc 'git log --since="26 hours ago"'`,
    );
  });

  it("leaves ordinary argv bare so logs stay readable", () => {
    expect(flattenCommand(["flare-agent", "heal", "--pack", "/tmp/pack.json"])).toBe(
      "flare-agent heal --pack /tmp/pack.json",
    );
    // Braces are not on the safe list, so this one is quoted — harmless for
    // curl, and the conservative direction to be wrong in.
    expect(flattenCommand(["curl", "-sS", "-w", "%{http_code}"])).toBe(
      "curl -sS -w '%{http_code}'",
    );
  });

  it("escapes an embedded single quote rather than ending the quoting early", () => {
    const flat = flattenCommand(["sh", "-lc", `echo 'hi'`]);
    expect(flat).toBe(`sh -lc 'echo '\\''hi'\\'''`);
    // The closing quote count is what matters: an unbalanced result would run
    // as a different command entirely.
    expect((flat.match(/'/g) ?? []).length % 2).toBe(0);
  });

  it("quotes an empty argument instead of dropping it", () => {
    expect(flattenCommand(["cmd", "", "next"])).toBe("cmd '' next");
  });
});
