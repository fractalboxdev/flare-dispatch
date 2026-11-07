// Responses in the error model of specs/interfaces.md § Error model, and the
// bounded body read every intake route starts with.
import { Effect } from "effect";
import { intakeError, type IntakeError } from "./config.ts";

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** `{ error, message, request_id }`, plus the existing execution a `conflict` names. */
export const errorResponse = (e: IntakeError, requestId: string) =>
  json(
    {
      error: e.code,
      message: e.message,
      request_id: requestId,
      ...(e.executionId === undefined ? {} : { execution_id: e.executionId }),
    },
    e.status,
  );

/**
 * The body's bytes, refused with `413` above `limit` without reading further: a declared `content-length` over the
 * limit is refused before any byte is read (FD-INT-023, FD-INT-040, FD-IFC-006).
 */
export const readBody = (request: Request, limit: number): Effect.Effect<Uint8Array, IntakeError> =>
  Effect.gen(function* () {
    const tooLarge = intakeError(413, "payload_too_large", `the body exceeds ${limit} bytes`);
    const declared = Number(request.headers.get("content-length") ?? "NaN");
    if (Number.isFinite(declared) && declared > limit) return yield* Effect.fail(tooLarge);
    if (request.body === null) return new Uint8Array();
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = yield* Effect.promise(() => reader.read());
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        yield* Effect.promise(() => reader.cancel());
        return yield* Effect.fail(tooLarge);
      }
      chunks.push(value);
    }
    const out = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) {
      out.set(c, at);
      at += c.byteLength;
    }
    return out;
  });

export const parseJson = (bytes: Uint8Array): Effect.Effect<unknown, IntakeError> =>
  Effect.try({
    try: () => JSON.parse(new TextDecoder().decode(bytes)) as unknown,
    catch: () => intakeError(400, "invalid_body", "the body is not JSON"),
  });
