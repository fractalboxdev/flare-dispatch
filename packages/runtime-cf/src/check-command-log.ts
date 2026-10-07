import { redactLongestFirst as redact } from "./sandbox-output";

/** Uncommitted secret suffixes stay in the spool and are reread, never checkpointed. */
export function scrubLogPrefix(
  raw: string,
  values: readonly string[],
  terminal: boolean,
): { text: string; characters: number } {
  const secrets = values.filter((v) => v.length > 0);
  const width = Math.max(0, ...secrets.map((v) => v.length));
  if (width > 16384) throw new Error("check log secret exceeds bounded redaction window");
  let end = Math.min(16384, terminal ? raw.length : Math.max(0, raw.length - width));
  // Whole Unicode codepoints and complete matches cross the upload boundary together.
  if (end > 0 && /[\uD800-\uDBFF]/.test(raw[end - 1]!)) end--;
  let prior;
  do {
    prior = end;
    for (const value of secrets) {
      let at = raw.indexOf(value);
      while (at >= 0 && at < end) {
        if (at + value.length > end) {
          end = at;
          break;
        }
        at = raw.indexOf(value, at + 1);
      }
    }
  } while (prior !== end);
  return { text: redact(raw.slice(0, end), secrets), characters: end };
}
