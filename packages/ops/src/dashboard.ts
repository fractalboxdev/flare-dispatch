// The dashboard: the executions view and its JSON route (FD-OPS-068, FD-OPS-069), the execution page with its outbox
// rows and every refusal reason (FD-AGT-018, FD-AGT-038), the per-class overview with active alarms (FD-OPS-070) and
// the 28-day cache hit rate per cache tier and executor kind (FD-CACHE-090), and the fleet view (FD-OPS-071), read
// from the control plane's D1 tables. The queries name their columns; no route reads an execution's input payload or a
// secret. The renderers are pure.
import { refusalView } from "@fractalboxdev/flare-dispatch-agentic";
import { cacheHitRates, type HitRate } from "@fractalboxdev/flare-dispatch-cache/metrics";
import type { D1Like } from "@fractalboxdev/mameko-host-cloudflare/d1";
import { activeAlarms, type ActiveAlarm } from "./alarms.ts";

/** Page sizes of the executions view (FD-OPS-068). */
export const DEFAULT_PAGE = 50;
export const MAX_PAGE = 200;

/** The filters of the executions view. */
export interface ExecutionFilters {
  readonly run?: string;
  readonly repository?: string;
  readonly class?: string;
  readonly status?: string;
  readonly executorKind?: string;
}

/** One execution as the view shows it: never its inputs. */
export interface ExecutionRow {
  readonly id: string;
  readonly run: string;
  readonly repository: string;
  readonly class: string;
  readonly status: string;
  readonly reason: string | null;
  readonly enqueuedAt: number;
  readonly placement: string | null;
  readonly epoch: number | null;
  readonly executorId: string | null;
  readonly executorKind: string | null;
  readonly holdMicroUsd: number | null;
  readonly settledMicroUsd: number | null;
}

/** A page of executions with the keyset cursor of the next page. */
export interface ExecutionPage {
  readonly rows: readonly ExecutionRow[];
  readonly limit: number;
  readonly next: string | null;
}

/** The query's filters, page size and cursor from a URL; the size defaults to 50 and is capped at 200. */
export const parseExecutionQuery = (url: URL) => {
  const get = (k: string) => {
    const v = url.searchParams.get(k);
    return v === null || v === "" ? undefined : v;
  };
  const requested = Number(get("limit") ?? DEFAULT_PAGE);
  const limit =
    Number.isInteger(requested) && requested >= 1 ? Math.min(requested, MAX_PAGE) : DEFAULT_PAGE;
  const filters: ExecutionFilters = {
    ...(get("run") === undefined ? {} : { run: get("run")! }),
    ...(get("repository") === undefined ? {} : { repository: get("repository")! }),
    ...(get("class") === undefined ? {} : { class: get("class")! }),
    ...(get("status") === undefined ? {} : { status: get("status")! }),
    ...(get("executor_kind") === undefined ? {} : { executorKind: get("executor_kind")! }),
  };
  return { filters, limit, cursor: get("cursor") ?? null };
};

const encodeCursor = (r: ExecutionRow) => `${r.enqueuedAt}:${r.id}`;
const decodeCursor = (c: string): { at: number; id: string } | null => {
  const i = c.indexOf(":");
  const at = Number(c.slice(0, i));
  return i > 0 && Number.isInteger(at) ? { at, id: c.slice(i + 1) } : null;
};

/** The columns of one execution as the views show it, with its placement, executor and reservation. */
const EXECUTION_SELECT = `select e.id, e.run, e.scope_id, e.class, e.status, e.reason, e.enqueued_at,
              p.state as placement, p.epoch, p.executor_id, x.kind as executor_kind,
              r.hold_micro_usd, r.metered_micro_usd
       from executions e
       left join placements p on p.execution_id = e.id
       left join executors x on x.executor_id = p.executor_id
       left join reservations r on r.execution_id = e.id`;

const executionRowOf = (r: Record<string, unknown>): ExecutionRow => ({
  id: r["id"] as string,
  run: r["run"] as string,
  repository: r["scope_id"] as string,
  class: r["class"] as string,
  status: r["status"] as string,
  reason: (r["reason"] as string | null) ?? null,
  enqueuedAt: r["enqueued_at"] as number,
  placement: (r["placement"] as string | null) ?? null,
  epoch: (r["epoch"] as number | null) ?? null,
  executorId: (r["executor_id"] as string | null) ?? null,
  executorKind: (r["executor_kind"] as string | null) ?? null,
  holdMicroUsd: (r["hold_micro_usd"] as number | null) ?? null,
  settledMicroUsd: (r["metered_micro_usd"] as number | null) ?? null,
});

