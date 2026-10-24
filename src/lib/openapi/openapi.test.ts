import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { Validator } from '@seriousme/openapi-schema-validator'
import { auditAllRoutes } from '@/lib/api/route-audit'
import { ERROR_CATALOG } from '@/lib/api/errors'
import { generate } from '../../../scripts/openapi/scan-routes'
import { document } from '../../../scripts/openapi/build'
import { SCANNED_OPERATIONS } from './operations.generated'
import { API_TAGS, RESPONSES } from './metadata'
import { OPERATION_SUMMARIES } from './summaries'
import { placeholdersOf, operationId } from './build'

// The OpenAPI document (docs/openapi.json) against the code it describes. It is generated, committed and served; these tests are what stop it being a document that drifted.

const ROOT = path.resolve(__dirname, '../../..')
const specText = fs.readFileSync(path.join(ROOT, 'docs/openapi.json'), 'utf-8')
const spec = JSON.parse(specText) as {
  paths: Record<string, Record<string, { operationId: string; summary: string; tags: string[]; responses: Record<string, unknown>; security: unknown[]; parameters?: { name?: string; in?: string; $ref?: string }[]; requestBody?: unknown; 'x-roles'?: string[]; 'x-launch'?: string }>>
  components: { schemas: Record<string, unknown> }
  'x-error-catalog': Record<string, { status: number; message: string; params: string[] }>
}
const METHODS = ['get', 'post', 'put', 'patch', 'delete']
const specOperations = Object.entries(spec.paths).flatMap(([p, methods]) => Object.keys(methods).map((method) => `${method.toUpperCase()} ${p}`))

/** The routes on disk, found without the scanner: every route.ts and the HTTP methods it exports, read as plain text. */
function routesOnDisk(): string[] {
  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name === 'route.ts' ? [path.join(dir, e.name)] : []))
  const api = path.join(ROOT, 'src/app/api')
  return walk(api).flatMap((file) => {
    const text = fs.readFileSync(file, 'utf-8')
    const route = '/api' + path.relative(api, path.dirname(file)).split(path.sep).filter(Boolean).map((s) => '/' + s.replace(/^\[\.\.\.(.+)\]$/, '{$1}').replace(/^\[(.+)\]$/, '{$1}')).join('')
    return [...text.matchAll(/^export (?:const|async function|function) (GET|POST|PUT|PATCH|DELETE)\b/gm)].map((m) => `${m[1]} ${route}`)
  })
}

