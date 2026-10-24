/**
 * tsx scripts/openapi/build.ts [--check]
 *
 * Writes docs/openapi.json (OpenAPI 3.1) from the routes, the Zod schemas and the response types. With --check it writes nothing and exits 1 if the file on disk is not what the code says
 * (the unit test and CI do this). Run `npm run openapi:scan` first when a route was added or removed.
 */
import fs from 'fs'
import path from 'path'
import { RESPONSES } from '../../src/lib/openapi/metadata'
import { buildOpenApi } from '../../src/lib/openapi/build'
import { SCANNED_OPERATIONS } from '../../src/lib/openapi/operations.generated'
import { typeSchemas } from './types-schema'

const ROOT = path.resolve(__dirname, '../..')
const OUT = path.join(ROOT, 'docs/openapi.json')

export function document(): string {
  const names = ['ApiError', 'RewardsEnvelope', 'Pagination', ...Object.values(RESPONSES).map((spec) => spec.type)]
  const version = (JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8')) as { version: string }).version
  return JSON.stringify(buildOpenApi({ operations: SCANNED_OPERATIONS, typeSchemas: typeSchemas(names), version }), null, 2) + '\n'
}

if (require.main === module) {
  const text = document()
  if (process.argv.includes('--check')) {
    const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf-8') : ''
    if (current !== text) {
      console.error('docs/openapi.json is out of date: run npm run openapi:build')
      process.exit(1)
    }
    console.log('docs/openapi.json is up to date')
  } else {
    fs.writeFileSync(OUT, text)
    const spec = JSON.parse(text) as { paths: Record<string, Record<string, unknown>>; components: { schemas: Record<string, unknown> } }
    const operations = Object.values(spec.paths).reduce((sum, methods) => sum + Object.keys(methods).length, 0)
    console.log(`wrote docs/openapi.json: ${Object.keys(spec.paths).length} paths, ${operations} operations, ${Object.keys(spec.components.schemas).length} schemas`)
  }
}
