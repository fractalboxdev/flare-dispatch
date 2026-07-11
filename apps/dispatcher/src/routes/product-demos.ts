// FlareDispatch Dispatcher — `GET /demos/:execution?t=<token>`.
//
// A self-contained product-demo viewer: ONE hero (the interactive rrweb replay
// of the demo's primary chapter, embedded in an iframe) over a gallery of
// CHAPTERS — each its own animated GIF, name, pass/fail badge, the LLM-written
// narrative ("brief description"), and a deep link to scrub that chapter's full
// replay.
//
// Data source: the execution's `summary_json` (the `product-demo` run's typed
// Output — `replayUri`, `stories[]` with per-chapter `chapterGifUri` /
// `keyScreenshotUri` / `narrative` / `replayUri`). The GIFs + screenshots are
// served openly by the `/v1/artifacts/...` route (the same as the PR-embedded
// `demo.gif`); only THIS page is gated, via the per-execution capability token
// (`?t=`) shared with the log viewer — so the page never enumerates and a link
// stays scoped to one demo.

import type { Env } from "../env";
import { getExecution } from "../executions-read";
import { gateLogAccess } from "../log-auth";

const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/** One chapter, as the `product-demo` run shapes it in `stories[]`. */
type Chapter = {
  readonly name: string;
  readonly status: "passed" | "failed";
  readonly narrative: string;
  readonly chapterGifUri?: string;
  readonly keyScreenshotUri?: string;
  readonly replayUri?: string;
};

type DemoSummary = {
  readonly replayUri?: string;
  readonly summaryMd?: string;
  readonly gifUri?: string;
  readonly stories: readonly Chapter[];
};

/** Coerce one untrusted `stories[]` element into a `Chapter` (strings only). */
const toChapter = (raw: unknown): Chapter | null => {
  if (raw === null || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const str = (v: unknown): string | undefined =>
    typeof v === "string" && v !== "" ? v : undefined;
  const name = str(o["name"]) ?? "(unnamed chapter)";
  return {
    name,
    status: o["status"] === "passed" ? "passed" : "failed",
    narrative: str(o["narrative"]) ?? "",
    ...(str(o["chapterGifUri"]) !== undefined
      ? { chapterGifUri: str(o["chapterGifUri"])! }
      : {}),
    ...(str(o["keyScreenshotUri"]) !== undefined
      ? { keyScreenshotUri: str(o["keyScreenshotUri"])! }
      : {}),
    ...(str(o["replayUri"]) !== undefined
      ? { replayUri: str(o["replayUri"])! }
      : {}),
  };
};

/** Parse the stored `summary_json` into the shape this page renders. */
const parseDemoSummary = (summaryJson: string): DemoSummary | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(summaryJson);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const o = parsed as Record<string, unknown>;
  if (!Array.isArray(o["stories"])) return null;
  const stories = o["stories"].map(toChapter).filter((c): c is Chapter => c !== null);
  return {
    ...(typeof o["replayUri"] === "string" ? { replayUri: o["replayUri"] } : {}),
    ...(typeof o["summaryMd"] === "string" ? { summaryMd: o["summaryMd"] } : {}),
    ...(typeof o["gifUri"] === "string" ? { gifUri: o["gifUri"] } : {}),
    stories,
  };
};

