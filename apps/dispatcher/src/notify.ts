// FlareDispatch Dispatcher — completion-notify email rendering.
//
// `renderResultEmail` turns an execution's terminal state — run name, verdict,
// repo/sha, the Cloudflare Workflows details link, and the run's *output*
// object — into the `{ subject, html, text }` the `email` capability sends to
// the dispatch's `notify.emails` list. The output object is where a run's
// shareable results live: `playwright-demo` returns `videoUri` + `logUri`,
// `deploy-smoke` a target URL, `offload-test` a `logUri`. Any output field
// whose value is an `http(s)` URL is rendered as a clickable link (artifact /
// demo / log), so a stakeholder clicks straight through from the email.
//
// Rendering is pure + dependency-free (no MIME — the `send_email` binding
// builds that) and HTML-escapes every interpolated value: a run's output is
// caller-influenced data, so a `<script>`-bearing field must not execute in a
// webmail client.
//
// Spec: specs/04-gha-integration.md § Notifications.

/** The terminal verdict — mirrors the GitHub check-run conclusion family. */
type NotifyStatus = "success" | "failure";

export type RenderResultEmailInput = {
  readonly run: string;
  readonly status: NotifyStatus;
  readonly executionId: string;
  readonly repo: string;
  readonly sha: string;
  /** Cloudflare Workflows instance page, when `CLOUDFLARE_ACCOUNT_ID` is set. */
  readonly detailsUrl?: string;
  /**
   * The token-gated product-demo viewer page (`/demos/:execution?t=…`) — the
   * hero replay + per-chapter gallery. Set only for a successful `product-demo`
   * run (a failed run persists no `summary_json` for the page to render).
   * Rendered as a prominent call-to-action at the top of the email so a
   * stakeholder lands on the watchable gallery in one click, rather than
   * scanning per-chapter links in the Results table. Ignored when absent.
   */
  readonly demoUrl?: string;
  /**
   * The run's output object (the `Exit` success value), or `undefined` on a
   * failed run (no output produced). Rendered as a labelled link/value table.
   */
  readonly output?: unknown;
  /**
   * Run-authored failure markdown (`AcceptanceFailed.summaryMd` — the same
   * text the check-run failure summary embeds, issue #85). Rendered escaped
   * inside a `<pre>` block on the failure branch only; ignored on success.
   */
  readonly failureDisplay?: string;
};

export type RenderedEmail = {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
};

/** Minimal HTML-escape for interpolated text + attribute values. */
const esc = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/** An `http(s)` URL is the only value we turn into a link. */
const isHttpUrl = (v: unknown): v is string =>
  typeof v === "string" && /^https?:\/\//.test(v);

/**
 * Humanize an output key for a label: `videoUri` → "Video", `logUri` → "Log",
 * `previewUrl` → "Preview", `exitCode` → "Exit code".
 */
const humanizeKey = (key: string): string => {
  const stripped = key.replace(/(Uri|Url)$/i, "");
  const spaced = stripped
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
  if (spaced.length === 0) return key;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
};

/**
 * True when a value is a non-empty array of plain objects — a run's per-item
 * results (e.g. `product-demo`'s `stories`). Rendered as nested per-item
 * blocks so each item's links (replay, screenshot) arrive CLICKABLE in the
 * email instead of buried in one escaped JSON blob nobody can click through.
 */
const isObjectArray = (v: unknown): v is Record<string, unknown>[] =>
  Array.isArray(v) &&
  v.length > 0 &&
  v.every((x) => x !== null && typeof x === "object" && !Array.isArray(x));

/** Cap on rendered array items — this is an email, not a data export. */
const MAX_ARRAY_ITEMS = 20;

/**
 * Output keys suppressed from the rendered email — raw-data escape hatches, not
 * stakeholder-facing links. `replayJsonUri` is the signed R2 URL to the raw
 * rrweb event JSON (product-demo): a power-user self-host hatch. The human-facing
 * `replayUri` (the player page) and the watch-the-demo CTA already carry a
 * reviewer to the watchable replay, so surfacing the raw JSON as a "Replay Json"
 * row only clutters the inbox with a link nobody clicks. Applied at both the
 * top-level output table and per-item (`stories`) blocks, in HTML and text.
 */
const SKIP_OUTPUT_KEYS = new Set<string>(["replayJsonUri"]);

/** Render a single output value to an HTML cell. */
const valueCellHtml = (value: unknown): string => {
  if (isHttpUrl(value)) {
    return `<a href="${esc(value)}">${esc(value)}</a>`;
  }
  if (typeof value === "string") return esc(value);
  if (typeof value === "number" || typeof value === "boolean") {
    return esc(String(value));
  }
  if (isObjectArray(value)) return objectArrayHtml(value);
  return `<code>${esc(JSON.stringify(value))}</code>`;
};

