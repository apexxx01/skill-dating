/**
 * tsx scripts/openapi/scan-routes.ts [--check]
 *
 * Reads every route under src/app/api (the TypeScript source, no running) and writes src/lib/openapi/operations.generated.ts: one entry per HTTP method of each route, with what the
 * code itself says: the path, the method, who may call it (withAuth, requiredRole, or none), the rate limit, whether it honours Idempotency-Key, the caching policy, the summary (the comment
 * above the handler), whether it answers with a RewardsEnvelope, and the request schemas it validates with (an import of the very Zod object the handler uses). What the code cannot say (the
 * tag of a page, the response type) is in src/lib/openapi/metadata.ts. With --check it writes nothing and exits 1 if the file on disk is not what the routes say (the unit test does the same).
 */
import fs from 'fs'
import path from 'path'
import ts from 'typescript'

const ROOT = path.resolve(__dirname, '../..')
const API = path.join(ROOT, 'src/app/api')
const OUT = path.join(ROOT, 'src/lib/openapi/operations.generated.ts')
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const

function routeFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return routeFiles(full)
    return entry.name === 'route.ts' ? [full] : []
  })
}

export interface ScannedOperation {
  method: string
  path: string
  file: string
  /** What docs/API.md (or the comment above the handler) says about it, for the operation's description. Empty when neither does. */
  description: string
  /** 'withAuth' routes need a session; 'none' routes check their own proof (a webhook signature, a signed link) or are open. */
  guard: 'withAuth' | 'none'
  roles: string[]
  idempotent: boolean
  rateLimit: { max: number; windowMs: number; key: string } | null
  cacheMaxAge: number | null
  rewards: boolean
  body: string | null
  query: string | null
  /** Where the schema identifiers come from, as import specifiers relative to the route. */
  imports: { name: string; from: string }[]
}

const pascal = (text: string) => text.replace(/[^A-Za-z0-9]+(.)?/g, (_, c: string | undefined) => (c ? c.toUpperCase() : '')).replace(/^./, (c) => c.toUpperCase())

export function openApiPathOf(file: string): string {
  const relative = path.relative(API, path.dirname(file)).split(path.sep).filter(Boolean)
  const segments = relative.map((segment) => {
    const catchAll = /^\[\.\.\.(.+)\]$/.exec(segment)
    if (catchAll) return `{${catchAll[1]}}`
    const param = /^\[(.+)\]$/.exec(segment)
    return param ? `{${param[1]}}` : segment
  })
  return '/api' + (segments.length ? '/' + segments.join('/') : '')
}

function commentAbove(sf: ts.SourceFile, node: ts.Node): string {
  const text = sf.getFullText()
  const ranges = ts.getLeadingCommentRanges(text, node.getFullStart()) ?? []
  const lines: string[] = []
  // The block of line comments directly above the handler.
  for (const range of ranges) {
    const comment = text.slice(range.pos, range.end)
    lines.push(...comment.split('\n').map((line) => line.replace(/^\s*(\/\/+|\/\*+|\*+\/?|\*)\s?/, '').replace(/\*\/\s*$/, '').trimEnd()))
  }
  return lines.join('\n')
}

/** The first sentence of the comment, without the notation of the route documents ("GET /api/...: " prefixes). */
function summaryOf(comment: string, fallback: string): string {
  const paragraphs = comment
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/\n\s*/g, ' ').trim())
    .filter(Boolean)
  const first = (paragraphs[0] ?? '')
    .replace(/^(GET|POST|PUT|PATCH|DELETE)\s+\/\S+\s*[:-]?\s*/i, '')
    .replace(/^\/api\/\S+\s*[:-]?\s*/, '')
  const sentence = /^(.+?[.!?])(\s|$)/.exec(first)?.[1] ?? first
  const cleaned = sentence.trim()
  return (cleaned.length >= 12 ? cleaned : fallback).slice(0, 240)
}

