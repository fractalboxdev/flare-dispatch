import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sections } from "../src/lib/nav.mjs";
import { PAGES, SPECS_DIR, pageFrontmatter, pageHref, REPO, REPO_URL, siteSidebar } from "../src/lib/pages.mjs";
import { areaFiles, linkTarget, pageId, sidebarLabelOf, specId, titleOf } from "../src/lib/specs.mjs";

const files = new Set(["spend.md", "README.md", "roadmap.md", "runs/gate.md", "adr/README.md", "adr/0001-a.md"]);
const exists = (rel: string): boolean => files.has(rel);
const readme = readFileSync(join(SPECS_DIR, "README.md"), "utf8");
const ids = [...PAGES.values()];

describe("pageId", () => {
  it("maps a file under specs/ to its content id", () => {
    expect(specId("spend.md")).toBe("specs/spend");
    expect(specId("runs/gate.md")).toBe("specs/runs/gate");
    expect(specId("adr/0001-a.md")).toBe("specs/adr/0001-a");
  });
  it("maps a README to its directory's index", () => {
    expect(specId("README.md")).toBe("specs");
    expect(specId("adr/README.md")).toBe("specs/adr");
    expect(pageId("docs/runs", "README.md")).toBe("docs/runs");
  });
});

describe("titleOf", () => {
  it("takes the first first-level heading without code ticks", () => {
    expect(titleOf("intro\n\n# ADR-0009: Leases; `restart` by default\n\n## Status")).toBe(
      "ADR-0009: Leases; restart by default",
    );
  });
  it("returns undefined without a first-level heading", () => {
    expect(titleOf("## Only a section")).toBeUndefined();
  });
});

describe("pageFrontmatter", () => {
  it("takes the title and description of a specification file and marks it as v2", () => {
    const data = pageFrontmatter({}, join(SPECS_DIR, "roadmap.md"), "specs/roadmap");
    expect(data.title).toBe("Roadmap");
    expect(data.description).toMatch(/^FlareDispatch ships in five phases/);
    expect(data.banner?.content).toContain("/docs/v2/");
  });
  it("gives a page under /docs/ no banner", () => {
    const data = pageFrontmatter({}, join(REPO, "runs/README.md"), "docs/runs");
    expect(data.title).toBe("FlareDispatch run catalog");
    expect(data.banner).toBeUndefined();
  });
  it("throws for a file with neither a title nor a heading", () => {
    expect(() => pageFrontmatter({}, undefined, "docs/x")).toThrow("no first-level heading");
  });
});

describe("sidebarLabelOf", () => {
  it("keeps an ADR's number and drops its prefix", () => {
    expect(sidebarLabelOf("specs/adr/0001-a", "ADR-0001: A title")).toBe("0001 · A title");
  });
  it("labels the two specification index pages", () => {
    expect(sidebarLabelOf("specs", "FlareDispatch specifications")).toBe("Glossary and index");
    expect(sidebarLabelOf("specs/adr", "Architecture decision records")).toBe("Decision index");
  });
  it("keeps any other title", () => {
    expect(sidebarLabelOf("specs/spend", "Spend")).toBe("Spend");
  });
});

describe("linkTarget", () => {
  it("points a sibling link at the sibling's route", () => {
    expect(linkTarget("spend.md", "roadmap.md", exists)).toEqual({ href: "/specs/spend/" });
  });
  it("keeps the anchor", () => {
    expect(linkTarget("spend.md#scope", "roadmap.md", exists)).toEqual({ href: "/specs/spend/#scope" });
  });
  it("resolves a parent link from an ADR and from a run specification", () => {
    expect(linkTarget("../spend.md", "adr/0001-a.md", exists)).toEqual({ href: "/specs/spend/" });
    expect(linkTarget("../adr/0001-a.md", "runs/gate.md", exists)).toEqual({ href: "/specs/adr/0001-a/" });
  });
  it("resolves a child link and a README link", () => {
    expect(linkTarget("adr/0001-a.md", "spend.md", exists)).toEqual({ href: "/specs/adr/0001-a/" });
    expect(linkTarget("README.md", "adr/0001-a.md", exists)).toEqual({ href: "/specs/adr/" });
    expect(linkTarget("adr/", "spend.md", exists)).toEqual({ href: "/specs/adr/" });
  });
  it("leaves external links and same-page anchors unchanged", () => {
    expect(linkTarget("https://example.com/x.md", "spend.md", exists)).toEqual({ href: "https://example.com/x.md" });
    expect(linkTarget("#scope", "spend.md", exists)).toEqual({ href: "#scope" });
  });
  it("reports a missing file", () => {
    expect(linkTarget("missing.md", "spend.md", exists)).toHaveProperty("error");
  });
  it("reports a link that leaves specs/", () => {
    expect(linkTarget("../README.md", "spend.md", exists)).toHaveProperty("error");
  });
  it("reports a site path", () => {
    expect(linkTarget("/docs/spend/", "roadmap.md", exists)).toHaveProperty("error");
  });
});

