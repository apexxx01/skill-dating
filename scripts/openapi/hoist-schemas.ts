/**
 * tsx scripts/openapi/hoist-schemas.ts [--write]
 *
 * One-time refactor that makes every API route's request schemas importable. A Next.js route file may export nothing but its handlers, so a Zod schema declared inside it
 * (`const createPostSchema = z.object({...})`) cannot be reached by anything else, which is what the OpenAPI spec needs. This moves each such declaration (and the constants only
 * it depends on) into a `schema.ts` beside the route, exported, and imports it back. Behaviour does not change. Without --write it only says what it would do.
 */
import fs from 'fs'
import path from 'path'
import ts from 'typescript'

const ROOT = path.resolve(__dirname, '../..')
const API = path.join(ROOT, 'src/app/api')
const WRITE = process.argv.includes('--write')

function routeFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return routeFiles(full)
    return entry.name === 'route.ts' ? [full] : []
  })
}

interface ImportInfo {
  declaration: ts.ImportDeclaration
  /** local name -> the specifier text ("Foo" or "Foo as Bar" or "* as ns" or default). */
  names: Map<string, string>
}

function identifiersIn(node: ts.Node): Set<string> {
  const out = new Set<string>()
  const visit = (n: ts.Node) => {
    if (ts.isIdentifier(n)) out.add(n.text)
    ts.forEachChild(n, visit)
  }
  visit(node)
  return out
}

/** Identifiers that are used as values or types in `node`, excluding property names after a dot and object keys. */
function usedNames(node: ts.Node): Set<string> {
  const out = new Set<string>()
  const visit = (n: ts.Node) => {
    if (ts.isIdentifier(n)) {
      const parent = n.parent
      if (parent && ts.isPropertyAccessExpression(parent) && parent.name === n) return
      if (parent && ts.isPropertyAssignment(parent) && parent.name === n) return
      if (parent && (ts.isPropertySignature(parent) || ts.isMethodDeclaration(parent)) && parent.name === n) return
      out.add(n.text)
    }
    ts.forEachChild(n, visit)
  }
  visit(node)
  return out
}

function importsOf(sf: ts.SourceFile): ImportInfo[] {
  const out: ImportInfo[] = []
  for (const statement of sf.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause) continue
    const names = new Map<string, string>()
    const clause = statement.importClause
    if (clause.name) names.set(clause.name.text, clause.name.text)
    if (clause.namedBindings) {
      if (ts.isNamespaceImport(clause.namedBindings)) names.set(clause.namedBindings.name.text, `* as ${clause.namedBindings.name.text}`)
      else for (const element of clause.namedBindings.elements) names.set(element.name.text, element.getText())
    }
    out.push({ declaration: statement, names })
  }
  return out
}

function isZodInitializer(node: ts.Expression): boolean {
  let root: ts.Node = node
  while (true) {
    if (ts.isCallExpression(root)) root = root.expression
    else if (ts.isPropertyAccessExpression(root)) root = root.expression
    else if (ts.isParenthesizedExpression(root) || ts.isAsExpression(root) || ts.isNonNullExpression(root)) root = root.expression
    else break
  }
  return ts.isIdentifier(root) && root.text === 'z'
}

interface Planned {
  file: string
  moved: string[]
  schemaText: string
  routeText: string
}

