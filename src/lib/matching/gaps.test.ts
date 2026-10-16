import { describe, it, expect } from 'vitest'
import { analyzeGaps, normalizeName, type GapInput } from './gaps'

const catalog = [
  { slug: 'react', name: 'React' },
  { slug: 'postgres', name: 'PostgreSQL' },
  { slug: 'ml', name: 'Machine Learning' },
  { slug: 'go', name: 'Go' },
]

const input = (over: Partial<GapInput> = {}): GapInput => ({ teamNeeds: [], projectNeeds: [], projectStack: [], members: [], catalog, ...over })

describe('normalizeName', () => {
  it('lower-cases, trims and collapses spaces', () => {
    expect(normalizeName('  Machine   Learning ')).toBe('machine learning')
  })
})

describe('analyzeGaps: skills', () => {
  it('splits the wanted skills into covered and missing by what the members have', () => {
    const result = analyzeGaps(input({ teamNeeds: ['React', 'Machine Learning'], members: [{ userId: 'a', skills: ['react'], builderRole: null }, { userId: 'b', skills: ['go'], builderRole: null }] }))
    expect(result.coveredSkills).toEqual([{ name: 'React', slug: 'react', sources: ['TEAM_NEEDS'], memberIds: ['a'] }])
    expect(result.missingSkills).toEqual([{ name: 'Machine Learning', slug: 'ml', sources: ['TEAM_NEEDS'] }])
  })

  it('matches a name or a slug, ignoring case and spaces', () => {
    const result = analyzeGaps(input({ teamNeeds: ['postgresql', ' ML ', 'GO'] }))
    expect(result.missingSkills.map((s) => s.slug).sort()).toEqual(['go', 'ml', 'postgres'])
  })

  it('counts a project’s stack as skills the team should have, and remembers where each need came from', () => {
    const result = analyzeGaps(input({ teamNeeds: ['React'], projectStack: ['react', 'PostgreSQL'], projectNeeds: ['Go'] }))
    expect(result.missingSkills.find((s) => s.slug === 'react')?.sources).toEqual(['TEAM_NEEDS', 'PROJECT_STACK'])
    expect(result.missingSkills.find((s) => s.slug === 'go')?.sources).toEqual(['PROJECT_NEEDS'])
    expect(result.missingSkills.find((s) => s.slug === 'postgres')?.sources).toEqual(['PROJECT_STACK'])
  })

  it('lists a skill once however many times it is asked for, and every member who has it', () => {
    const result = analyzeGaps(input({ teamNeeds: ['React', 'react'], projectStack: ['React'], members: [{ userId: 'a', skills: ['react'], builderRole: null }, { userId: 'b', skills: ['react', 'go'], builderRole: null }] }))
    expect(result.coveredSkills).toHaveLength(1)
    expect(result.coveredSkills[0].memberIds).toEqual(['a', 'b'])
    expect(result.missingSkills).toEqual([])
  })

  it('reports technologies that are not skills of the catalog, without calling them missing', () => {
    const result = analyzeGaps(input({ projectStack: ['React', 'Vercel', ' Tailwind ', 'vercel'] }))
    expect(result.unmatchedStack).toEqual(['Tailwind', 'Vercel', 'vercel'].sort((a, b) => a.localeCompare(b)))
    expect(result.missingSkills.map((s) => s.slug)).toEqual(['react'])
  })
})

describe('analyzeGaps: roles', () => {
  it('treats a need that is not a skill as a role, covered by a member’s own role', () => {
    const result = analyzeGaps(input({ teamNeeds: ['Designer', 'Growth'], members: [{ userId: 'a', skills: [], builderRole: 'Product designer' }] }))
    expect(result.coveredRoles).toEqual([{ name: 'Designer', sources: ['TEAM_NEEDS'], memberIds: ['a'] }])
    expect(result.missingRoles).toEqual([{ name: 'Growth', sources: ['TEAM_NEEDS'] }])
  })

  it('matches in either direction and ignores case', () => {
    const covered = (need: string, role: string) => analyzeGaps(input({ teamNeeds: [need], members: [{ userId: 'a', skills: [], builderRole: role }] })).coveredRoles.length === 1
    expect(covered('designer', 'Senior DESIGNER')).toBe(true)
    expect(covered('Frontend developer', 'frontend')).toBe(true)
    expect(covered('Designer', 'Engineer')).toBe(false)
    expect(covered('Designer', '')).toBe(false)
  })

  it('does not treat the stack as roles', () => {
    expect(analyzeGaps(input({ projectStack: ['Vercel'] })).missingRoles).toEqual([])
  })

  it('merges a role asked for by the team and the project', () => {
    const result = analyzeGaps(input({ teamNeeds: ['Designer'], projectNeeds: ['designer'] }))
    expect(result.missingRoles).toEqual([{ name: 'Designer', sources: ['TEAM_NEEDS', 'PROJECT_NEEDS'] }])
  })
})

describe('analyzeGaps: edges', () => {
  it('is empty for a team that asked for nothing', () => {
    expect(analyzeGaps(input())).toEqual({ missingSkills: [], coveredSkills: [], missingRoles: [], coveredRoles: [], unmatchedStack: [] })
  })

  it('ignores blank entries', () => {
    expect(analyzeGaps(input({ teamNeeds: ['', '  '], projectStack: [' '] }))).toEqual({ missingSkills: [], coveredSkills: [], missingRoles: [], coveredRoles: [], unmatchedStack: [] })
  })

  it('sorts by name so the answer is stable', () => {
    const result = analyzeGaps(input({ teamNeeds: ['Go', 'React', 'Machine Learning', 'Zebra wrangler', 'Accountant'] }))
    expect(result.missingSkills.map((s) => s.name)).toEqual(['Go', 'Machine Learning', 'React'])
    expect(result.missingRoles.map((r) => r.name)).toEqual(['Accountant', 'Zebra wrangler'])
  })
})