/** One page of executions, newest first, keyset-paged on (`enqueued_at`, `id`). */
export const listExecutions = async (
  db: D1Like,
  filters: ExecutionFilters,
  limit: number,
  cursor: string | null,
): Promise<ExecutionPage> => {
  const where: string[] = [];
  const args: unknown[] = [];
  const eq = (column: string, value: string | undefined) => {
    if (value === undefined) return;
    where.push(`${column} = ?`);
    args.push(value);
  };
  eq("e.run", filters.run);
  eq("e.scope_id", filters.repository);
  eq("e.class", filters.class);
  eq("e.status", filters.status);
  eq("x.kind", filters.executorKind);
  const at = cursor === null ? null : decodeCursor(cursor);
  if (at !== null) {
    where.push("(e.enqueued_at < ? or (e.enqueued_at = ? and e.id < ?))");
    args.push(at.at, at.at, at.id);
  }
  const size = Math.min(Math.max(1, limit), MAX_PAGE);
  const { results } = await db
    .prepare(
      `${EXECUTION_SELECT}
       ${where.length === 0 ? "" : `where ${where.join(" and ")}`}
       order by e.enqueued_at desc, e.id desc
       limit ?`,
    )
    .bind(...args, size + 1)
    .all();
  const rows = (results as Record<string, unknown>[]).map(executionRowOf);
  const page = rows.slice(0, size);
  return { rows: page, limit: size, next: rows.length > size ? encodeCursor(page.at(-1)!) : null };
};

/** One outbox row of an execution as its page shows it: the row's state and answer, never its payload. */
export interface OutboxEntry {
  readonly id: string;
  readonly kind: string;
  readonly state: string;
  readonly attempts: number;
  readonly externalRef: string | null;
  readonly lastError: string | null;
  readonly insertedAt: number;
  readonly appliedAt: number | null;
}

/** The execution page: the execution's own row, whose status is its verdict, and its outbox rows. */
export interface ExecutionDetail {
  readonly execution: ExecutionRow;
  readonly outbox: readonly OutboxEntry[];
}

/** One execution with its outbox rows in insertion order, or null when no execution has the id. */
export const executionDetail = async (db: D1Like, id: string): Promise<ExecutionDetail | null> => {
  const { results } = await db.prepare(`${EXECUTION_SELECT} where e.id = ?`).bind(id).all();
  const found = (results as Record<string, unknown>[])[0];
  if (found === undefined) return null;
  const { results: rows } = await db
    .prepare(
      `select id, kind, state, attempts, external_ref, last_error, inserted_at, applied_at
       from outbox where execution_id = ? order by inserted_at, id`,
    )
    .bind(id)
    .all();
  return {
    execution: executionRowOf(found),
    outbox: (rows as Record<string, unknown>[]).map((r) => ({
      id: r["id"] as string,
      kind: r["kind"] as string,
      state: r["state"] as string,
      attempts: r["attempts"] as number,
      externalRef: (r["external_ref"] as string | null) ?? null,
      lastError: (r["last_error"] as string | null) ?? null,
      insertedAt: r["inserted_at"] as number,
      appliedAt: (r["applied_at"] as number | null) ?? null,
    })),
  };
};

/** The per-class figures of the overview (FD-OPS-070). */
export interface ClassFigures {
  readonly class: string;
  readonly queueDepth: number;
  readonly queueAgeP50Ms: number | null;
  readonly queueAgeP95Ms: number | null;
  /** The share of the last 24 h's placed executions per executor kind. */
  readonly placementRate: Readonly<Record<string, number>>;
}

/** The nearest-rank percentile of sorted values. */
export const percentile = (sorted: readonly number[], p: number): number | null =>
  sorted.length === 0
    ? null
    : sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;

const DAY_MS = 86_400_000;

/** Queue depth, queue age p50 and p95, and the placement rate by executor kind over 24 h, per class. */
export const classFigures = async (
  db: D1Like,
  classes: readonly string[],
  now: number,
): Promise<readonly ClassFigures[]> => {
  const { results: queued } = await db
    .prepare("select class, enqueued_at from executions where status = 'pending'")
    .all();
  const { results: placed } = await db
    .prepare(
      `select e.class, coalesce(x.kind, 'unregistered') as kind, count(*) as n
       from executions e join placements p on p.execution_id = e.id
       left join executors x on x.executor_id = p.executor_id
       where e.enqueued_at >= ? and p.executor_id is not null
       group by e.class, kind`,
    )
    .bind(now - DAY_MS)
    .all();
  return classes.map((cls) => {
    const ages = (queued as { class: string; enqueued_at: number }[])
      .filter((q) => q.class === cls)
      .map((q) => now - q.enqueued_at)
      .sort((a, b) => a - b);
    const counts = (placed as { class: string; kind: string; n: number }[]).filter(
      (p) => p.class === cls,
    );
    const total = counts.reduce((s, c) => s + c.n, 0);
    return {
      class: cls,
      queueDepth: ages.length,
      queueAgeP50Ms: percentile(ages, 50),
      queueAgeP95Ms: percentile(ages, 95),
      placementRate: Object.fromEntries(counts.map((c) => [c.kind, total === 0 ? 0 : c.n / total])),
    };
  });
};

