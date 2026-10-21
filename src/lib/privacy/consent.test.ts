import { describe, it, expect } from 'vitest'
import versions from '@/config/legal-versions.json'
import { consentStates, missingRequired, staleRequired } from './consent'

const at = (iso: string) => new Date(iso)

describe('consentStates', () => {
  it('reads the current versions from config', () => {
    expect(consentStates([]).TERMS.currentVersion).toBe(versions.TERMS)
  })

  it('is missing everything for a person who never consented, and stale for nobody', () => {
    const states = consentStates([])
    expect(missingRequired(states)).toEqual(['TERMS', 'PRIVACY'])
    expect(staleRequired(states)).toEqual([])
  })

  it('is current for the current version, stale for an older one', () => {
    const states = consentStates([
      { type: 'TERMS', version: versions.TERMS, grantedAt: at('2026-10-02T00:00:00Z'), withdrawnAt: null },
      { type: 'PRIVACY', version: '2025-01-01', grantedAt: at('2026-01-02T00:00:00Z'), withdrawnAt: null },
    ])
    expect(states.TERMS).toMatchObject({ current: true, stale: false, grantedVersion: versions.TERMS })
    expect(states.PRIVACY).toMatchObject({ current: false, stale: true })
    expect(staleRequired(states)).toEqual(['PRIVACY'])
    expect(missingRequired(states)).toEqual(['PRIVACY'])
  })

  it('takes the latest record, and a withdrawn one is not in force', () => {
    const states = consentStates([
      { type: 'ROMANCE_MODE', version: versions.ROMANCE_MODE, grantedAt: at('2026-10-02T00:00:00Z'), withdrawnAt: null },
      { type: 'ROMANCE_MODE', version: versions.ROMANCE_MODE, grantedAt: at('2026-10-05T00:00:00Z'), withdrawnAt: at('2026-10-06T00:00:00Z') },
    ])
    expect(states.ROMANCE_MODE).toMatchObject({ current: false, stale: false, grantedVersion: null })
  })
})
