import { describe, expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'
import { ERROR_CATALOG, errorBody, errorMessage, errorResponse, errorStatus, isErrorCode, type ErrorCode } from './errors'

const codes = Object.keys(ERROR_CATALOG) as ErrorCode[]

describe('catalog', () => {
  it('names every code in MACHINE_CASE', () => {
    for (const code of codes) expect(code, code).toMatch(/^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$/)
  })

  it('gives every code an HTTP error status and an English message', () => {
    for (const code of codes) {
      const spec = ERROR_CATALOG[code]
      expect(spec.status, code).toBeGreaterThanOrEqual(400)
      expect(spec.status, code).toBeLessThan(600)
      expect(spec.message.trim().length, code).toBeGreaterThan(0)
    }
  })

  it('does not give two codes the same message, which would make them indistinguishable to read', () => {
    const seen = new Map<string, string>()
    for (const code of codes) {
      const message = ERROR_CATALOG[code].message
      expect(seen.get(message), `${code} repeats the message of ${seen.get(message)}`).toBeUndefined()
      seen.set(message, code)
    }
  })

  it('uses only simple {word} placeholders', () => {
    for (const code of codes) {
      const braces = ERROR_CATALOG[code].message.match(/[{}]/g) ?? []
      const placeholders = ERROR_CATALOG[code].message.match(/\{\w+\}/g) ?? []
      expect(braces.length, code).toBe(placeholders.length * 2)
    }
  })

  it('recognises codes and nothing else', () => {
    expect(isErrorCode('TEAM_FULL')).toBe(true)
    expect(isErrorCode('Team is full')).toBe(false)
    expect(isErrorCode('toString')).toBe(false)
    expect(isErrorCode(undefined)).toBe(false)
  })
})

describe('rendering', () => {
  it('fills placeholders from params', () => {
    expect(errorMessage('EVIDENCE_LIMIT_REACHED', { max: 20 })).toBe('You can attach at most 20 pieces of evidence to one skill')
    expect(errorMessage('HACKATHON_INVALID_TRANSITION', { from: 'ENDED', to: 'ACTIVE' })).toBe('Cannot transition hackathon from ENDED to ACTIVE')
  })

  it('leaves a missing param visible rather than printing undefined', () => {
    expect(errorMessage('EVIDENCE_LIMIT_REACHED')).toBe('You can attach at most {max} pieces of evidence to one skill')
  })

  it('builds the minimal body: code and message only', () => {
    expect(errorBody('TEAM_FULL')).toEqual({ error: { code: 'TEAM_FULL', message: 'Team is full' } })
  })

  it('includes params and details only when given', () => {
    expect(errorBody('RATE_LIMITED', { params: { retryAfter: 7 } })).toEqual({
      error: { code: 'RATE_LIMITED', message: 'Too many requests. Try again in 7 seconds', params: { retryAfter: 7 } },
    })
    expect(errorBody('VALIDATION_FAILED', { details: { name: ['Required'] } }).error.details).toEqual({ name: ['Required'] })
    expect('params' in errorBody('TEAM_FULL', { params: {} }).error).toBe(false)
  })

  it('takes the HTTP status from the catalog and sends the headers it is given', async () => {
    const response = errorResponse('RATE_LIMITED', { params: { retryAfter: 3 }, headers: { 'Retry-After': '3' } })
    expect(response.status).toBe(429)
    expect(response.headers.get('retry-after')).toBe('3')
    expect((await response.json()).error.code).toBe('RATE_LIMITED')
    expect(errorStatus('UNAUTHORIZED')).toBe(401)
  })
})

// No route may answer an error in some other shape: a hand-built
// { error: '...' } is exactly how the contract erodes. Everything goes through
// createApiError / errorResponse.
describe('no raw error bodies', () => {
  const root = path.resolve(__dirname, '../..')
  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name)
      return entry.isDirectory() ? walk(full) : /\.(ts|tsx)$/.test(entry.name) && !/\.test\.ts$/.test(entry.name) ? [full] : []
    })

  it('finds none in the API routes or the libraries behind them', () => {
    const offenders: string[] = []
    for (const file of [...walk(path.join(root, 'app/api')), ...walk(path.join(root, 'lib'))]) {
      const source = fs.readFileSync(file, 'utf-8')
      if (/NextResponse\.json\(\s*\{\s*error\s*:/.test(source)) offenders.push(path.relative(root, file))
      if (/status\s*:\s*[45]\d\d/.test(source) && /NextResponse\.json\(/.test(source) && !file.endsWith('errors.ts')) {
        offenders.push(`${path.relative(root, file)} (builds an error status by hand)`)
      }
    }
    expect(offenders).toEqual([])
  })
})