describe('docs/openapi.json', () => {
  it('has every route, and only routes that exist', () => {
    const onDisk = routesOnDisk().sort()
    expect(onDisk.length).toBeGreaterThan(250)
    const missing = onDisk.filter((operation) => !specOperations.includes(operation))
    const gone = specOperations.filter((operation) => !onDisk.includes(operation))
    expect(missing, 'routes missing from the spec: run npm run openapi:scan && npm run openapi:build').toEqual([])
    expect(gone, 'operations of the spec that no route has any more').toEqual([])
  })

  it('is what the code says today (the generated registry and the document are up to date)', () => {
    expect(fs.readFileSync(path.join(ROOT, 'src/lib/openapi/operations.generated.ts'), 'utf-8') === generate(), 'run npm run openapi:scan').toBe(true)
    expect(specText === document(), 'run npm run openapi:build').toBe(true)
  })

  it('is a valid OpenAPI 3.1 document whose references all resolve', async () => {
    const validator = new Validator()
    const result = await validator.validate(spec as never)
    expect(result.errors ?? [], JSON.stringify(result.errors ?? []).slice(0, 600)).toEqual([])
    expect(result.valid).toBe(true)
    const refs = new Set([...specText.matchAll(/"\$ref": "#\/([^"]+)"/g)].map((m) => m[1]))
    const root = spec as unknown as Record<string, unknown>
    const broken = [...refs].filter((ref) => {
      let node: unknown = root
      for (const part of ref.split('/')) node = (node as Record<string, unknown> | undefined)?.[part]
      return node === undefined
    })
    expect(broken).toEqual([])
  })

  it('names every operation once, with a one-line summary, a tag, and its parameters', () => {
    const ids = new Set<string>()
    for (const [p, methods] of Object.entries(spec.paths)) {
      for (const [method, op] of Object.entries(methods)) {
        expect(METHODS, `${method} ${p}`).toContain(method)
        expect(ids.has(op.operationId), `duplicate operationId ${op.operationId}`).toBe(false)
        ids.add(op.operationId)
        expect(op.operationId).toBe(operationId(method.toUpperCase(), p))
        expect(op.summary.length, `${method} ${p}`).toBeGreaterThan(5)
        expect(op.summary.length).toBeLessThan(110)
        expect(API_TAGS.map((t) => t.name)).toContain(op.tags[0])
        for (const name of [...p.matchAll(/\{(\w+)\}/g)].map((m) => m[1])) {
          expect(op.parameters?.some((x) => x.name === name && x.in === 'path'), `${method} ${p} lacks the path parameter ${name}`).toBe(true)
        }
      }
    }
  })

  it('has a summary for every operation and none for an operation that does not exist', () => {
    expect(Object.keys(OPERATION_SUMMARIES).sort()).toEqual([...specOperations].sort())
  })

  it('lists the request bodies and queries as the schemas the handlers validate with', () => {
    const post = spec.paths['/api/posts'].post as { requestBody?: { content: { 'application/json': { schema: { required?: string[]; additionalProperties?: boolean; properties: Record<string, unknown> } } } } }
    const schema = post.requestBody!.content['application/json'].schema
    expect(schema.required).toEqual(['kind', 'title', 'body'])
    expect(schema.additionalProperties).toBe(false)
    expect(Object.keys(schema.properties)).toEqual(expect.arrayContaining(['kind', 'title', 'body', 'projectId', 'visibility']))
    const feed = spec.paths['/api/feed'].get.parameters!
    expect(feed.filter((p) => p.in === 'query').map((p) => p.name)).toEqual(expect.arrayContaining(['tab', 'cursor', 'limit']))
    const writes = SCANNED_OPERATIONS.filter((o) => ['POST', 'PUT', 'PATCH'].includes(o.method))
    expect(writes.filter((o) => o.body).length).toBeGreaterThan(80)
  })

  it('knows who may call what: sessions, roles, rate limits, idempotency, caching', () => {
    const publics = SCANNED_OPERATIONS.filter((o) => o.guard === 'none').map((o) => `${o.method} ${o.path}`).sort()
    expect(publics).toEqual(['GET /api/auth/session', 'GET /api/health', 'GET /api/inngest', 'GET /api/invites/check', 'GET /api/notifications/open/{token}', 'GET /api/notifications/unsubscribe', 'GET /api/og/achievement/{slug}', 'GET /api/og/link', 'GET /api/og/passport/{username}', 'GET /api/og/post/{id}', 'GET /api/og/squad/{id}', 'POST /api/inngest', 'POST /api/notifications/unsubscribe', 'POST /api/webhooks/clerk', 'POST /api/webhooks/email', 'PUT /api/inngest'].sort())
    for (const [p, methods] of Object.entries(spec.paths)) {
      for (const [method, op] of Object.entries(methods)) {
        if (p.startsWith('/api/admin/')) expect(op['x-roles'], `${method} ${p}`).toEqual(expect.arrayContaining([expect.stringMatching(/ADMIN|MODERATOR/)]))
        if (op.security.length === 0) expect(publics).toContain(`${method.toUpperCase()} ${p}`)
      }
    }
    // The scanner agrees with the route audit (an independent reading of the same source) on limits and idempotency.
    const audit = auditAllRoutes()
    for (const route of audit) {
      const scanned = SCANNED_OPERATIONS.find((o) => o.method === route.method && o.path === route.path.replace(/\[\.\.\.(\w+)\]/g, '{$1}').replace(/\[(\w+)\]/g, '{$1}'))
      expect(scanned, `${route.method} ${route.path}`).toBeDefined()
      expect(scanned!.idempotent, `${route.method} ${route.path} idempotent`).toBe(route.idempotent)
      expect(scanned!.rateLimit?.max ?? null, `${route.method} ${route.path} limit`).toBe(route.rateLimit?.maxRequests ?? null)
      expect(scanned!.rateLimit?.windowMs ?? null, `${route.method} ${route.path} window`).toBe(route.rateLimit?.windowMs ?? null)
    }
    const idempotent = SCANNED_OPERATIONS.filter((o) => o.idempotent)
    expect(idempotent.length).toBeGreaterThan(15)
    expect(spec.paths['/api/posts'].post['x-idempotent' as never]).toBe(true)
  })

  it('carries the error catalogue, with status and placeholders, and every code once', () => {
    expect(Object.keys(spec['x-error-catalog']).sort()).toEqual(Object.keys(ERROR_CATALOG).sort())
    expect(spec['x-error-catalog'].ROMANCE_PAUSED).toMatchObject({ status: 503, params: ['mode'] })
    expect(spec['x-error-catalog'].RATE_LIMITED.status).toBe(429)
    for (const [code, entry] of Object.entries(spec['x-error-catalog'])) expect(entry.params, code).toEqual(placeholdersOf(ERROR_CATALOG[code as keyof typeof ERROR_CATALOG].message))
    const codes = (spec.components.schemas.ErrorCode as { enum: string[] }).enum
    expect(codes).toEqual(Object.keys(ERROR_CATALOG).sort())
  })

  it('types the answers it names, with the types the interface imports, and counts what is still untyped', () => {
    const apiTypes = fs.readFileSync(path.join(ROOT, 'src/types/api.ts'), 'utf-8')
    for (const [key, spec_] of Object.entries(RESPONSES)) {
      expect(specOperations, `${key} names no operation`).toContain(key)
      expect(apiTypes, `${spec_.type} is not exported by src/types/api.ts`).toMatch(new RegExp(`export (interface|type) ${spec_.type}\\b`))
      expect(spec.components.schemas[spec_.type], spec_.type).toBeDefined()
    }
    for (const required of ['ApiError', 'RewardsEnvelope', 'Pagination', 'ErrorCode']) expect(spec.components.schemas[required], required).toBeDefined()
    // How many answers are still `object`. The number may only go down: type a route, lower the budget.
    const untyped = specOperations.filter((operation) => !(operation in RESPONSES))
    expect(untyped.length).toBeLessThanOrEqual(UNTYPED_BUDGET)
  })

  it('marks the romance mode post-launch, except asking to be told', () => {
    for (const [p, methods] of Object.entries(spec.paths)) {
      for (const [method, op] of Object.entries(methods)) {
        const romance = p.startsWith('/api/romance')
        expect(op['x-launch'] === 'post-launch', `${method} ${p}`).toBe(romance && p !== '/api/romance/interest')
        if (op['x-launch']) expect(op.responses['503']).toBeDefined()
      }
    }
  })

  it('names the romance routes with a tag that says they are not open', () => {
    expect(API_TAGS.find((t) => t.name === 'Romance (post-launch)')?.description).toMatch(/503 ROMANCE_PAUSED/)
  })
})

/** Operations whose answer is not typed yet. Lower it when one is typed; the test fails if it would go up. */
const UNTYPED_BUDGET = 168
