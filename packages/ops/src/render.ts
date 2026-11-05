// The renderer: each Worker's configuration is its committed template with every placeholder replaced by its overlay
// value and nothing else changed (FD-OPS-005, FD-OPS-006). A placeholder is a JSON string `"{{<value path>}}"`; the
// renderer writes the value's JSON in its place, so a string stays a string and an array stays an array.
import { Effect, Schema } from "effect";
import type { OverlayValues } from "./overlay.ts";

/** A placeholder token: the quoted `{{path}}` in a template. */
const PLACEHOLDER = /"\{\{([A-Za-z0-9_.-]+)\}\}"/g;

/** The rendered template named a value path the overlay does not hold. */
export class RenderFailed extends Schema.TaggedError<RenderFailed>()("RenderFailed", {
  worker: Schema.String,
  paths: Schema.Array(Schema.String),
}) {}

/** The value at a dotted path of the overlay, or undefined. */
export const valueAt = (overlay: unknown, path: string): unknown => {
  let at: unknown = overlay;
  for (const key of path.split(".")) {
    if (typeof at !== "object" || at === null || !(key in at)) return undefined;
    at = (at as Record<string, unknown>)[key];
  }
  return at;
};

/** Every value path a template's placeholders name, in order of first use. */
export const placeholdersOf = (template: string): readonly string[] => [
  ...new Set([...template.matchAll(PLACEHOLDER)].map((m) => m[1]!)),
];

/**
 * Renders one Worker's configuration. Pure: the same template and overlay render byte-identical text, and every byte
 * outside a placeholder, comments and formatting included, is the template's own.
 */
export const renderTemplate = (worker: string, template: string, overlay: OverlayValues) =>
  Effect.gen(function* () {
    const missing = placeholdersOf(template).filter((p) => valueAt(overlay, p) === undefined);
    if (missing.length > 0) return yield* new RenderFailed({ worker, paths: missing });
    return template.replace(PLACEHOLDER, (_token, path: string) =>
      JSON.stringify(valueAt(overlay, path)),
    );
  });

/** The index just past the JSON string that starts at `i`. */
const stringEnd = (text: string, i: number): number => {
  let j = i + 1;
  while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
  return j + 1;
};

/** Strips `//` and block comments and trailing commas from JSONC, leaving string contents untouched. */
export const stripJsonc = (text: string): string => {
  let bare = "";
  for (let i = 0; i < text.length;) {
    const ch = text[i]!;
    if (ch === '"') {
      const end = stringEnd(text, i);
      bare += text.slice(i, end);
      i = end;
    } else if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 2;
    } else {
      bare += ch;
      i++;
    }
  }
  let out = "";
  for (let i = 0; i < bare.length;) {
    const ch = bare[i]!;
    if (ch === '"') {
      const end = stringEnd(bare, i);
      out += bare.slice(i, end);
      i = end;
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < bare.length && /\s/.test(bare[j]!)) j++;
      if (bare[j] === "}" || bare[j] === "]") {
        i++;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
};

/** A Worker configuration as wrangler reads it. */
export type WorkerConfig = Readonly<Record<string, unknown>>;

/** Parses a JSONC Worker configuration. */
export const parseJsonc = (text: string): WorkerConfig =>
  JSON.parse(stripJsonc(text)) as WorkerConfig;
