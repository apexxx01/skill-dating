import fs from 'fs'
import path from 'path'
import ts from 'typescript'

// Finds every Zod string, array and record in the source that accepts unbounded input: a `z.string()` with no maximum length, a `z.array()` with no
// maximum length, a `z.record()`, `z.any()` or `z.unknown()`. Used by schema-audit.test.ts, which fails on any finding outside the short list of
// places where the input is not a request (the environment, which the operator writes). Parsing is done with the TypeScript compiler.
//
// A string counts as bounded by `.max()`, `.length()`, a format with a fixed shape (`.uuid()`, `.cuid()`, `.cuid2()`, `.ulid()`, `.datetime()`,
// `.date()`, `.time()`, `.ip()`), or a `.regex()` whose pattern is anchored at both ends and has no unbounded repetition. Every request body is also
// capped as a whole (MAX_BODY_BYTES in src/lib/api/handler.ts), so this is about each field, not the total.

export const SRC_DIR = path.resolve(__dirname, '../..')

export interface SchemaFinding {
  file: string
  line: number
  kind: 'string' | 'array' | 'record' | 'any' | 'unknown'
  text: string
}

const STRING_BOUNDS = new Set(['max', 'length', 'uuid', 'cuid', 'cuid2', 'ulid', 'datetime', 'date', 'time', 'ip'])
const ARRAY_BOUNDS = new Set(['max', 'length'])

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    return entry.isDirectory() ? walk(full) : [full]
  })
}

/** A regex anchored at both ends with no `*`, `+` or open-ended `{n,}`: it can only match strings up to a fixed length. */
export function isBoundedPattern(pattern: string): boolean {
  const body = pattern.replace(/^\/|\/[a-z]*$/g, '')
  if (!body.startsWith('^') || !body.endsWith('$')) return false
  // Escapes and character classes say which characters, not how many: only what is outside them can repeat.
  const unescaped = body.replace(/\\./g, '').replace(/\[[^\]]*\]/g, 'c')
  return !/[*+]/.test(unescaped) && !/\{\d+,\}/.test(unescaped)
}

/** Whether `node` is `z.<name>(...)` or `z.coerce.<name>(...)`. */
function zodFactory(node: ts.CallExpression): string | null {
  const callee = node.expression
  if (!ts.isPropertyAccessExpression(callee)) return null
  const target = callee.expression
  const isZ = (e: ts.Expression) => ts.isIdentifier(e) && e.text === 'z'
  if (isZ(target) || (ts.isPropertyAccessExpression(target) && target.name.text === 'coerce' && isZ(target.expression))) return callee.name.text
  return null
}

/** The method names chained onto `node` (`.min(1).max(5).optional()` gives min, max, optional), with each call's arguments. */
function chainOf(node: ts.Expression): { name: string; args: ts.NodeArray<ts.Expression> }[] {
  const chain: { name: string; args: ts.NodeArray<ts.Expression> }[] = []
  let current: ts.Node = node
  while (ts.isPropertyAccessExpression(current.parent) && current.parent.expression === current && ts.isCallExpression(current.parent.parent)) {
    chain.push({ name: current.parent.name.text, args: current.parent.parent.arguments })
    current = current.parent.parent
  }
  return chain
}

function isBoundedString(chain: { name: string; args: ts.NodeArray<ts.Expression> }[]): boolean {
  return chain.some((link) => {
    if (STRING_BOUNDS.has(link.name)) return true
    if (link.name === 'regex' && link.args[0] && ts.isRegularExpressionLiteral(link.args[0])) return isBoundedPattern(link.args[0].text)
    return false
  })
}

export function auditSchemaFile(file: string): SchemaFinding[] {
  const text = fs.readFileSync(file, 'utf-8')
  if (!/\bz\./.test(text)) return []
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const findings: SchemaFinding[] = []
  const report = (node: ts.Node, kind: SchemaFinding['kind']) =>
    findings.push({ file: path.relative(SRC_DIR, file), line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1, kind, text: node.getText().slice(0, 80) })
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const factory = zodFactory(node)
      if (factory === 'string' && !isBoundedString(chainOf(node))) report(node, 'string')
      if (factory === 'array' && !chainOf(node).some((link) => ARRAY_BOUNDS.has(link.name))) report(node, 'array')
      if (factory === 'record') report(node, 'record')
      if (factory === 'any') report(node, 'any')
      if (factory === 'unknown') report(node, 'unknown')
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return findings
}

/** Every finding in the application source, tests excluded. */
export function auditAllSchemas(): SchemaFinding[] {
  return walk(SRC_DIR)
    .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file) && !file.includes(`${path.sep}components${path.sep}`))
    .flatMap(auditSchemaFile)
}
