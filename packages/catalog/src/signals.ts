// `signals/v1`: the caller-supplied observability signals a dispatch carries (specs/interfaces.md FD-IFC-030). The
// published JSON Schema is generated from this definition (FD-RUN-054); `generate-schemas.ts` writes it.
import { Schema } from "effect";

export const SIGNALS_CONTRACT_VERSION = "v1";
export const MAX_SIGNALS = 50;

const capped = (maxLength: number, description: string) =>
  Schema.String.check(Schema.isMaxLength(maxLength)).annotate({ description });

/** One signal. */
export const Signal = Schema.Struct({
  source: capped(120, "Which system produced the signal. Convention: vendor-or-surface[:scope]."),
  title: capped(200, "Short title naming the error."),
  detail: capped(2000, "Enough detail for a model to triage (message, context, window)."),
  url: Schema.optionalKey(capped(1000, "Optional deep link into the producing system.")),
  count: Schema.optionalKey(
    Schema.Finite.annotate({ description: "Optional occurrence count over the caller's window." }),
  ),
});
export type Signal = typeof Signal.Type;

/** The capped list a dispatch carries. */
export const Signals = Schema.Array(Signal).check(Schema.isMaxLength(MAX_SIGNALS));

/** The JSON Schema document published as `schemas/signals.v1.schema.json`. */
export const signalsJsonSchema = (): Record<string, unknown> => {
  const document = Schema.toJsonSchemaDocument(Signals, { onExcessProperty: "error" });
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "flare-dispatch signals/v1",
    description:
      "Caller-supplied observability signals. Generated from packages/catalog/src/signals.ts; do not edit.",
    "x-flare-dispatch-contract-version": SIGNALS_CONTRACT_VERSION,
    ...document.schema,
    ...(Object.keys(document.definitions).length === 0 ? {} : { $defs: document.definitions }),
  };
};

/** The committed file's bytes: the document as two-space JSON with a final newline. */
export const signalsJsonSchemaText = (): string =>
  `${JSON.stringify(signalsJsonSchema(), null, 2)}\n`;