/**
 * The overview: per-class figures, the active alarms, the control state (null until mameko exposes it) and the 28-day
 * cache hit rate per executor kind, lookup level and cache tier (FD-CACHE-090).
 */
export interface Overview {
  readonly classes: readonly ClassFigures[];
  readonly alarms: readonly ActiveAlarm[];
  readonly controlState: string | null;
  readonly cacheHitRates: readonly HitRate[];
}

export const overview = async (
  db: D1Like,
  classes: readonly string[],
  now: number,
): Promise<Overview> => ({
  classes: await classFigures(db, classes, now),
  alarms: await activeAlarms(db),
  controlState: null,
  cacheHitRates: await cacheHitRates(db, now),
});

/** One executor in the fleet view (FD-OPS-071). */
export interface FleetRow {
  readonly executorId: string;
  readonly kind: string;
  readonly heartbeatAgeMs: number | null;
  readonly drain: boolean;
  readonly quarantine: boolean;
  /** Slots in use and in total per class. */
  readonly slots: Readonly<Record<string, { readonly inUse: number; readonly total: number }>>;
}

/** Every registered executor with its heartbeat age, flags and slots per class. */
export const fleet = async (db: D1Like, now: number): Promise<readonly FleetRow[]> => {
  const { results: executors } = await db
    .prepare(
      `select x.executor_id, x.kind, x.drain, x.quarantine, x.slots_json,
              coalesce(h.last_heartbeat_at, x.last_heartbeat_at) as heartbeat
       from executors x left join executor_heartbeats h on h.executor_id = x.executor_id
       order by x.executor_id`,
    )
    .all();
  const { results: leased } = await db
    .prepare(
      `select p.executor_id, e.class, count(*) as n from placements p join executions e on e.id = p.execution_id
       where p.state = 'leased' group by p.executor_id, e.class`,
    )
    .all();
  return (executors as Record<string, unknown>[]).map((x) => {
    const id = x["executor_id"] as string;
    const totals = JSON.parse(x["slots_json"] as string) as Record<string, unknown>;
    const inUse = (leased as { executor_id: string; class: string; n: number }[]).filter(
      (l) => l.executor_id === id,
    );
    const classes = new Set([
      ...Object.keys(totals).filter((k) => typeof totals[k] === "number"),
      ...inUse.map((l) => l.class),
    ]);
    const heartbeat = x["heartbeat"] as number | null;
    return {
      executorId: id,
      kind: x["kind"] as string,
      heartbeatAgeMs: heartbeat === null ? null : now - heartbeat,
      drain: x["drain"] === 1,
      quarantine: x["quarantine"] === 1,
      slots: Object.fromEntries(
        [...classes].sort().map((c) => [
          c,
          {
            inUse: inUse.find((l) => l.class === c)?.n ?? 0,
            total: typeof totals[c] === "number" ? (totals[c] as number) : 0,
          },
        ]),
      ),
    };
  });
};

/** HTML-escapes a value for element text and attributes. */
export const esc = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const STYLE = `
  :root { color-scheme: dark; }
  body { margin: 0 auto; padding: 2rem 1.25rem; max-width: 72rem; font: 15px/1.5 ui-sans-serif, system-ui, sans-serif; color: #e7e9ee; background: #0d1017; }
  a { color: #6ea8fe; text-decoration: none; }
  h1 { font-size: 1.4rem; margin: 0 0 1rem; }
  h2 { font-size: .82rem; text-transform: uppercase; letter-spacing: .08em; color: #9aa3b2; margin: 2rem 0 .6rem; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th { text-align: left; color: #9aa3b2; padding: .4rem .5rem; border-bottom: 1px solid #232838; }
  td { padding: .5rem; border-bottom: 1px solid #171b27; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; color: #8a93a5; }
  .page { color: #ff9a9a; } .notify { color: #e4c779; }
  ul.reasons { margin: .25rem 0 0; padding-left: 1.1rem; }
  form.filters { display: flex; flex-wrap: wrap; gap: .5rem; margin-bottom: 1rem; }
  form.filters input, form.filters button { font: inherit; color: #e7e9ee; background: #11151f; border: 1px solid #2b313f; border-radius: .35rem; padding: .3rem .5rem; }
`;