/** "METHOD /path" (parameters as {name}) to the paragraph docs/API.md has under the heading that names it: the reference written by people, quoted as the operation's description. */
function apiDocSummaries(): Map<string, string> {
  const out = new Map<string, string>()
  const lines = fs.readFileSync(path.join(ROOT, 'docs/API.md'), 'utf-8').split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('### ')) continue
    const keys = [...lines[i].matchAll(/`(GET|POST|PUT|PATCH|DELETE) (\/api\/[^`\s]*)`/g)].map((m) => `${m[1]} ${m[2].replace(/\[\.\.\.?(\w+)\]/g, '{$1}').replace(/\[(\w+)\]/g, '{$1}')}`)
    if (keys.length === 0) continue
    const paragraph: string[] = []
    for (let j = i + 1; j < lines.length && !lines[j].startsWith('#'); j++) {
      if (lines[j].trim() === '' && paragraph.length > 0) break
      if (lines[j].trim() !== '' && !lines[j].startsWith('|') && !lines[j].startsWith('```')) paragraph.push(lines[j].trim())
    }
    const text = paragraph.join(' ').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim()
    if (text.length >= 14) for (const key of keys) if (!out.has(key)) out.set(key, text.slice(0, 900))
  }
  return out
}

function literal(node: ts.Expression | undefined): unknown {
  if (!node) return undefined
  if (ts.isNumericLiteral(node)) return Number(node.text.replace(/_/g, ''))
  if (ts.isStringLiteralLike(node)) return node.text
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false
  if (ts.isArrayLiteralExpression(node)) return node.elements.map((element) => literal(element))
  // `cond ? a : b`: the document describes what the deployment does (the second branch is the production one).
  if (ts.isConditionalExpression(node)) return literal(node.whenFalse)
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AsteriskToken) return (literal(node.left) as number) * (literal(node.right) as number)
  if (ts.isObjectLiteralExpression(node)) {
    const out: Record<string, unknown> = {}
    for (const property of node.properties) if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name)) out[property.name.text] = literal(property.initializer)
    return out
  }
  return undefined
}

function scan(file: string, docs: Map<string, string>): ScannedOperation[] {
  const text = fs.readFileSync(file, 'utf-8')
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const routePath = openApiPathOf(file)
  const imports = new Map<string, string>()
  const localSchemas = new Map<string, string>()
  const schemaFile = path.join(path.dirname(file), 'schema.ts')
  const schemaNames = new Set<string>()
  if (fs.existsSync(schemaFile)) {
    const schemaSf = ts.createSourceFile(schemaFile, fs.readFileSync(schemaFile, 'utf-8'), ts.ScriptTarget.Latest, true)
    for (const statement of schemaSf.statements) {
      if (ts.isVariableStatement(statement) && statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) for (const d of statement.declarationList.declarations) if (ts.isIdentifier(d.name)) schemaNames.add(d.name.text)
    }
  }
  for (const statement of sf.statements) {
    if (ts.isImportDeclaration(statement) && statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings)) {
      for (const element of statement.importClause.namedBindings.elements) imports.set(element.name.text, (statement.moduleSpecifier as ts.StringLiteral).text)
    }
  }
  void localSchemas

  const out: ScannedOperation[] = []
  for (const statement of sf.statements) {
    let method: string | null = null
    let initializer: ts.Expression | null = null
    if (ts.isVariableStatement(statement) && statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
      const declaration = statement.declarationList.declarations[0]
      if (ts.isIdentifier(declaration.name) && (METHODS as readonly string[]).includes(declaration.name.text)) {
        method = declaration.name.text
        initializer = declaration.initializer ?? null
      }
    } else if (ts.isFunctionDeclaration(statement) && statement.name && statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) && (METHODS as readonly string[]).includes(statement.name.text)) {
      method = statement.name.text
    }
    if (!method) continue

    const region = statement.getText()
    let guard: 'withAuth' | 'none' = 'none'
    let options: Record<string, unknown> = {}
    if (initializer && ts.isCallExpression(initializer) && ts.isIdentifier(initializer.expression) && initializer.expression.text === 'withAuth') {
      guard = 'withAuth'
      options = (literal(initializer.arguments[1]) as Record<string, unknown> | undefined) ?? {}
    }
    const rate = options.rateLimit as { windowMs?: number; maxRequests?: number; keyPrefix?: string } | undefined
    const find = (callee: 'validateBody' | 'validateQuery'): string | null => {
      const match = new RegExp(`${callee}\\(\\s*([A-Za-z_][A-Za-z0-9_]*)\\s*\\)`).exec(region)
      return match ? match[1] : null
    }
    const body = find('validateBody')
    const query = find('validateQuery')
    const used: { name: string; from: string }[] = []
    for (const name of [body, query]) {
      if (!name) continue
      const from = imports.get(name) ?? (schemaNames.has(name) ? './schema' : null)
      if (!from) throw new Error(`${path.relative(ROOT, file)}: cannot tell where ${name} comes from`)
      used.push({ name, from })
    }
    const fallback = `${method} ${routePath}`
    out.push({
      method,
      path: routePath,
      file: path.relative(ROOT, file).split(path.sep).join('/'),
      description: docs.get(fallback) ?? (summaryOf(commentAbove(sf, statement), '') || ''),
      guard,
      roles: (options.requiredRole as string[] | undefined) ?? [],
      idempotent: options.idempotent === true,
      rateLimit: rate && typeof rate.maxRequests === 'number' ? { max: rate.maxRequests, windowMs: rate.windowMs ?? 60000, key: rate.keyPrefix ?? '' } : null,
      cacheMaxAge: typeof (options.cache as { maxAge?: number } | undefined)?.maxAge === 'number' ? (options.cache as { maxAge: number }).maxAge : null,
      rewards: /rewardsFor\(|currentRewards\(|rewards:/.test(region),
      body,
      query,
      imports: used,
    })
  }
  return out
}

