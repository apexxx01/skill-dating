import { describe, it, expect } from 'vitest'
import { auditAllSchemas, isBoundedPattern } from './schema-audit'

// No request schema may accept an unbounded string or array (or a free-form record): every field has a maximum. The two exemptions are the
// environment (written by the operator, not a request) and the helpers that build the bounded records themselves.
const EXEMPT_FILES = new Set(['lib/env.ts', 'lib/api/limits.ts'])

describe('schema audit', () => {
  it('finds no unbounded string, array, record, any or unknown in a request schema', () => {
    const findings = auditAllSchemas().filter((finding) => !EXEMPT_FILES.has(finding.file))
    expect(findings.map((f) => `${f.file}:${f.line} ${f.kind} ${f.text}`)).toEqual([])
  })

  it('still sees the unbounded strings in the exempt environment schema, so the scan is working', () => {
    expect(auditAllSchemas().some((finding) => finding.file === 'lib/env.ts' && finding.kind === 'string')).toBe(true)
  })

  it('treats an anchored pattern without open-ended repetition as bounded', () => {
    expect(isBoundedPattern('/^[a-z0-9][a-z0-9+#.\\-]{0,29}$/')).toBe(true)
    expect(isBoundedPattern('/^[0-9a-f]{64}$/')).toBe(true)
    expect(isBoundedPattern('/^[a-z]+$/')).toBe(false)
    expect(isBoundedPattern('/^a{2,}$/')).toBe(false)
    expect(isBoundedPattern('/[a-z]{3}/')).toBe(false)
  })
})