describe("pageHref", () => {
  const guide = join(REPO, "apps/docs/substrate/facade.md");
  it("points a link to a mounted file at its page", () => {
    expect(pageHref("grant-profiles.md#anchor", guide)).toEqual({ href: "/docs/substrate/grant-profiles/#anchor" });
    expect(pageHref("../reference/substrate-contract/README.md", guide)).toEqual({
      href: "/docs/reference/substrate-contract/",
    });
    expect(pageHref("../../../actions/flare-dispatch-action/", guide)).toEqual({
      href: "/docs/actions/flare-dispatch-action/",
    });
  });
  it("points a link to another repository file at GitHub", () => {
    expect(pageHref("../../../package.json", guide)).toEqual({ href: `${REPO_URL}/blob/main/package.json` });
  });
  it("reports a missing file and a link that leaves the repository", () => {
    expect(pageHref("missing.md", guide)).toHaveProperty("error");
    expect(pageHref("../../../../outside.md", guide)).toHaveProperty("error");
  });
});

describe("areaFiles", () => {
  it("reads the index table in order and leaves the roadmap out", () => {
    const areas = areaFiles(readme);
    expect(areas[0]).toBe("architecture.md");
    expect(areas).toContain("runs/gate.md");
    expect(areas).not.toContain("roadmap.md");
  });
});

describe("sections", () => {
  it("places every page exactly once", () => {
    const placed = sections(readme, ids).flatMap((s) => s.ids);
    expect(new Set(placed).size).toBe(placed.length);
    expect([...placed].sort()).toEqual([...ids].sort());
  });
  it("places every Markdown file under specs/", () => {
    const specFiles = readdirSync(SPECS_DIR, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".md"));
    const placed = new Set(sections(readme, ids).flatMap((s) => s.ids));
    expect(specFiles.length).toBeGreaterThan(0);
    for (const file of specFiles) expect(placed).toContain(specId(file));
  });
  it("throws for a page in no section", () => {
    expect(() => sections(readme, [...ids, "specs/unlisted"])).toThrow("pages outside the sidebar: specs/unlisted");
    expect(() => sections(readme, [...ids, "docs/unlisted"])).toThrow("pages outside the sidebar: docs/unlisted");
  });
  it("throws when the index table names a missing file", () => {
    expect(() => sections(readme, ids.filter((id) => id !== "specs/spend"))).toThrow(
      "sidebar names missing pages: specs/spend",
    );
  });
});

describe("siteSidebar", () => {
  it("has one group per area", () => {
    expect(siteSidebar().map((g) => g.label)).toEqual(["Documentation", "Specifications"]);
  });
  it("starts the specifications with the index and the decision records with their index", () => {
    const specs = siteSidebar()[1]?.items ?? [];
    expect(specs.map((i) => i.label)).toEqual([
      "Glossary and index",
      "Areas",
      "Roadmap",
      "Decision records",
    ]);
    const adrs = specs[3];
    expect(adrs && "items" in adrs ? adrs.items.slice(0, 2).map((i) => i.slug) : []).toEqual([
      "specs/adr",
      "specs/adr/0001-local-first-control-plane",
    ]);
  });
});

describe("_redirects", () => {
  const rules = readFileSync(join(REPO, "apps/docs/public/_redirects"), "utf8")
    .split("\n")
    .filter((l) => l !== "" && !l.startsWith("#"))
    .map((l) => l.split(/\s+/) as [string, string, string]);

  it("sends each old specification path to its page under /specs/", () => {
    const to = new Map(rules.map(([from, target]) => [from, target]));
    for (const file of [...areaFiles(readme), "roadmap.md"]) {
      const page = specId(file).replace(/^specs\//, "");
      expect(to.get(`/docs/${page}/`)).toBe(`/specs/${page}/`);
    }
    expect(to.get("/docs/adr/*")).toBe("/specs/adr/:splat");
  });
  it("names no page: Workers static assets apply a redirect before asset lookup", () => {
    for (const [from] of rules) {
      const match = from.endsWith("*")
        ? (path: string) => path.startsWith(from.slice(0, -1))
        : (path: string) => path === from;
      expect(ids.map((id) => `/${id}/`).filter(match)).toEqual([]);
    }
  });
});
