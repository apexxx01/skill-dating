import { zodToJsonSchema } from 'zod-to-json-schema'
import type { ZodTypeAny } from 'zod'
import { ERROR_CATALOG } from '@/lib/api/errors'
import { API_TAGS, isPostLaunch, NON_JSON, RESPONSES, tagOf } from './metadata'
import { OPERATION_SUMMARIES } from './summaries'
import type { ScannedOperation } from './operations.generated'

// Builds the OpenAPI 3.1 document of the API (docs/openapi.json) from what the code says: the routes (operations.generated.ts, read from the source by scripts/openapi/scan-routes.ts), the Zod schemas
// the handlers validate with (turned into JSON Schema here), the response types of src/types/api.ts (turned into JSON Schema by the build script and passed in), and the error catalogue.
// Pure and deterministic: the same inputs give the same document, which is what lets a test fail when docs/openapi.json is out of date.

type Json = Record<string, unknown>

export interface BuildInput {
  operations: readonly ScannedOperation[]
  /** JSON Schema per type name of src/types/api.ts (reachable types included), with refs as `#/components/schemas/<name>`. */
  typeSchemas: Record<string, Json>
  version: string
}

const sorted = <T extends Json>(object: T): T => Object.fromEntries(Object.entries(object).sort(([a], [b]) => a.localeCompare(b))) as T

/** A Zod schema as JSON Schema 2020-12 (the dialect of OpenAPI 3.1), without the `$schema` and `definitions` wrapper. */
export function jsonSchemaOf(schema: ZodTypeAny): Json {
  const converted = zodToJsonSchema(schema, { target: 'jsonSchema2019-09', $refStrategy: 'none', effectStrategy: 'input' }) as Json
  delete converted.$schema
  return converted
}

function queryParameters(schema: ZodTypeAny): Json[] {
  const json = jsonSchemaOf(schema) as { properties?: Record<string, Json>; required?: string[] }
  const required = new Set(json.required ?? [])
  return Object.entries(json.properties ?? {}).map(([name, property]) => ({ name, in: 'query', required: required.has(name), schema: property }))
}

const PLACEHOLDER = /\{(\w+)\}/g

/** The names `{like_this}` in the message of an error. */
export const placeholdersOf = (message: string): string[] => [...new Set([...message.matchAll(PLACEHOLDER)].map((m) => m[1]))]