/** Nested per-item blocks for an array-of-objects output value. A `name`
 * field becomes the item heading; empty-string fields are noise and skipped. */
const objectArrayHtml = (items: readonly Record<string, unknown>[]): string =>
  items
    .slice(0, MAX_ARRAY_ITEMS)
    .map((item) => {
      const title = typeof item["name"] === "string" ? item["name"] : "";
      const rows = Object.entries(item)
        .filter(([k, v]) => k !== "name" && v !== "" && !SKIP_OUTPUT_KEYS.has(k))
        .map(
          ([k, v]) =>
            `<tr><td style="padding:2px 10px 2px 0;color:#57606a;vertical-align:top;">${esc(humanizeKey(k))}</td><td style="padding:2px 0;">${valueCellHtml(v)}</td></tr>`,
        )
        .join("");
      return `<div style="margin:0 0 10px;">${
        title === ""
          ? ""
          : `<div style="font-weight:600;margin-bottom:2px;">${esc(title)}</div>`
      }<table style="border-collapse:collapse;font-size:13px;">${rows}</table></div>`;
    })
    .join("");

/** Flatten an output object into ordered `[label, value]` rows. */
const outputRows = (output: unknown): readonly [string, unknown][] => {
  if (output === null || typeof output !== "object" || Array.isArray(output)) {
    return [];
  }
  return Object.entries(output as Record<string, unknown>)
    .filter(([k]) => !SKIP_OUTPUT_KEYS.has(k))
    .map(([k, v]) => [humanizeKey(k), v] as const);
};

const statusBadge = (status: NotifyStatus): { label: string; color: string } =>
  status === "success"
    ? { label: "✓ Succeeded", color: "#1a7f37" }
    : { label: "✗ Failed", color: "#cf222e" };

/**
 * For runs whose output carries a per-item `stories` array (`product-demo`),
 * a bare "succeeded" hides partial success: a 3/5 run reads identically to a
 * clean 5/5 in the inbox, even though two chapters failed. Derive the
 * passed/total tally so the subject can lead with the overall status ("3/5
 * passed") instead. Returns `undefined` for runs with no `stories` array — their
 * subject is left unchanged.
 */
const storyTally = (
  output: unknown,
): { passed: number; total: number } | undefined => {
  if (output === null || typeof output !== "object" || Array.isArray(output)) {
    return undefined;
  }
  const stories = (output as Record<string, unknown>)["stories"];
  if (!isObjectArray(stories)) return undefined;
  const passed = stories.filter((s) => s["status"] === "passed").length;
  return { passed, total: stories.length };
};

