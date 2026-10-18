import { describe, it, expect } from 'vitest'
import { assignRoles, commonOverlapHours, squadStrength, STRENGTH_CONFIG, type StrengthInput, type StrengthMember, type StrengthNeeds } from './strength'
import { templateFor } from './roles'

const member = (userId: string, over: Partial<StrengthMember> = {}): StrengthMember => ({
  userId,
  role: null,
  canPlay: [],
  skills: [],
  utcOffsetMinutes: null,
  hoursPerWeek: null,
  shipped: false,
  pledge: null,
  reliability: null,
  ...over,
})

const needs = (over: Partial<StrengthNeeds> = {}): StrengthNeeds => ({ roles: templateFor({ technologies: [], tracks: [], size: 4 }), requiredSkills: [], pledgesExpected: false, minSize: 1, ...over })
const input = (members: StrengthMember[], over: Partial<StrengthInput> = {}): StrengthInput => ({ members, needs: needs(), history: [], ...over })
const codes = (result: ReturnType<typeof squadStrength>) => result.gaps.map((gap) => gap.code)

describe('commonOverlapHours', () => {
  it('is the whole window for one zone, and the shared part for several', () => {
    expect(commonOverlapHours([0])).toBe(10)
    expect(commonOverlapHours([0, 0, 0])).toBe(10)
    expect(commonOverlapHours([0, 60])).toBe(9)
    // London, Berlin (+1h) and New York (-5h): 14:00 to 18:00 UTC.
    expect(commonOverlapHours([0, 60, -300])).toBe(4)
  })

  it('is right for half-hour zones and across midnight', () => {
    expect(commonOverlapHours([330, 0])).toBe(4.5) // India and UTC
    expect(commonOverlapHours([600, -420])).toBe(3) // Sydney and the US west coast: 23:00 to 02:00 UTC
    expect(commonOverlapHours([0, 720])).toBe(0) // twelve hours apart
    expect(commonOverlapHours([720, -600])).toBe(8) // +12 and -10 are two hours apart on the clock
  })

  it('is 0 for nobody', () => {
    expect(commonOverlapHours([])).toBe(0)
  })
})

describe('assignRoles', () => {
  it('covers each role once, preferring declared roles, and lets full-stack cover frontend or backend', () => {
    const members = [member('a', { role: { role: 'FULLSTACK' } }), member('b', { role: { role: 'DESIGN_UI_UX' }, canPlay: [{ role: 'FRONTEND' }] }), member('c', { canPlay: [{ role: 'FRONTEND' }] })]
    const roles = assignRoles(members, [{ role: 'FRONTEND' }, { role: 'BACKEND' }, { role: 'DESIGN_UI_UX' }])
    expect(roles.map((r) => [r.key, r.userId])).toEqual([
      ['FRONTEND', 'c'],
      ['BACKEND', 'a'],
      ['DESIGN_UI_UX', 'b'],
    ])
  })

  it('leaves a role uncovered when nobody can play it', () => {
    expect(assignRoles([member('a', { role: { role: 'FRONTEND' } })], [{ role: 'FRONTEND' }, { role: 'OTHER', customLabel: 'Smart contract developer' }]).map((r) => r.userId)).toEqual(['a', null])
  })

  it('matches OTHER roles by their label', () => {
    const solidity = member('s', { canPlay: [{ role: 'OTHER', customLabel: 'smart contract developer' }] })
    expect(assignRoles([solidity], [{ role: 'OTHER', customLabel: 'Smart Contract Developer' }])[0].userId).toBe('s')
  })
})

