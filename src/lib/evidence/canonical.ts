import { createHash } from 'node:crypto'

// Canonical JSON in the style of RFC 8785 (JSON Canonicalization Scheme): the one byte sequence a receipt's signature and payload hash are computed over,
// so anybody holding the JSON can rebuild exactly what was signed (docs/PROOF.md has a copy of this function for verifying offline). Pure.
//
//   objects   members sorted by their names compared as UTF-16 code units (JavaScript's default string order), no whitespace;
//   strings   escaped as JSON.stringify escapes them, which is what RFC 8785 asks for (the short escapes, \u00XX for the other control characters, everything
//             else as itself, lone surrogates as \uDXXX);
//   numbers   as ECMAScript prints them (JSON.stringify), which is the RFC's rule; -0 is 0; NaN and the infinities are refused;
//   arrays    in their order.
// Anything JSON cannot hold (undefined, a function, a symbol, a bigint, a Date or any other class instance) is refused rather than guessed at, so two
// implementations can never disagree about a value.

export class CanonicalJsonError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CanonicalJsonError'
  }
}

function serialize(value: unknown, path: string): string {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false'
    case 'string':
      return JSON.stringify(value)
    case 'number':
      if (!Number.isFinite(value)) throw new CanonicalJsonError(`${path}: ${value} is not a JSON number`)
      return Object.is(value, -0) ? '0' : JSON.stringify(value)
    case 'object': {
      if (Array.isArray(value)) return `[${value.map((item, index) => serialize(item, `${path}[${index}]`)).join(',')}]`
      const proto = Object.getPrototypeOf(value)
      if (proto !== Object.prototype && proto !== null) throw new CanonicalJsonError(`${path}: only plain objects can be canonicalised`)
      const record = value as Record<string, unknown>
      const members = Object.keys(record)
        .sort()
        .map((key) => {
          if (record[key] === undefined) throw new CanonicalJsonError(`${path}.${key}: undefined is not JSON`)
          return `${JSON.stringify(key)}:${serialize(record[key], `${path}.${key}`)}`
        })
      return `{${members.join(',')}}`
    }
    default:
      throw new CanonicalJsonError(`${path}: a ${typeof value} is not JSON`)
  }
}

/** The canonical form of a JSON value. Throws CanonicalJsonError for anything that is not plain JSON. */
export function canonicalize(value: unknown): string {
  return serialize(value, '$')
}

/** sha256 (lowercase hex) of the canonical form. */
export function canonicalHash(value: unknown): string {
  return createHash('sha256').update(canonicalize(value), 'utf8').digest('hex')
}