function plan(file: string): Planned | { file: string; skipped: string } | null {
  const text = fs.readFileSync(file, 'utf-8')
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const imports = importsOf(sf)
  const importedBy = new Map<string, ImportInfo>()
  for (const info of imports) for (const name of info.names.keys()) importedBy.set(name, info)

  // Top-level non-exported constants and what they use.
  const consts = new Map<string, { statement: ts.VariableStatement; initializer: ts.Expression; deps: Set<string>; zod: boolean }>()
  const functions = new Set<string>()
  for (const statement of sf.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) functions.add(statement.name.text)
    if (!ts.isVariableStatement(statement)) continue
    if (statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue
    if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0 || statement.declarationList.declarations.length !== 1) continue
    const declaration = statement.declarationList.declarations[0]
    if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue
    consts.set(declaration.name.text, { statement, initializer: declaration.initializer, deps: usedNames(declaration.initializer), zod: isZodInitializer(declaration.initializer) })
  }
  // A constant is a schema when it starts from `z`, or builds on another schema.
  const isSchema = (name: string, seen = new Set<string>()): boolean => {
    const entry = consts.get(name)
    if (!entry || seen.has(name)) return false
    if (entry.zod) return true
    seen.add(name)
    return [...entry.deps].some((dep) => consts.has(dep) && isSchema(dep, seen))
  }
  const roots = [...consts.keys()].filter((name) => isSchema(name))
  if (roots.length === 0) return null

  // What they need from the file: other constants (moved with them) and imports (copied).
  const moved = new Set<string>()
  const queue = [...roots]
  while (queue.length > 0) {
    const name = queue.pop()!
    if (moved.has(name)) continue
    moved.add(name)
    for (const dep of consts.get(name)!.deps) {
      if (functions.has(dep)) return { file, skipped: `${name} uses the function ${dep}` }
      if (consts.has(dep)) queue.push(dep)
    }
  }

  const movedStatements = [...moved].map((name) => consts.get(name)!.statement).sort((a, b) => a.getStart() - b.getStart())
  const movedRanges = new Set(movedStatements)
  const needed = new Set<string>()
  for (const name of moved) for (const dep of consts.get(name)!.deps) if (importedBy.has(dep)) needed.add(dep)

  // The schema file: the imports it needs, then the declarations, exported.
  const importLines: string[] = []
  for (const info of imports) {
    const wanted = [...info.names.entries()].filter(([name]) => needed.has(name))
    if (wanted.length === 0) continue
    const declaration = info.declaration
    const clause = declaration.importClause!
    const typeOnly = clause.isTypeOnly ? 'type ' : ''
    const defaults = clause.name && wanted.some(([name]) => name === clause.name!.text) ? clause.name.text : null
    const namespace = clause.namedBindings && ts.isNamespaceImport(clause.namedBindings) && wanted.some(([name]) => name === (clause.namedBindings as ts.NamespaceImport).name.text) ? `* as ${(clause.namedBindings as ts.NamespaceImport).name.text}` : null
    const named = clause.namedBindings && ts.isNamedImports(clause.namedBindings) ? wanted.filter(([name]) => name !== defaults).map(([, spec]) => spec) : []
    const parts = [defaults, namespace, named.length > 0 ? `{ ${named.join(', ')} }` : null].filter(Boolean)
    importLines.push(`import ${typeOnly}${parts.join(', ')} from ${declaration.moduleSpecifier.getText()}`)
  }
  const body = movedStatements.map((statement) => {
    const leading = text.slice(statement.getFullStart(), statement.getStart()).trim()
    const code = statement.getText().replace(/^const /, 'export const ')
    return `${leading ? leading + '\n' : ''}${code}`
  })
  const schemaText = `${importLines.join('\n')}${importLines.length ? '\n\n' : ''}// The request schemas of ${path.relative(API, path.dirname(file)) || '/api'}, in a file of their own: a Next.js route may export nothing but its handlers, and the OpenAPI spec (docs/openapi.json,\n// src/lib/openapi) reads these.\n\n${body.join('\n\n')}\n`

  // The route file: without them, importing back what the rest of the file still uses, and without the imports that nothing uses any more.
  const removeRanges = movedStatements.map((statement) => [statement.getFullStart(), statement.getEnd()] as const)
  let routeText = ''
  let cursor = 0
  for (const [start, end] of removeRanges) {
    routeText += text.slice(cursor, start)
    cursor = end
  }
  routeText += text.slice(cursor)
  const rest = ts.createSourceFile(file, routeText, ts.ScriptTarget.Latest, true)
  const stillUsed = new Set<string>()
  for (const statement of rest.statements) if (!ts.isImportDeclaration(statement)) for (const name of usedNames(statement)) stillUsed.add(name)
  const backImports = [...moved].filter((name) => stillUsed.has(name)).sort()

  // Rewrite the imports of the route.
  let out = ''
  let last = 0
  let lastImportEnd = 0
  for (const info of importsOf(rest)) {
    const declaration = info.declaration
    const keep = [...info.names.entries()].filter(([name]) => stillUsed.has(name) || backImports.includes(name))
    const start = declaration.getFullStart()
    const end = declaration.getEnd()
    out += routeText.slice(last, start)
    last = end
    if (keep.length === info.names.size) {
      out += routeText.slice(start, end)
    } else if (keep.length > 0) {
      const clause = declaration.importClause!
      const defaults = clause.name && keep.some(([name]) => name === clause.name!.text) ? clause.name.text : null
      const named = clause.namedBindings && ts.isNamedImports(clause.namedBindings) ? keep.filter(([name]) => name !== defaults).map(([, spec]) => spec) : []
      const namespace = clause.namedBindings && ts.isNamespaceImport(clause.namedBindings) ? `* as ${clause.namedBindings.name.text}` : null
      const parts = [defaults, namespace, named.length > 0 ? `{ ${named.join(', ')} }` : null].filter(Boolean)
      out += `${routeText.slice(start, declaration.getStart())}import ${clause.isTypeOnly ? 'type ' : ''}${parts.join(', ')} from ${declaration.moduleSpecifier.getText()}`
    }
    lastImportEnd = out.length
  }
  out += routeText.slice(last)
  void lastImportEnd
  if (backImports.length > 0) {
    const insertAt = (() => {
      const sf2 = ts.createSourceFile(file, out, ts.ScriptTarget.Latest, true)
      let end = 0
      for (const statement of sf2.statements) if (ts.isImportDeclaration(statement)) end = statement.getEnd()
      return end
    })()
    out = `${out.slice(0, insertAt)}\nimport { ${backImports.join(', ')} } from './schema'${out.slice(insertAt)}`
  }
  void movedRanges
  return { file, moved: [...moved], schemaText, routeText: out }
}

function main() {
  let planned = 0
  const skipped: string[] = []
  for (const file of routeFiles(API).sort()) {
    const schemaFile = path.join(path.dirname(file), 'schema.ts')
    if (fs.existsSync(schemaFile)) continue
    const result = plan(file)
    if (!result) continue
    if ('skipped' in result) {
      skipped.push(`${path.relative(ROOT, file)}: ${result.skipped}`)
      continue
    }
    planned += 1
    console.log(`${path.relative(ROOT, file)}: ${result.moved.join(', ')}`)
    if (WRITE) {
      fs.writeFileSync(schemaFile, result.schemaText)
      fs.writeFileSync(file, result.routeText)
    }
  }
  console.log(`\n${planned} route files ${WRITE ? 'rewritten' : 'would be rewritten'}${skipped.length ? `; skipped:\n  ${skipped.join('\n  ')}` : ''}`)
}

main()