export function operationId(method: string, path: string): string {
  const words = path
    .replace(/^\/api\//, '')
    .split('/')
    .map((segment) => (/^\{.+\}$/.test(segment) ? `By${segment.slice(1, -1).replace(/^./, (c) => c.toUpperCase())}` : segment))
    .join(' ')
    .replace(/\.csv$/g, ' csv')
  const pascal = words.replace(/[^A-Za-z0-9]+(.)?/g, (_, c: string | undefined) => (c ? c.toUpperCase() : '')).replace(/^./, (c) => c.toUpperCase())
  return method.toLowerCase() + pascal
}

export function buildOpenApi(input: BuildInput): Json {
  const paths: Record<string, Record<string, Json>> = {}
  for (const op of input.operations) {
    const key = `${op.method} ${op.path}`
    const tag = tagOf(op.path)
    const parameters: Json[] = []
    for (const name of [...op.path.matchAll(PLACEHOLDER)].map((m) => m[1])) {
      parameters.push({ name, in: 'path', required: true, schema: { type: 'string', maxLength: 200 } })
    }
    if (op.query) parameters.push(...queryParameters(op.query))
    if (op.idempotent) parameters.push({ $ref: '#/components/parameters/IdempotencyKey' })
    if (op.cacheMaxAge !== null) parameters.push({ $ref: '#/components/parameters/IfNoneMatch' })

    const success = RESPONSES[key]
    const status = String(success?.status ?? (op.method === 'POST' && !success ? 200 : 200))
    const headers: Json = { 'X-Request-Id': { $ref: '#/components/headers/RequestId' } }
    if (op.cacheMaxAge !== null) {
      headers['Cache-Control'] = { description: `private, max-age=${op.cacheMaxAge}`, schema: { type: 'string' } }
      headers.ETag = { $ref: '#/components/headers/ETag' }
    }
    const contentType = NON_JSON[key]
    const responses: Record<string, Json> = {
      [status]: {
        description: success ? `${success.type}${op.rewards ? ' (the answer carries a RewardsEnvelope under `rewards`)' : ''}` : 'Success.',
        headers,
        content: contentType
          ? { [contentType]: { schema: { type: 'string', format: 'binary' } } }
          : { 'application/json': { schema: success ? { $ref: `#/components/schemas/${success.type}` } : { type: 'object', additionalProperties: true, description: 'Not typed yet.' } } },
      },
    }
    if (op.cacheMaxAge !== null) responses['304'] = { description: 'The answer has not changed since the ETag in If-None-Match. No body.', headers: { ETag: { $ref: '#/components/headers/ETag' } } }
    if (op.guard === 'withAuth') responses['401'] = { $ref: '#/components/responses/Unauthorized' }
    if (op.roles.length > 0) responses['403'] = { $ref: '#/components/responses/Forbidden' }
    if (op.body || op.query) responses['400'] = { $ref: '#/components/responses/ValidationFailed' }
    if (op.rateLimit) responses['429'] = { $ref: '#/components/responses/RateLimited' }
    if (isPostLaunch(op.path)) responses['503'] = { $ref: '#/components/responses/RomanceClosed' }
    responses.default = { $ref: '#/components/responses/Error' }

    const operation: Json = {
      operationId: operationId(op.method, op.path),
      tags: [tag],
      summary: OPERATION_SUMMARIES[key] ?? (() => { throw new Error(`no summary for ${key}: add it to src/lib/openapi/summaries.ts`) })(),
      ...(op.description ? { description: op.description } : {}),
      ...(parameters.length > 0 ? { parameters } : {}),
      ...(op.body ? { requestBody: { required: true, content: { 'application/json': { schema: jsonSchemaOf(op.body) } } } } : {}),
      responses: Object.fromEntries(Object.entries(responses).sort(([a], [b]) => a.localeCompare(b))),
      security: op.guard === 'withAuth' ? [{ sessionToken: [] }] : [],
      'x-source': op.file,
      ...(op.roles.length > 0 ? { 'x-roles': op.roles } : {}),
      ...(op.rateLimit ? { 'x-rate-limit': { maxRequests: op.rateLimit.max, windowSeconds: op.rateLimit.windowMs / 1000, key: op.rateLimit.key } } : {}),
      ...(op.idempotent ? { 'x-idempotent': true } : {}),
      ...(op.cacheMaxAge !== null ? { 'x-cache-max-age': op.cacheMaxAge } : {}),
      ...(op.rewards ? { 'x-rewards': true } : {}),
      ...(isPostLaunch(op.path) ? { 'x-launch': 'post-launch' } : {}),
      ...(op.guard === 'none' ? { 'x-auth': /webhooks|inngest/.test(op.path) ? 'signature' : /unsubscribe|notifications\/open/.test(op.path) ? 'signed-link' : 'public' } : {}),
    }
    ;(paths[op.path] ??= {})[op.method.toLowerCase()] = operation
  }

  const errorCatalog = Object.fromEntries(
    Object.entries(ERROR_CATALOG)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([code, entry]) => [code, { status: entry.status, message: entry.message, params: placeholdersOf(entry.message) }])
  )

  return {
    openapi: '3.1.0',
    info: {
      title: 'Skill Dating API',
      version: input.version,
      description: [
        'The HTTP API behind Skill Dating, generated from the code: the routes, the Zod schemas the handlers validate with, the response types of `src/types/api.ts` and the error catalogue. The page-by-page guide is `docs/FRONTEND_CONTRACT.md`.',
        '',
        '**Conventions.** JSON in, JSON out. Sign-in is a Clerk session token (`Authorization: Bearer <token>` or the `__session` cookie). Every failure is `{ "error": { "code", "message", "params?", "details?" } }`: branch on `code` (the catalogue is in `x-error-catalog`, with the status and the placeholders of each message). Lists take `limit` and `cursor` (an opaque string) and answer `nextCursor`; `page` still works. Creating routes honour an `Idempotency-Key` header. Routes that pay XP include a `rewards` envelope (`RewardsEnvelope`): level-ups, tier-ups, achievements, the streak. Read-heavy GETs send `Cache-Control: private, max-age=N` and an `ETag`; send `If-None-Match` and get `304`. Every response carries `X-Request-Id`. Rate limits are per person and per route (`x-rate-limit`); a limited call is `429 RATE_LIMITED` with `params.retryAfter`.',
        '',
        '**The romance mode ships closed.** Its routes (tag `Romance (post-launch)`) answer `503 ROMANCE_PAUSED` until it is opened for the caller; the only one that works meanwhile is `/api/romance/interest`.',
      ].join('\n'),
    },
    servers: [{ url: '/', description: 'The deployment this document was fetched from.' }],
    tags: API_TAGS,
    paths: sorted(Object.fromEntries(Object.entries(paths).map(([path, methods]) => [path, methods]))),
    components: {
      securitySchemes: { sessionToken: { type: 'http', scheme: 'bearer', bearerFormat: 'Clerk session token (JWT)', description: 'A Clerk session token, as a Bearer token or in the `__session` cookie.' } },
      parameters: {
        IdempotencyKey: { name: 'Idempotency-Key', in: 'header', required: false, schema: { type: 'string', minLength: 8, maxLength: 200 }, description: 'Makes a repeated request return the first response instead of creating twice (kept for 24 hours).' },
        IfNoneMatch: { name: 'If-None-Match', in: 'header', required: false, schema: { type: 'string' }, description: 'The ETag you hold: the answer is 304 with no body if it is still current.' },
      },
      headers: {
        RequestId: { description: 'One id per request, also on the log lines: quote it in a bug report.', schema: { type: 'string' } },
        ETag: { description: 'A weak validator of the body.', schema: { type: 'string' } },
      },
      responses: {
        Error: { description: 'Any failure: `{ error: { code, message, params?, details? } }`.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
        Unauthorized: { description: '`401 UNAUTHORIZED`: no valid session.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
        Forbidden: { description: '`403 FORBIDDEN`: the role is not enough.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
        ValidationFailed: { description: '`400 VALIDATION_FAILED` with `details` holding the problems by field.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
        RateLimited: { description: '`429 RATE_LIMITED` with `params.retryAfter` in seconds.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
        RomanceClosed: { description: '`503 ROMANCE_PAUSED`: the romance mode is not open for the caller.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
      },
      schemas: sorted({
        ...input.typeSchemas,
        ErrorCode: { type: 'string', enum: Object.keys(ERROR_CATALOG).sort(), description: 'Every code the API can answer with (`x-error-catalog` has the status and the placeholders).' },
      }),
    },
    'x-error-catalog': errorCatalog,
  }
}