const usd = (micro: number | null) => (micro === null ? "—" : `$${(micro / 1e6).toFixed(4)}`);
const seconds = (ms: number | null) => (ms === null ? "—" : `${Math.round(ms / 1000)} s`);

/** The path of an execution's page. */
export const executionPath = (id: string): string => `/executions/${encodeURIComponent(id)}`;

/**
 * The reasons a row's answer gives: every staged-write gate reason of a refused `pr.propose` row. An expired row's
 * `last_error` is its last retryable failure, not a gate reason, so it shows as recorded.
 */
const reasonCell = (row: OutboxEntry): string => {
  if (row.lastError === null)
    return row.state === "expired" ? "expired with no recorded reason" : "—";
  const view =
    row.kind === "pr.propose" && row.state === "refused" ? refusalView(row.lastError) : null;
  if (view === null) return `<span class="mono">${esc(row.lastError)}</span>`;
  return `writeback: ${esc(view.firstKind)}<ul class="reasons">${view.reasons
    .map((r) => `<li class="mono">${esc(r)}</li>`)
    .join("")}</ul>`;
};

/**
 * The execution page: the verdict, read from the execution's own row, and each outbox row with its answer. A
 * refused `pr.propose` row lists every reason of its refusal (FD-AGT-018) and an expired one shows its last error
 * (FD-AGT-038); a row's answer never stands in for the verdict.
 */
export const renderExecutionDetail = (detail: ExecutionDetail, logLink: string | null): string => {
  const e = detail.execution;
  const rows = detail.outbox
    .map(
      (o) => `<tr>
    <td>${esc(o.kind)}</td><td class="${o.state === "refused" || o.state === "expired" ? "notify" : ""}">${esc(o.state)}</td>
    <td>${o.attempts}</td><td class="mono">${esc(o.externalRef ?? "—")}</td><td>${reasonCell(o)}</td>
  </tr>`,
    )
    .join("\n");
  return `<h2>Execution <span class="mono">${esc(e.id)}</span></h2>
<table><tbody>
<tr><th>Verdict</th><td>${esc(e.status)}</td></tr>
<tr><th>Reason</th><td>${esc(e.reason ?? "—")}</td></tr>
<tr><th>Run</th><td>${logLink === null ? esc(e.run) : `<a href="${esc(logLink)}">${esc(e.run)}</a>`}</td></tr>
<tr><th>Repository</th><td>${esc(e.repository)}</td></tr>
<tr><th>Class</th><td>${esc(e.class)}</td></tr>
<tr><th>Executor</th><td class="mono">${esc(e.executorId ?? "—")} ${esc(e.executorKind ?? "")}</td></tr>
</tbody></table>
<h2>Outbox</h2>
${
  detail.outbox.length === 0
    ? "<p>No outbox row.</p>"
    : `<table><thead><tr><th>Intent</th><th>State</th><th>Attempts</th><th>External reference</th><th>Reason</th></tr></thead><tbody>
${rows}
</tbody></table>`
}`;
};

/** The executions view: filters, rows and the next-page link; each log link carries its own link token. */
export const renderExecutions = (
  page: ExecutionPage,
  filters: ExecutionFilters,
  logLinks: Readonly<Record<string, string>>,
): string => {
  const field = (name: string, value: string | undefined, label: string) =>
    `<input name="${name}" value="${esc(value ?? "")}" placeholder="${label}" aria-label="Filter by ${label}" />`;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries({
    run: filters.run,
    repository: filters.repository,
    class: filters.class,
    status: filters.status,
    executor_kind: filters.executorKind,
  }))
    if (v !== undefined) params.set(k, v);
  params.set("limit", String(page.limit));
  if (page.next !== null) params.set("cursor", page.next);
  const rows = page.rows
    .map(
      (r) => `<tr>
    <td><a href="${executionPath(r.id)}">${esc(r.status)}</a></td><td>${logLinks[r.id] === undefined ? esc(r.run) : `<a href="${esc(logLinks[r.id]!)}">${esc(r.run)}</a>`}</td>
    <td>${esc(r.repository)}</td><td>${esc(r.class)}</td><td>${esc(r.placement ?? "—")}</td>
    <td class="mono">${esc(r.executorId ?? "—")}</td><td>${esc(r.executorKind ?? "—")}</td>
    <td>${r.epoch ?? "—"}</td><td>${usd(r.holdMicroUsd)}</td><td>${usd(r.settledMicroUsd)}</td>
  </tr>`,
    )
    .join("\n");
  return `<h2>Executions</h2>
<form class="filters" method="get" action="/">
  ${field("run", filters.run, "run")}${field("repository", filters.repository, "repository")}${field("class", filters.class, "class")}${field("status", filters.status, "status")}${field("executor_kind", filters.executorKind, "executor kind")}
  <button type="submit">Filter</button>
</form>
<table><thead><tr><th>Status</th><th>Run</th><th>Repository</th><th>Class</th><th>Placement</th><th>Executor</th><th>Kind</th><th>Epoch</th><th>Hold</th><th>Settled</th></tr></thead>
<tbody>
${rows}
</tbody></table>
${page.next === null ? "" : `<p><a href="/?${esc(params.toString())}">Older →</a></p>`}`;
};