describe('squadStrength', () => {
  const balanced = () => [
    member('fe', { role: { role: 'FRONTEND' }, skills: ['React'], utcOffsetMinutes: 0, hoursPerWeek: 20, shipped: true }),
    member('be', { role: { role: 'BACKEND' }, skills: ['Node.js'], utcOffsetMinutes: 60, hoursPerWeek: 20 }),
    member('de', { role: { role: 'DESIGN_UI_UX' }, skills: ['Figma'], utcOffsetMinutes: 0, hoursPerWeek: 15 }),
    member('pi', { role: { role: 'PITCH_BUSINESS' }, utcOffsetMinutes: 60, hoursPerWeek: 20 }),
  ]

  it('scores the worked example in docs/SQUADS.md', () => {
    const members = [
      member('ana', { role: { role: 'FRONTEND' }, skills: ['React'], utcOffsetMinutes: 0, hoursPerWeek: 20, shipped: true, pledge: { confirmed: true, hours: 20 } }),
      member('ben', { role: { role: 'BACKEND' }, skills: ['Node.js'], utcOffsetMinutes: -300, hoursPerWeek: 10, pledge: { confirmed: true, hours: 10 } }),
      member('chi', { canPlay: [{ role: 'DESIGN_UI_UX' }], skills: ['Figma'], utcOffsetMinutes: 330, hoursPerWeek: 20, pledge: null }),
    ]
    const result = squadStrength({
      members,
      needs: { roles: templateFor({ technologies: ['React', 'Node.js', 'Python'], tracks: [], size: 4 }), requiredSkills: [], pledgesExpected: true, minSize: 2 },
      history: [{ a: 'ana', b: 'ben', wouldBuildAgain: true, teamsTogether: 1 }],
    })
    // Roles: 3 of 4 (no one to pitch) = 0.75; skills: React, Node.js of React, Node.js, Python = 2/3; time zones: UTC, UTC-5 and UTC+5:30 share no
    // working hours = 0; commitment: hours 10/20 = 0.5 and pledges 2/3, mean 0.583; experience: one shipper = 0.75; chemistry: one good pair of the
    // two a chain of three needs = 0.4 + 0.6 * 1/2 = 0.7.
    expect(result.components.roleCoverage.value).toBe(0.75)
    expect(result.components.skillCoverage.value).toBeCloseTo(2 / 3)
    expect(result.components.timezoneOverlap.value).toBe(0)
    expect(result.components.commitmentFit.value).toBeCloseTo((0.5 + 2 / 3) / 2)
    expect(result.components.experienceMix.value).toBe(0.75)
    expect(result.components.chemistry.value).toBeCloseTo(0.7)
    // 25*0.75 + 20*0.667 + 15*0 + 15*0.583 + 15*0.75 + 10*0.7 = 18.75 + 13.33 + 0 + 8.75 + 11.25 + 7 = 59.08
    expect(result.score).toBe(59)
    expect(result.overlapHours).toBe(0)
    expect(result.gaps).toEqual([
      { code: 'MISSING_ROLE', message: 'No one to pitch' },
      { code: 'MISSING_SKILLS', message: 'No one knows Python' },
      { code: 'LOW_TIMEZONE_OVERLAP', message: 'No shared working hours across your time zones' },
      { code: 'UNCONFIRMED_PLEDGES', message: '1 member has not confirmed their commitment pledge' },
    ])
  })

  it('names the gaps the brief asks for', () => {
    const result = squadStrength(input([member('a', { role: { role: 'FRONTEND' }, utcOffsetMinutes: 0 }), member('b', { role: { role: 'BACKEND' }, utcOffsetMinutes: 480 })]))
    expect(result.gaps).toContainEqual({ code: 'MISSING_ROLE', message: 'No designer' })
    expect(result.gaps).toContainEqual({ code: 'NO_DEPLOYER', message: 'No one on this squad has deployed before' })
    expect(result.gaps).toContainEqual({ code: 'LOW_TIMEZONE_OVERLAP', message: 'Only 2h timezone overlap' })
    // Three shared hours is not a gap.
    expect(codes(squadStrength(input([member('a', { utcOffsetMinutes: 0 }), member('b', { utcOffsetMinutes: 420 })])))).not.toContain('LOW_TIMEZONE_OVERLAP')
  })

  it('reports a short overlap with its hours', () => {
    const result = squadStrength(input([member('a', { utcOffsetMinutes: 0 }), member('b', { utcOffsetMinutes: 480 })]))
    expect(result.overlapHours).toBe(2)
    expect(result.gaps).toContainEqual({ code: 'LOW_TIMEZONE_OVERLAP', message: 'Only 2h timezone overlap' })
  })

  it('ranks a balanced, overlapping squad above a lopsided one', () => {
    const lopsided = [0, 1, 2, 3].map((i) => member(`f${i}`, { role: { role: 'FRONTEND' }, utcOffsetMinutes: i * 240 }))
    expect(squadStrength(input(balanced())).score).toBeGreaterThan(squadStrength(input(lopsided)).score + 20)
  })

  it('says a squad is too small for the hackathon', () => {
    const result = squadStrength(input([member('a')], { needs: needs({ minSize: 3 }) }))
    expect(result.gaps[0]).toEqual({ code: 'TOO_SMALL', message: 'Needs 2 more members to reach the minimum of 3' })
  })

  it('flags unconfirmed pledges only while pledges are due', () => {
    const members = balanced()
    expect(codes(squadStrength(input(members, { needs: needs({ pledgesExpected: true }) })))).toContain('UNCONFIRMED_PLEDGES')
    expect(codes(squadStrength(input(members)))).not.toContain('UNCONFIRMED_PLEDGES')
    const pledged = members.map((m) => ({ ...m, pledge: { confirmed: true, hours: 20 } }))
    expect(codes(squadStrength(input(pledged, { needs: needs({ pledgesExpected: true }) })))).not.toContain('UNCONFIRMED_PLEDGES')
  })

  it('lets reliability move commitment but never names it as a gap', () => {
    const reliable = balanced().map((m) => ({ ...m, reliability: 1 }))
    const flaky = balanced().map((m) => ({ ...m, reliability: 0 }))
    expect(squadStrength(input(reliable)).score).toBeGreaterThan(squadStrength(input(flaky)).score)
    expect(squadStrength(input(flaky)).gaps.map((g) => g.message).join(' ')).not.toMatch(/reliab/i)
  })

  it('treats strangers as neutral chemistry and history as a bonus', () => {
    const strangers = squadStrength(input(balanced()))
    expect(strangers.components.chemistry).toMatchObject({ known: false, value: STRENGTH_CONFIG.neutral })
    const friends = squadStrength(input(balanced(), { history: [{ a: 'fe', b: 'be', wouldBuildAgain: true, teamsTogether: 0 }, { a: 'be', b: 'de', wouldBuildAgain: false, teamsTogether: 2 }] }))
    expect(friends.components.chemistry.known).toBe(true)
    expect(friends.score).toBeGreaterThan(strangers.score)
    // History with someone outside the squad does not count.
    expect(squadStrength(input(balanced(), { history: [{ a: 'fe', b: 'zz', wouldBuildAgain: true, teamsTogether: 3 }] })).components.chemistry.known).toBe(false)
  })

  it('leaves skills out when nothing is required, and scales the rest to 100', () => {
    const result = squadStrength(input(balanced()))
    expect(result.components.skillCoverage.applicable).toBe(false)
    const weights = Object.values(result.components).reduce((sum, c) => sum + c.weight, 0)
    expect(weights).toBeCloseTo(100)
  })

  it('flags a squad whose time to give is far apart', () => {
    const result = squadStrength(input([member('a', { hoursPerWeek: 40 }), member('b', { hoursPerWeek: 5 })]))
    expect(result.gaps).toContainEqual({ code: 'HOURS_MISMATCH', message: 'Time to give ranges from 5h to 40h' })
  })

  it('is deterministic and stays within 0 to 100', () => {
    const value = input(balanced(), { needs: needs({ requiredSkills: ['React', 'Rust'] }) })
    expect(squadStrength(value)).toEqual(squadStrength(value))
    for (const members of [[], [member('x')], balanced()]) {
      const { score } = squadStrength(input(members))
      expect(score).toBeGreaterThanOrEqual(0)
      expect(score).toBeLessThanOrEqual(100)
    }
  })
})
