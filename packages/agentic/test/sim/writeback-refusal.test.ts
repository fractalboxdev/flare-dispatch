// The writeback-refusal scenario over 100 seeds plus every kept seed (specs/verification.md § V-SIM, FD-VER-024).
// `SIM_SEEDS` sets the seed count, as the nightly run does with 10,000.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { refusalReason } from "../../src/staged-write/manifest.ts";
import { expectedReasons, plan, runScenario, SCENARIO } from "./writeback-refusal.sim.ts";

const SEEDS_FILE = fileURLToPath(new URL("./seeds.jsonl", import.meta.url));
const kept = existsSync(SEEDS_FILE)
  ? readFileSync(SEEDS_FILE, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as { scenario: string; seed: number })
      .filter((k) => k.scenario === SCENARIO)
      .map((k) => k.seed)
  : [];
const count = Number(process.env["SIM_SEEDS"] ?? 100);
const seeds = [...new Set([...Array.from({ length: count }, (_, i) => i + 1), ...kept])];

/** The text of each list item in the page's reason lists, unescaped. */
const listed = (page: string) =>
  [...page.matchAll(/<li class="mono">([^<]*)<\/li>/g)].map((m) =>
    m[1]!
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, "&"),
  );

/** The GitHub calls that write; a refused row makes none. */
const WRITES = new Set([
  "createBlob",
  "createTree",
  "createCommit",
  "createRef",
  "updateRef",
  "createPull",
  "updatePull",
  "addLabels",
  "closePull",
]);

/** One reason as `refusalReason` lists it. */
const text = (r: Parameters<typeof refusalReason>[0][number]) => refusalReason([r]).split("; ")[1]!;

describe("writeback-refusal simulation", () => {
  it("[FD-AGT-018] a rejected staged write ends its pr.propose row refused with every gate reason, the page lists each one, and the verdict stays success (MAMEKO-OUT-015)", async () => {
    const outcomes = new Set<string>();
    const reached = new Set<string>();
    for (const seed of seeds) {
      const p = plan(seed);
      const reasons = expectedReasons(p);
      const o = await runScenario(seed);
      const at = `seed ${seed}`;
      expect(reasons.length, at).toBeGreaterThan(0);
      expect(o.verdict, at).toBe("success");
      expect(
        o.githubCalls.filter((c) => WRITES.has(c)),
        at,
      ).toEqual([]);
      outcomes.add(o.rowState);
      // A lookup follows only a claim whose answer a D1 failure lost; a second base read only a GitHub 502.
      if (o.githubCalls.includes("refSha")) reached.add("d1-lost-answer");
      if (o.githubCalls.filter((c) => c === "fileAt").length > 1) reached.add("github-502");
      if (p.artifactOutages === Number.POSITIVE_INFINITY) {
        expect(o.rowState, at).toBe("expired");
        expect(o.lastError, at).toBe("writeback: read artifacts");
        expect(o.page, at).toContain('<td class="notify">expired</td>');
        continue;
      }
      expect(o.rowState, at).toBe("refused");
      expect(o.lastError, at).toBe(refusalReason(reasons));
      expect(o.page, at).toContain('<td class="notify">refused</td>');
      expect(o.page, at).toContain(`writeback: ${reasons[0]!.kind}<ul`);
      expect(listed(o.page), at).toEqual(reasons.map(text));
    }
    if (count >= 100) {
      expect([...outcomes].sort()).toEqual(["expired", "refused"]);
      expect([...reached].sort()).toEqual(["d1-lost-answer", "github-502"]);
    }
  }, 120_000);
});