/**
 * The overview section: per-class figures, active alarms with their runbook entry, the control state, and the cache
 * hit rate per executor kind, level and tier, where a level's `miss` row counts the lookups no tier answered.
 */
export const renderOverview = (o: Overview): string => {
  const classes = o.classes
    .map(
      (c) =>
        `<tr><td>${esc(c.class)}</td><td>${c.queueDepth}</td><td>${seconds(c.queueAgeP50Ms)}</td><td>${seconds(c.queueAgeP95Ms)}</td><td>${esc(
          Object.entries(c.placementRate)
            .map(([k, v]) => `${k} ${(v * 100).toFixed(0)}%`)
            .join(", ") || "—",
        )}</td></tr>`,
    )
    .join("\n");
  const alarms =
    o.alarms.length === 0
      ? "<p>No active alarm.</p>"
      : `<table><thead><tr><th>Alarm</th><th>Severity</th><th>Runbook</th><th>Detail</th></tr></thead><tbody>${o.alarms
          .map(
            (a) =>
              `<tr><td>${esc(a.name)}</td><td class="${a.severity}">${a.severity}</td><td>${esc(a.runbook ?? "—")}</td><td class="mono">${esc(JSON.stringify(a.detail))}</td></tr>`,
          )
          .join("")}</tbody></table>`;
  const cache =
    o.cacheHitRates.length === 0
      ? "<p>No cache lookup in the last 28 days.</p>"
      : `<table><thead><tr><th>Executor kind</th><th>Level</th><th>Tier</th><th>Hits / lookups</th><th>Hit rate</th><th>Bytes restored</th></tr></thead><tbody>${o.cacheHitRates
          .map(
            (r) =>
              `<tr><td>${esc(r.executor_kind)}</td><td>${esc(r.level)}</td><td>${r.tier === null ? "miss" : esc(r.tier)}</td><td>${r.hits} / ${r.lookups}</td><td>${(r.hit_rate * 100).toFixed(1)}%</td><td>${r.bytes_restored}</td></tr>`,
          )
          .join("")}</tbody></table>`;
  return `<h2>Classes, last 24 h</h2>
<table><thead><tr><th>Class</th><th>Queued</th><th>Queue age p50</th><th>p95</th><th>Placement by executor kind</th></tr></thead><tbody>
${classes}
</tbody></table>
<h2>Control state</h2><p>${esc(o.controlState ?? "unavailable")}</p>
<h2>Active alarms</h2>${alarms}
<h2>Cache hit rate, last 28 days</h2>${cache}`;
};

/** The fleet view (FD-OPS-071). */
export const renderFleet = (rows: readonly FleetRow[]): string =>
  `<h2>Fleet</h2>
<table><thead><tr><th>Executor</th><th>Kind</th><th>Heartbeat</th><th>Drain</th><th>Quarantine</th><th>Slots in use / total</th></tr></thead><tbody>
${rows
  .map(
    (r) =>
      `<tr><td class="mono">${esc(r.executorId)}</td><td>${esc(r.kind)}</td><td>${seconds(r.heartbeatAgeMs)}</td><td>${r.drain ? "yes" : "no"}</td><td>${r.quarantine ? "yes" : "no"}</td><td>${esc(
        Object.entries(r.slots)
          .map(([c, s]) => `${c} ${s.inUse}/${s.total}`)
          .join(", "),
      )}</td></tr>`,
  )
  .join("\n")}
</tbody></table>`;

/** The dashboard page around its sections. */
export const renderPage = (sections: readonly string[]): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>FlareDispatch</title><style>${STYLE}</style></head>
<body><h1>FlareDispatch</h1>
${sections.join("\n")}
</body></html>`;
