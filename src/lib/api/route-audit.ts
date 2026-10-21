import fs from 'fs'
import path from 'path'
import ts from 'typescript'

// Reads every API route's source and reports how each exported handler is protected: whether it is wrapped in withAuth, which roles it requires, and
// its rate limit. Used by the route audit test (route-audit.test.ts) and by nothing at runtime. Parsing is done with the TypeScript compiler, so the
// answer is exact, not a guess from a regular expression.

export const API_DIR = path.resolve(__dirname, '../../app/api')
export const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const
export type Method = (typeof METHODS)[number]

export interface RouteHandlerInfo {
  /** URL path with dynamic segments as [name], e.g. /api/teams/[id]/slots. */
  path: string
  file: string
  method: Method
  wrapped: boolean
  requiredRole: string[] | null
  rateLimit: { windowMs: number; maxRequests: number; keyPrefix: string } | null
  idempotent: boolean
}

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    return entry.isDirectory() ? walk(full) : [full]
  })
}

export function routeFiles(): string[] {
  return walk(API_DIR).filter((file) => /[\\/]route\.ts$/.test(file))
}

export function urlPathOf(file: string): string {
  const relative = path.relative(API_DIR, path.dirname(file)).split(path.sep).filter(Boolean)
  return '/api' + (relative.length ? '/' + relative.join('/') : '')
}

/** Evaluates a numeric literal expression such as `60000`, `60_000` or `60 * 60 * 1000`. */
function numberOf(node: ts.Expression): number | null {
  if (ts.isNumericLiteral(node)) return Number(node.text.replace(/_/g, ''))
  if (ts.isParenthesizedExpression(node)) return numberOf(node.expression)
  if (ts.isBinaryExpression(node)) {
    const left = numberOf(node.left)
    const right = numberOf(node.right)
    if (left === null || right === null) return null
    if (node.operatorToken.kind === ts.SyntaxKind.AsteriskToken) return left * right
    if (node.operatorToken.kind === ts.SyntaxKind.PlusToken) return left + right
  }
  return null
}

function property(object: ts.ObjectLiteralExpression, name: string): ts.Expression | null {
  for (const prop of object.properties) {
    if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === name) return prop.initializer
  }
  return null
}

function readOptions(options: ts.Expression | undefined): Pick<RouteHandlerInfo, 'requiredRole' | 'rateLimit' | 'idempotent'> {
  const out: Pick<RouteHandlerInfo, 'requiredRole' | 'rateLimit' | 'idempotent'> = { requiredRole: null, rateLimit: null, idempotent: false }
  if (!options || !ts.isObjectLiteralExpression(options)) return out
  const roles = property(options, 'requiredRole')
  if (roles && ts.isArrayLiteralExpression(roles)) out.requiredRole = roles.elements.filter(ts.isStringLiteral).map((e) => e.text)
  const limit = property(options, 'rateLimit')
  if (limit && ts.isObjectLiteralExpression(limit)) {
    const windowMs = property(limit, 'windowMs')
    const maxRequests = property(limit, 'maxRequests')
    const keyPrefix = property(limit, 'keyPrefix')
    out.rateLimit = {
      windowMs: windowMs ? numberOf(windowMs) ?? NaN : NaN,
      maxRequests: maxRequests ? numberOf(maxRequests) ?? NaN : NaN,
      keyPrefix: keyPrefix && ts.isStringLiteral(keyPrefix) ? keyPrefix.text : '',
    }
  }
  const idempotent = property(options, 'idempotent')
  out.idempotent = idempotent?.kind === ts.SyntaxKind.TrueKeyword
  return out
}

export function auditRouteFile(file: string): RouteHandlerInfo[] {
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf-8'), ts.ScriptTarget.Latest, true)
  const handlers: RouteHandlerInfo[] = []
  const base = { path: urlPathOf(file), file }
  for (const statement of source.statements) {
    const exported = ts.getModifiers(statement as ts.HasModifiers)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    if (!exported) continue
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !(METHODS as readonly string[]).includes(declaration.name.text)) continue
        const init = declaration.initializer
        const wrapped = Boolean(init && ts.isCallExpression(init) && ts.isIdentifier(init.expression) && init.expression.text === 'withAuth')
        const options = wrapped ? readOptions((init as ts.CallExpression).arguments[1]) : { requiredRole: null, rateLimit: null, idempotent: false }
        handlers.push({ ...base, method: declaration.name.text as Method, wrapped, ...options })
      }
    } else if (ts.isFunctionDeclaration(statement) && statement.name && (METHODS as readonly string[]).includes(statement.name.text)) {
      handlers.push({ ...base, method: statement.name.text as Method, wrapped: false, requiredRole: null, rateLimit: null, idempotent: false })
    }
  }
  return handlers
}

export function auditAllRoutes(): RouteHandlerInfo[] {
  return routeFiles().flatMap(auditRouteFile)
}

/** Requests a minute a limit allows. */
export const perMinute = (limit: { windowMs: number; maxRequests: number }) => (limit.maxRequests * 60_000) / limit.windowMs
