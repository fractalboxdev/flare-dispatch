// Writes the published JSON Schemas from their `Schema` definitions (FD-RUN-054). `pnpm --filter
// @fractalboxdev/flare-dispatch-catalog gen:schemas` runs it; `catalog.test.ts` fails when a committed file differs.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { signalsJsonSchemaText } from "./signals.ts";

/** Each published schema: its committed path and its generated text. */
export const PUBLISHED_SCHEMAS: readonly { readonly path: string; readonly text: () => string }[] =
  [
    {
      path: fileURLToPath(new URL("../schemas/signals.v1.schema.json", import.meta.url)),
      text: signalsJsonSchemaText,
    },
  ];

if (import.meta.url === `file://${process.argv[1]}`)
  for (const schema of PUBLISHED_SCHEMAS) writeFileSync(schema.path, schema.text());