/** The text of operations.generated.ts for the routes as they are. */
export function generate(): string {
  const docs = apiDocSummaries()
  const operations = routeFiles(API)
    .sort()
    .flatMap((file) => scan(file, docs))
    .sort((a, b) => a.path.localeCompare(b.path) || METHODS.indexOf(a.method as never) - METHODS.indexOf(b.method as never))

  // One import per schema, aliased by operation, from the module that really exports it (absolute for @/ paths, via the app/api path for a route's own schema.ts).
  const importLines: string[] = []
  const alias = (op: ScannedOperation, role: 'body' | 'query', name: string, from: string) => {
    const id = `${op.method.toLowerCase()}${pascal(op.path.replace(/^\/api\//, '').replace(/[{}]/g, ''))}_${role}`
    const routeDir = path.dirname(op.file)
    const module = from === './schema' ? '@/' + path.join(routeDir.replace(/^src\//, ''), 'schema').split(path.sep).join('/') : from.startsWith('.') ? '@/' + path.relative(path.join(ROOT, 'src'), path.resolve(ROOT, routeDir, from)).split(path.sep).join('/') : from
    importLines.push(`import { ${name} as ${id} } from '${module}'`)
    return id
  }
  const rows = operations.map((op) => {
    const body = op.body ? alias(op, 'body', op.body, op.imports.find((i) => i.name === op.body)!.from) : null
    const query = op.query ? alias(op, 'query', op.query, op.imports.find((i) => i.name === op.query)!.from) : null
    const data = {
      method: op.method,
      path: op.path,
      file: op.file,
      description: op.description,
      guard: op.guard,
      roles: op.roles,
      idempotent: op.idempotent,
      rateLimit: op.rateLimit,
      cacheMaxAge: op.cacheMaxAge,
      rewards: op.rewards,
    }
    return `  { ...${JSON.stringify(data)}, body: ${body ?? 'null'}, query: ${query ?? 'null'} },`
  })
  return `// GENERATED by scripts/openapi/scan-routes.ts from the routes under src/app/api: do not edit. Regenerate with \`npm run openapi:scan\`; a unit test fails when this file and the routes disagree.
import type { ZodTypeAny } from 'zod'
${[...new Set(importLines)].sort().join('\n')}

export interface ScannedOperation {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  path: string
  file: string
  description: string
  guard: 'withAuth' | 'none'
  roles: string[]
  idempotent: boolean
  rateLimit: { max: number; windowMs: number; key: string } | null
  cacheMaxAge: number | null
  rewards: boolean
  body: ZodTypeAny | null
  query: ZodTypeAny | null
}

export const SCANNED_OPERATIONS: readonly ScannedOperation[] = [
${rows.join('\n')}
]
`
}

if (require.main === module) {
  const text = generate()
  if (process.argv.includes('--check')) {
    const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf-8') : ''
    if (current !== text) {
      console.error('src/lib/openapi/operations.generated.ts is out of date: run npm run openapi:scan')
      process.exit(1)
    }
    console.log('operations.generated.ts is up to date')
  } else {
    fs.mkdirSync(path.dirname(OUT), { recursive: true })
    fs.writeFileSync(OUT, text)
    console.log(`wrote ${path.relative(ROOT, OUT)}`)
  }
}
