// Five-field cron expressions, matched against one scheduled minute in UTC
// (FD-INT-051), and the one trigger the committed template declares (FD-INT-050).

/** The control plane's only cron trigger: the minute tick. */
export const MINUTE_TICK = "* * * * *";

/** `null` when the rendered or deployed cron set is exactly the minute tick, else why it drifted (FD-INT-050). */
export const cronDrift = (crons: readonly string[]): string | null => {
  if (crons.length === 1 && crons[0] === MINUTE_TICK) return null;
  return `cron triggers ${JSON.stringify(crons)} differ from the template ${JSON.stringify([MINUTE_TICK])}`;
};

const FIELDS = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12 },
  { min: 0, max: 7 },
] as const;

/** One field's allowed values, or null when the field does not parse. */
const field = (text: string, min: number, max: number): ReadonlySet<number> | null => {
  const out = new Set<number>();
  for (const part of text.split(",")) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (m === null) return null;
    const step = m[4] === undefined ? 1 : Number(m[4]);
    const lo = m[1] === "*" ? min : Number(m[2]);
    const hi =
      m[1] === "*" ? max : m[3] === undefined ? (m[4] === undefined ? lo : max) : Number(m[3]);
    if (step < 1 || lo < min || hi > max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
};

export interface CronExpression {
  readonly fields: readonly ReadonlySet<number>[];
  /** Whether day-of-month and day-of-week were both restricted, so either one matching suffices. */
  readonly eitherDay: boolean;
}

export const parseCron = (expression: string): CronExpression | null => {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const fields: ReadonlySet<number>[] = [];
  for (let i = 0; i < 5; i++) {
    const f = field(parts[i]!, FIELDS[i]!.min, FIELDS[i]!.max);
    if (f === null) return null;
    fields.push(f);
  }
  return { fields, eitherDay: parts[2] !== "*" && parts[4] !== "*" };
};

/** Whether the expression fires at the minute containing `at` (epoch ms), in UTC. */
export const cronMatches = (cron: CronExpression, at: number): boolean => {
  const d = new Date(at);
  const [minute, hour, dom, month, dow] = cron.fields;
  const weekday = d.getUTCDay();
  const domOk = dom!.has(d.getUTCDate());
  const dowOk = dow!.has(weekday) || (weekday === 0 && dow!.has(7));
  const dayOk = cron.eitherDay ? domOk || dowOk : domOk && dowOk;
  return (
    minute!.has(d.getUTCMinutes()) &&
    hour!.has(d.getUTCHours()) &&
    month!.has(d.getUTCMonth() + 1) &&
    dayOk
  );
};

/** The scheduled minute as ISO 8601 UTC, the form the cron dedup key carries (FD-INT-053). */
export const minuteIso = (at: number) => new Date(Math.floor(at / 60_000) * 60_000).toISOString();
