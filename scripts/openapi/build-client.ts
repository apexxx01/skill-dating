/**
 * tsx scripts/openapi/build-client.ts [--check]
 *
 * Writes src/lib/api-client/generated.ts: a typed client of every operation of docs/openapi.json. The request types (path, query, body) are compiled from the JSON Schema of the spec, which was
 * made from the Zod schemas the server validates with; the response types are the ones of src/types/api.ts that the spec names. The runtime (fetch, errors, idempotency, pages, rewards)
 * is src/lib/api-client/runtime.ts. With --check it writes nothing and exits 1 if the file is out of date.
 */
import fs from 'fs'
import path from 'path'
import { compile } from 'json-schema-to-typescript'

const ROOT = path.resolve(__dirname, '../..')
const SPEC = path.join(ROOT, 'docs/openapi.json')
const OUT = path.join(ROOT, 'src/lib/api-client/generated.ts')

type Json = Record<string, any>

const GROUPS: Record<string, string> = {
  Account: 'account',
  Passport: 'passport',
  Matching: 'matching',
  'Ship Feed': 'shipFeed',
  Projects: 'projects',
  Squads: 'squads',
  Progress: 'progress',
  Search: 'search',
  Messaging: 'messaging',
  Notifications: 'notifications',
  Growth: 'growth',
  Safety: 'safety',
  Media: 'media',
  'Share cards': 'shareCards',
  'Halves (post-launch)': 'halves',
  Admin: 'admin',
  Platform: 'platform',
}

const pascal = (text: string) => text.replace(/^./, (c) => c.toUpperCase())

async function typeText(name: string, schema: Json): Promise<string> {
  const text = await compile(schema as never, name, { bannerComment: '', additionalProperties: false, declareExternallyReferenced: true, strictIndexSignatures: true, format: true, maxItems: -1, unreachableDefinitions: false })
  return text.trim()
}

