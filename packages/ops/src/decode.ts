// Strict decoding at the operator's boundary: every undeclared key and every missing value is reported with its path.
import { Cause, Effect, Exit, Option, Schema, SchemaIssue } from "effect";

/** One path the decode refused and why. */
export interface DecodeIssue {
  readonly path: string;
  readonly message: string;
}

const formatter = SchemaIssue.makeFormatterStandardSchemaV1();

const pathOf = (path: ReadonlyArray<unknown> | undefined): string =>
  (path ?? [])
    .map((p) =>
      String(typeof p === "object" && p !== null && "key" in p ? (p as { key: unknown }).key : p),
    )
    .join(".");

const issuesOf = (cause: Cause.Cause<Schema.SchemaError>): readonly DecodeIssue[] =>
  Option.match(Cause.findErrorOption(cause), {
    onNone: () => [{ path: "", message: Cause.pretty(cause) }],
    onSome: (error) =>
      formatter(error.issue).issues.map((i) => ({ path: pathOf(i.path), message: i.message })),
  });

/** Decodes `input`, failing with every issue: an undeclared key, a missing required value or a mistyped one. */
export const decodeStrict = <S extends Schema.Top>(
  schema: S,
  input: unknown,
): Effect.Effect<S["Type"], readonly DecodeIssue[]> => {
  const exit = Schema.decodeUnknownExit(schema as never, {
    onExcessProperty: "error",
    errors: "all",
  })(input) as Exit.Exit<S["Type"], Schema.SchemaError>;
  return Exit.isSuccess(exit) ? Effect.succeed(exit.value) : Effect.fail(issuesOf(exit.cause));
};