const STYLE = `
  *{box-sizing:border-box}
  html,body{margin:0;background:#0d1117;color:#c9d1d9;font:15px/1.5 -apple-system,system-ui,sans-serif}
  a{color:#58a6ff;text-decoration:none}
  a:hover{text-decoration:underline}
  header{padding:14px 20px;border-bottom:1px solid #21262d;display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
  header b{color:#58a6ff;font-size:16px}
  header .meta{color:#8b949e;font-size:13px}
  main{max-width:1180px;margin:0 auto;padding:20px}
  h2{font-size:18px;margin:28px 0 14px;border-bottom:1px solid #21262d;padding-bottom:8px}
  figure.hero{margin:0}
  .hero .stage{position:relative;width:100%;aspect-ratio:16/9;background:#010409;border:1px solid #21262d;border-radius:10px;overflow:hidden}
  .hero iframe{position:absolute;inset:0;width:100%;height:100%;border:0}
  .hero .placeholder{display:flex;align-items:center;justify-content:center;height:100%;color:#8b949e;text-align:center;padding:20px}
  .hero figcaption{color:#8b949e;font-size:13px;margin-top:8px}
  .hero figcaption b{color:#c9d1d9}
  .chapters{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:16px}
  .card{background:#161b22;border:1px solid #21262d;border-radius:10px;overflow:hidden;display:flex;flex-direction:column;transition:border-color .15s,box-shadow .15s}
  .card.clickable{cursor:pointer}
  .card.clickable:hover{border-color:#58a6ff}
  .card.active{border-color:#58a6ff;box-shadow:0 0 0 1px #58a6ff}
  .card .frame{position:relative;aspect-ratio:16/9;background:#010409;display:flex;align-items:center;justify-content:center;overflow:hidden}
  .card .frame img{width:100%;height:100%;object-fit:cover;display:block}
  .card .frame .none{color:#6e7681;font-size:13px}
  .card.clickable .frame::after{content:"▶ play in viewer";position:absolute;inset:auto 0 0 0;padding:4px 8px;font-size:11px;background:rgba(1,4,9,.7);color:#58a6ff;opacity:0;transition:opacity .15s}
  .card.clickable:hover .frame::after,.card.active .frame::after{opacity:1}
  .card.active .frame::after{content:"▶ now playing"}
  .card .body{padding:12px 14px;display:flex;flex-direction:column;gap:8px}
  .card .title{display:flex;align-items:center;gap:8px;font-weight:600}
  .card .num{color:#6e7681;font-variant-numeric:tabular-nums}
  .badge{font-size:11px;font-weight:600;padding:1px 8px;border-radius:999px;white-space:nowrap}
  .badge.pass{background:#1a3326;color:#3fb950;border:1px solid #238636}
  .badge.fail{background:#3a1a1d;color:#f85149;border:1px solid #da3633}
  .card .desc{color:#adbac7;font-size:13.5px;margin:0}
  .card .links{margin-top:auto;font-size:13px}
  .empty{padding:48px 20px;text-align:center;color:#8b949e}
`;

const heroSection = (
  replayUri: string | undefined,
  activeName: string | undefined,
): string => {
  if (replayUri === undefined || replayUri === "") {
    return `<figure class="hero"><div class="stage"><div class="placeholder">No replay was recorded for this demo. Browse the chapters below.</div></div></figure>`;
  }
  // The replay page is same-origin (the run's `docsBase` points at this
  // Worker), so the iframe embed loads without a frame-ancestors fight. The
  // iframe is ONE player; clicking a chapter below swaps its `src` (see the
  // page script) so the gallery drives a single hero, not N detached tabs.
  return `<figure class="hero">
  <div class="stage"><iframe id="hero" src="${escapeHtml(
    replayUri,
  )}" title="Product demo replay" allow="autoplay" loading="lazy"></iframe></div>
  <figcaption>Now playing: <b id="hero-cap">${escapeHtml(
    activeName ?? "walkthrough",
  )}</b> — pick a chapter below to jump the player.</figcaption>
</figure>`;
};

const chapterCard = (
  c: Chapter,
  i: number,
  activeReplay: string | undefined,
): string => {
  const media =
    c.chapterGifUri !== undefined
      ? `<img src="${escapeHtml(c.chapterGifUri)}" alt="${escapeHtml(
          c.name,
        )} walkthrough" loading="lazy">`
      : c.keyScreenshotUri !== undefined
        ? `<img src="${escapeHtml(c.keyScreenshotUri)}" alt="${escapeHtml(
            c.name,
          )} screenshot" loading="lazy">`
        : `<span class="none">no preview captured</span>`;
  const badge =
    c.status === "passed"
      ? `<span class="badge pass">✔ pass</span>`
      : `<span class="badge fail">✕ fail</span>`;
  const desc =
    c.narrative !== ""
      ? `<p class="desc">${escapeHtml(c.narrative)}</p>`
      : "";
  // A chapter with a replay is clickable — clicking loads it into the single
  // hero player (the page script reads `data-replay` / `data-name`). The
  // secondary link opens the same replay full-screen in a new tab.
  const hasReplay = c.replayUri !== undefined;
  const isActive = hasReplay && c.replayUri === activeReplay;
  const dataAttrs = hasReplay
    ? ` data-replay="${escapeHtml(c.replayUri!)}" data-name="${escapeHtml(
        c.name,
      )}"`
    : "";
  const link = hasReplay
    ? `<div class="links"><a href="${escapeHtml(
        c.replayUri!,
      )}" target="_blank" rel="noopener" data-open>Open full-screen ↗</a></div>`
    : "";
  return `<article class="card${hasReplay ? " clickable" : ""}${
    isActive ? " active" : ""
  }"${dataAttrs}>
    <div class="frame">${media}</div>
    <div class="body">
      <div class="title"><span class="num">${i + 1}.</span><span>${escapeHtml(
        c.name,
      )}</span>${badge}</div>
      ${desc}
      ${link}
    </div>
  </article>`;
};

