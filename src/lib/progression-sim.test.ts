import { describe, it, expect } from 'vitest'
import { CEILING, daysToLevels, describeDays, levelAfterFirstProject, PERSONAS, POWER_WINS, REPORT_LEVELS, renderTable, renderTargets, TARGETS, WINDOW_SLACK_DAYS } from '../../scripts/simulate-progression'
import { xpAtLevelStart } from './levels'

// The progression simulator (scripts/simulate-progression.ts) is how the level
// curve and the XP table are judged against each other, so it must keep using
// the real rules. These tests pin the properties the numbers in
// docs/GAMIFICATION.md rely on, not the numbers themselves.
describe('progression simulator', () => {
  const reached = (name: string) => daysToLevels([...PERSONAS, POWER_WINS, CEILING].find((persona) => persona.name === name)!)

  it('puts a new user at level 4 after their first project and its achievement', () => {
    expect(levelAfterFirstProject()).toBe(4)
  })

  it('never reaches a level before the ones below it', () => {
    for (const persona of [...PERSONAS, POWER_WINS, CEILING]) {
      const days = [...daysToLevels(persona).entries()].sort((a, b) => a[0] - b[0])
      for (let index = 1; index < days.length; index++) expect(days[index][1]).toBeGreaterThanOrEqual(days[index - 1][1])
    }
  })

  it('has busier users level faster than quieter ones, and nobody beat the ceiling', () => {
    for (const level of REPORT_LEVELS.filter((level) => level >= 5 && level <= 35)) {
      const [casual, active, power, ceiling] = ['Casual', 'Active', 'Power', 'Ceiling'].map((name) => reached(name).get(level) ?? Infinity)
      expect(active).toBeLessThanOrEqual(casual)
      expect(power).toBeLessThanOrEqual(active)
      expect(ceiling).toBeLessThanOrEqual(power)
    }
  })

  it('applies the daily caps: a user who tries everything 100 times a day still earns the capped amount', () => {
    const spammer = { name: 'Spammer', description: '', perWeek: { MILESTONE_COMPLETED: 700 } }
    const capped = { name: 'Capped', description: '', perWeek: { MILESTONE_COMPLETED: 35 } }
    // 5 milestones a day at 30 XP is the cap; trying 100 a day cannot beat it.
    expect(daysToLevels(spammer, 60).get(10)).toBe(daysToLevels(capped, 60).get(10))
  })

  it('pays only 3 project creations a day however many are made', () => {
    const farmer = { name: 'Farmer', description: '', perWeek: { PROJECT_CREATED: 7 * 100 } }
    // Day one: 3 projects (150 XP) and First Project (25) is 175 XP, still level 5 (level 6 starts at 224).
    expect(xpAtLevelStart(6)).toBeGreaterThan(175)
    expect(Math.max(...daysToLevels(farmer, 1).keys())).toBe(5)
  })

  it('renders every report level for every user, and says "never" for a level not reached', () => {
    const table = renderTable([...PERSONAS, POWER_WINS, CEILING].map((persona) => ({ persona, reached: daysToLevels(persona, 30) })))
    expect(table.split('\n')).toHaveLength(2 + PERSONAS.length + 2)
    for (const level of REPORT_LEVELS) expect(table).toContain(`Level ${level}`)
    expect(table).toContain('never')
    expect(describeDays(undefined)).toMatch(/never/)
    expect(describeDays(3)).toBe('3 d')
  })

  it('reports each target as met or missed', () => {
    const report = renderTargets([...PERSONAS, POWER_WINS, CEILING].map((persona) => ({ persona, reached: daysToLevels(persona) })))
    expect(report).toContain('First project and its achievement')
    expect(report).toMatch(/\| (met|MISSED[^|]*) \|/)
  })

  it('meets every target the curve is tuned against, Mythic included', () => {
    const rows = [...PERSONAS, POWER_WINS, CEILING].map((persona) => ({ persona, reached: daysToLevels(persona) }))
    for (const target of TARGETS) {
      const days = rows.find((row) => row.persona.name === target.persona)!.reached.get(target.level)
      expect(days, `${target.persona}: ${target.label}`).toBeGreaterThanOrEqual(target.from - WINDOW_SLACK_DAYS)
      expect(days, `${target.persona}: ${target.label}`).toBeLessThanOrEqual(target.to + WINDOW_SLACK_DAYS)
    }
    expect(renderTargets(rows)).not.toContain('MISSED')
  })

  it('has a few hackathon wins a year only nudge a power user, not transform them', () => {
    const power = reached('Power').get(80)!
    const wins = reached('Power + wins').get(80)!
    expect(wins).toBeLessThan(power)
    expect(wins).toBeGreaterThan(power * 0.9)
  })
})
