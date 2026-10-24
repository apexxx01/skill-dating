import path from 'path'
import { createGenerator } from 'ts-json-schema-generator'

// JSON Schema for the response types of src/types/api.ts, from the TypeScript source itself (so the document and the types the interface imports cannot disagree). Each wanted type is
// generated on its own; the types they reach come with them; generic instantiations (`CursorPage<PostItem>`) get a name that OpenAPI accepts.

type Json = Record<string, unknown>

const ROOT = path.resolve(__dirname, '../..')

/** A component name OpenAPI accepts (letters, digits, `.`, `_`, `-`). */
const safeName = (name: string) => decodeURIComponent(name).replace(/[<>,\s]+/g, '_').replace(/_+$/g, '')

function rewrite(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(rewrite)
  if (node && typeof node === 'object') {
    const out: Json = {}
    for (const [key, value] of Object.entries(node as Json)) {
      if (key === '$ref' && typeof value === 'string') out[key] = `#/components/schemas/${safeName(value.replace('#/definitions/', ''))}`
      else out[key] = rewrite(value)
    }
    return out
  }
  return node
}

export function typeSchemas(names: readonly string[]): Record<string, Json> {
  const generator = createGenerator({ path: path.join(ROOT, 'src/types/api.ts'), tsconfig: path.join(ROOT, 'tsconfig.json'), type: '*', skipTypeCheck: true, expose: 'export', topRef: true, additionalProperties: false, jsDoc: 'extended' })
  const out: Record<string, Json> = {}
  for (const name of [...new Set(names)].sort()) {
    const schema = generator.createSchema(name) as Json & { definitions?: Record<string, Json> }
    for (const [definition, value] of Object.entries(schema.definitions ?? {})) out[safeName(definition)] = rewrite(value) as Json
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)))
}
