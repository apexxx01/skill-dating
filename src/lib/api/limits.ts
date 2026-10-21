import { z } from 'zod'

// Input limits shared by every route. Each field of a request schema has its own maximum (the schema audit, schema-audit.test.ts, fails on any
// string or array without one); on top of that the body of every request is capped as a whole before it is parsed (MAX_BODY_BYTES, enforced by
// validateBody in src/lib/api/handler.ts). Free-form JSON objects go through boundedRecord / boundedJson below, which cap the keys and the size.

/** The largest request body any route accepts, in bytes. Uploads never pass through the API (they go straight to the bucket). */
export const MAX_BODY_BYTES = 256 * 1024

/** An object with at most `maxKeys` keys of at most `maxKeyLength` characters, each value checked by `value`. */
export function boundedRecord<V extends z.ZodTypeAny>(value: V, { maxKeys, maxKeyLength = 64 }: { maxKeys: number; maxKeyLength?: number }) {
  return z
    .record(z.string().max(maxKeyLength), value)
    .refine((object) => Object.keys(object).length <= maxKeys, `At most ${maxKeys} keys`)
}

/** A free-form JSON object of at most `maxBytes` once serialised (for opaque client metadata and admin job payloads). */
export function boundedJson(maxBytes: number) {
  return z
    .record(z.string().max(64), z.unknown())
    .refine((object) => JSON.stringify(object).length <= maxBytes, `At most ${maxBytes} bytes`)
}