export const renderResultEmail = (
  input: RenderResultEmailInput,
): RenderedEmail => {
  const badge = statusBadge(input.status);
  const rows = input.status === "success" ? outputRows(input.output) : [];
  // The run-authored failure markdown, failure branch only. Caller-influenced
  // text — always escaped, shown as-is in a <pre> (no markdown rendering in
  // email; the verbatim table/text is still far more useful than the generic
  // "no output" line it replaces).
  const failureDisplay =
    input.status === "failure" &&
    input.failureDisplay !== undefined &&
    input.failureDisplay.trim() !== ""
      ? input.failureDisplay
      : undefined;

  // Lead the subject with the overall status. For a `stories`-bearing run a
  // partial pass still resolves to `success` (product-demo only fails when
  // ZERO chapters pass), so surface the passed/total tally — "3/5 passed" —
  // rather than a flat "succeeded" that hides the two that didn't.
  const tally = input.status === "success" ? storyTally(input.output) : undefined;
  const verdict =
    tally !== undefined
      ? `✓ ${tally.passed}/${tally.total} passed`
      : input.status === "success"
        ? "✓ succeeded"
        : "✗ failed";
  const subject = `[FlareDispatch] ${input.run} — ${verdict}`;

  // --- HTML body --------------------------------------------------------------
  const metaRows: [string, string][] = [
    ["Run", input.run],
    ["Repository", input.repo],
    ["Commit", input.sha],
    ["Execution", input.executionId],
  ];
  const metaHtml = metaRows
    .map(
      ([k, v]) =>
        `<tr><td style="padding:4px 12px 4px 0;color:#57606a;">${esc(k)}</td><td style="padding:4px 0;"><code>${esc(v)}</code></td></tr>`,
    )
    .join("");

  const resultsHtml =
    rows.length > 0
      ? `<h3 style="margin:20px 0 8px;font-size:15px;">Results</h3><table style="border-collapse:collapse;font-size:14px;">${rows
          .map(
            ([label, value]) =>
              `<tr><td style="padding:4px 12px 4px 0;color:#57606a;vertical-align:top;">${esc(label)}</td><td style="padding:4px 0;">${valueCellHtml(value)}</td></tr>`,
          )
          .join("")}</table>`
      : input.status === "failure"
        ? failureDisplay !== undefined
          ? `<h3 style="margin:20px 0 8px;font-size:15px;">Failure summary</h3><pre style="margin:0;padding:12px;background:#f6f8fa;border-radius:6px;font-size:13px;white-space:pre-wrap;overflow-wrap:anywhere;">${esc(failureDisplay)}</pre>`
          : `<p style="font-size:14px;color:#57606a;">The run failed before producing output.${
              input.detailsUrl !== undefined
                ? ` See the <a href="${esc(input.detailsUrl)}">step logs</a> for the cause.`
                : ""
            }</p>`
        : "";

  const detailsHtml =
    input.detailsUrl !== undefined
      ? `<p style="margin:16px 0 0;font-size:14px;"><a href="${esc(input.detailsUrl)}">View step logs in Cloudflare →</a></p>`
      : "";

  // Prominent watch-the-demo call-to-action — only for a successful run that
  // carries a viewer URL (product-demo). A button-styled anchor placed above
  // the Results table so it's the first thing a stakeholder clicks.
  const demoCtaHtml =
    input.status === "success" && isHttpUrl(input.demoUrl)
      ? `<p style="margin:16px 0 4px;"><a href="${esc(input.demoUrl)}" style="display:inline-block;padding:10px 18px;border-radius:6px;background:#1f6feb;color:#fff;font-size:14px;font-weight:600;text-decoration:none;">▶ Watch the product demo</a></p>`
      : "";

  const html = `<!DOCTYPE html><html><body style="margin:0;padding:24px;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1f2328;">
<table style="max-width:600px;border-collapse:collapse;">
<tr><td>
<span style="display:inline-block;padding:4px 10px;border-radius:6px;background:${badge.color};color:#fff;font-size:13px;font-weight:600;">${esc(badge.label)}</span>
<h2 style="margin:12px 0 4px;font-size:18px;">${esc(input.run)}</h2>
<table style="border-collapse:collapse;font-size:14px;margin-top:8px;">${metaHtml}</table>
${demoCtaHtml}
${resultsHtml}
${detailsHtml}
<p style="margin:24px 0 0;font-size:12px;color:#8c959f;">Sent by FlareDispatch.</p>
</td></tr>
</table>
</body></html>`;

  // --- Plain-text alternative -------------------------------------------------
  const textLines: string[] = [
    `FlareDispatch — ${input.run} — ${input.status === "success" ? "SUCCEEDED" : "FAILED"}`,
    "",
    `Repository: ${input.repo}`,
    `Commit:     ${input.sha}`,
    `Execution:  ${input.executionId}`,
  ];
  if (input.status === "success" && isHttpUrl(input.demoUrl)) {
    textLines.push("", `▶ Watch the product demo: ${input.demoUrl}`);
  }
  if (rows.length > 0) {
    textLines.push("", "Results:");
    for (const [label, value] of rows) {
      if (isObjectArray(value)) {
        // Per-item breakdown — one indented block per item, links on their
        // own lines so text-mode clients still get clickable URLs.
        textLines.push(`  ${label}:`);
        for (const item of value.slice(0, MAX_ARRAY_ITEMS)) {
          const title = typeof item["name"] === "string" ? item["name"] : "-";
          textLines.push(`    ${title}`);
          for (const [k, v] of Object.entries(item)) {
            if (k === "name" || v === "" || SKIP_OUTPUT_KEYS.has(k)) continue;
            textLines.push(
              `      ${humanizeKey(k)}: ${typeof v === "object" && v !== null ? JSON.stringify(v) : String(v)}`,
            );
          }
        }
        continue;
      }
      textLines.push(
        `  ${label}: ${typeof value === "object" && value !== null ? JSON.stringify(value) : String(value)}`,
      );
    }
  } else if (input.status === "failure") {
    if (failureDisplay !== undefined) {
      textLines.push("", "Failure summary:", "", failureDisplay);
    } else {
      textLines.push("", "The run failed before producing output.");
    }
  }
  if (input.detailsUrl !== undefined) {
    textLines.push("", `Step logs: ${input.detailsUrl}`);
  }
  const text = textLines.join("\n");

  return { subject, html, text };
};