const page = (
  heading: string,
  meta: string,
  demo: DemoSummary,
): string => {
  const passed = demo.stories.filter((s) => s.status === "passed").length;
  // The hero opens on the run's primary replay; mark the matching chapter
  // active so the gallery and the player agree on first paint.
  const activeName = demo.stories.find(
    (s) => s.replayUri !== undefined && s.replayUri === demo.replayUri,
  )?.name;
  const chapters =
    demo.stories.length > 0
      ? `<div class="chapters">${demo.stories
          .map((c, i) => chapterCard(c, i, demo.replayUri))
          .join("\n")}</div>`
      : `<div class="empty">This demo recorded no chapters.</div>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(heading)} — product demo</title>
<style>${STYLE}</style></head>
<body>
<header><b>FlareDispatch</b> product demo <span class="meta">${escapeHtml(
    meta,
  )}</span></header>
<main>
  <h2>Walkthrough</h2>
  ${heroSection(demo.replayUri, activeName)}
  <h2>Chapters <span style="color:#8b949e;font-weight:400;font-size:14px">— ${passed}/${
    demo.stories.length
  } passed</span></h2>
  ${chapters}
</main>
<script>
  (function () {
    var hero = document.getElementById('hero');
    var cap = document.getElementById('hero-cap');
    if (!hero) return;
    document.querySelectorAll('.card.clickable').forEach(function (card) {
      card.addEventListener('click', function (e) {
        // Let the "Open full-screen ↗" link open its own tab.
        if (e.target.closest('[data-open]')) return;
        var uri = card.getAttribute('data-replay');
        if (!uri || hero.getAttribute('src') === uri) return;
        hero.setAttribute('src', uri);
        if (cap) cap.textContent = card.getAttribute('data-name') || 'chapter';
        document.querySelectorAll('.card.active').forEach(function (a) {
          a.classList.remove('active');
        });
        card.classList.add('active');
        hero.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });
  })();
</script>
</body></html>`;
};

const htmlResponse = (body: string, status = 200): Response =>
  new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      // The demo result is immutable once the execution completes; cache briefly.
      "cache-control": "private, max-age=300",
    },
  });

/**
 * `GET /demos/:execution` — the token-gated product-demo viewer. Reuses the
 * per-execution capability-token gate (`?t=`), then renders the execution's
 * `summary_json` as a hero replay + per-chapter GIF gallery.
 */
export const handleProductDemo = async (
  env: Env,
  executionId: string,
  url: URL,
): Promise<Response> => {
  const denied = await gateLogAccess(env, executionId, url);
  if (denied !== null) return denied;

  const row = await getExecution(env.RUNS_METADATA, executionId);
  if (row === null) {
    return htmlResponse(
      page("Not found", `no execution ${escapeHtml(executionId)}`, {
        stories: [],
      }),
      404,
    );
  }

  const meta = [row.run, row.repo, row.sha?.slice(0, 7)]
    .filter((s): s is string => typeof s === "string" && s !== "")
    .join(" · ");

  // The verdict-bearing `summary_json` is only persisted on a SUCCESSFUL exit
  // (the dispatcher discards it on failure), so a red demo has none — point the
  // viewer at the diagnostics instead of a blank gallery.
  const demo =
    row.summary_json !== null ? parseDemoSummary(row.summary_json) : null;
  if (demo === null) {
    return htmlResponse(
      `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>product demo — ${escapeHtml(executionId)}</title>
<style>${STYLE}</style></head><body>
<header><b>FlareDispatch</b> product demo <span class="meta">${escapeHtml(
        meta,
      )}</span></header>
<main><div class="empty">No demo result is available for this execution — it may have failed, or it isn't a <code>product-demo</code> run. Check the run logs for details.</div></main>
</body></html>`,
      404,
    );
  }

  return htmlResponse(page(executionId, meta, demo));
};