export async function generate(): Promise<string> {
  const spec = JSON.parse(fs.readFileSync(SPEC, 'utf-8')) as Json
  const blocks: string[] = []
  const operations: string[] = []
  const methods = new Map<string, string[]>()
  const responseTypes = new Set<string>()
  const ids: string[] = []

  for (const [route, byMethod] of Object.entries<Json>(spec.paths)) {
    for (const [method, op] of Object.entries<Json>(byMethod)) {
      const id: string = op.operationId
      const type = pascal(id)
      ids.push(id)
      const pathParams = (op.parameters ?? []).filter((p: Json) => p.in === 'path').map((p: Json) => p.name as string)
      const queryParams = (op.parameters ?? []).filter((p: Json) => p.in === 'query')
      const bodySchema: Json | undefined = op.requestBody?.content?.['application/json']?.schema
      const response = op.responses['200'] ?? op.responses['201'] ?? op.responses['202']
      const ref: string | undefined = response?.content?.['application/json']?.schema?.$ref
      const responseType = ref ? ref.replace('#/components/schemas/', '') : null
      if (responseType) responseTypes.add(responseType)
      const nonJson = response?.content && !response.content['application/json']

      let queryType = ''
      let queryRequired = false
      if (queryParams.length > 0) {
        const required = queryParams.filter((p: Json) => p.required).map((p: Json) => p.name)
        queryRequired = required.length > 0
        blocks.push(await typeText(`${type}Query`, { type: 'object', properties: Object.fromEntries(queryParams.map((p: Json) => [p.name, p.schema])), required, additionalProperties: false }))
        queryType = `${type}Query`
      }
      let bodyType = ''
      let bodyRequired = false
      if (bodySchema) {
        const s = bodySchema as Json
        bodyRequired = Array.isArray(s.required) && s.required.length > 0
        blocks.push(await typeText(`${type}Body`, s))
        bodyType = `${type}Body`
      }
      const pathType = pathParams.length > 0 ? `{ ${pathParams.map((n: string) => `${n}: string | number`).join('; ')} }` : ''

      const fields = [pathType ? `path: ${pathType}` : '', queryType ? `query${queryRequired ? '' : '?'}: ${queryType}` : '', bodyType ? `body${bodyRequired ? '' : '?'}: ${bodyType}` : ''].filter(Boolean)
      const argsRequired = pathType !== '' || queryRequired || bodyRequired
      blocks.push(`export interface ${type}Args extends CallOptions {\n${fields.map((f) => `  ${f}`).join('\n')}${fields.length ? '\n' : ''}}`)

      const idempotent = op['x-idempotent'] === true
      operations.push(`  ${id}: { method: '${method.toUpperCase()}', path: '${route}', idempotent: ${idempotent}, safeToRetry: ${method === 'get' || idempotent} },`)

      const group = GROUPS[op.tags[0]]
      const docs = [`/** ${String(op.summary).replace(/\*\//g, '* /')}`, ` * \`${method.toUpperCase()} ${route}\``, ...(op['x-launch'] ? [' * @remarks Post-launch: answers 503 ROMANCE_PAUSED until the mode is opened for the caller.'] : []), ...(op['x-roles'] ? [` * @remarks Roles: ${op['x-roles'].join(', ')}.`] : []), ...(op['x-rewards'] ? [' * @remarks The answer carries a RewardsEnvelope (response.rewards).'] : []), ' */'].map((l) => `      ${l}`).join('\n')
      const returns = nonJson ? 'Response' : `ApiResponse<${responseType ?? 'UntypedResponse'}>`
      const impl = nonJson ? `raw('${id}', args)` : `call<${responseType ?? 'UntypedResponse'}>('${id}', args)`
      const list = methods.get(group) ?? []
      list.push(`${docs}\n      ${id}: (${argsRequired ? `args: ${type}Args` : `args?: ${type}Args`}): Promise<${returns}> => ${impl},`)
      methods.set(group, list)
    }
  }

  const groupText = [...methods.entries()].map(([group, list]) => `    ${group}: {\n${list.join('\n')}\n    },`).join('\n')
  const imports = [...responseTypes].sort()
  return `// GENERATED by scripts/openapi/build-client.ts from docs/openapi.json: do not edit. Regenerate with \`npm run openapi:client\`; a unit test fails when it is out of date.
// The runtime (fetch, typed errors, idempotency, pages, rewards) is ./runtime.ts; start at ./index.ts.
/* eslint-disable */
import type { ${imports.join(', ')} } from '@/types/api'
import { Transport, type ApiClientOptions, type ApiResponse, type CallOptions, type OperationInfo } from './runtime'

/** An answer the spec does not type yet (see the UNTYPED_BUDGET of src/lib/openapi/openapi.test.ts). */
export type UntypedResponse = Record<string, unknown>

${blocks.join('\n\n')}

export const OPERATIONS = {
${operations.join('\n')}
} as const satisfies Record<string, OperationInfo>

export type OperationId = keyof typeof OPERATIONS

export function createApiClient(options: ApiClientOptions = {}) {
  const transport = new Transport(options)
  type AnyArgs = (CallOptions & { path?: Record<string, string | number>; query?: object; body?: unknown }) | undefined
  const call = <T>(id: OperationId, args: AnyArgs) => transport.call<T>(id, OPERATIONS[id], { path: args?.path, query: args?.query, body: args?.body }, args)
  const raw = (id: OperationId, args: AnyArgs) => transport.raw(id, OPERATIONS[id], { path: args?.path, query: args?.query, body: args?.body }, args)
  return {
${groupText}
  }
}

export type ApiClient = ReturnType<typeof createApiClient>
`
}

if (require.main === module) {
  generate().then((text) => {
    if (process.argv.includes('--check')) {
      const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf-8') : ''
      if (current !== text) {
        console.error('src/lib/api-client/generated.ts is out of date: run npm run openapi:client')
        process.exit(1)
      }
      console.log('generated.ts is up to date')
    } else {
      fs.writeFileSync(OUT, text)
      console.log(`wrote ${path.relative(ROOT, OUT)} (${text.split('\n').length} lines)`)
    }
  })
}
