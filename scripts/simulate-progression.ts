// How long does it take to level up? Simulates three kinds of user, day by day,
// against the REAL rules: the XP table, daily caps and once-per-source rule in
// src/lib/rewards-config.ts, the achievements in src/lib/achievement-definitions.ts
// and the level curve in src/lib/levels.ts. Change any of those and run it again:
//
//   npm run sim:progression
//
// The output is pasted into docs/GAMIFICATION.md. The users are deterministic (a
// weekly rate for each action, spread evenly over the days), so a run is repeatable.
// Nothing is random and nothing touches the database.

import { ACHIEVEMENT_DEFINITIONS } from '../src/lib/achievement-definitions'
import { levelFor, MAX_LEVEL, xpAtLevelStart } from '../src/lib/levels'
import { dedupeKeyFor, EVENT_REWARDS, REWARD_RULES, type RewardSource } from '../src/lib/rewards-config'

/** The levels the table reports: the first level of each tier, plus two early ones. */
export const REPORT_LEVELS = [2, 5, 10, 20, 35, 55, 80] as const

/** Days simulated: six years is long enough to say "effectively never". */
export const SIMULATED_DAYS = 6 * 365

type EventName = keyof typeof EVENT_REWARDS

/** Events a user causes by their own action, per week, for one kind of user. */
export interface Persona {
  name: string
  description: string
  /** Times a week the user does each thing. Fractions are spread over the weeks (0.5 is every other week). */
  perWeek: Partial<Record<EventName, number>>
}

// "Actions" below are the things that can earn XP. Posting an update after a
// milestone, or messaging someone you just connected with, each counts as one.
export const PERSONAS: Persona[] = [
  {
    name: 'Casual',
    description: '3 actions a week: a project every two weeks, shipped, with a milestone and an update along the way.',
    perWeek: {
      PROJECT_CREATED: 0.5,
      PROJECT_SHIPPED: 0.5,
      MILESTONE_COMPLETED: 0.75,
      PROJECT_UPDATE_POSTED: 0.5,
      EVIDENCE_ADDED: 0.25,
      EVIDENCE_ENDORSED: 0.25,
    },
  },
  {
    name: 'Active',
    description: 'Something every day, about 3 a day: a project every 10 days, milestones, updates, and the social side.',
    perWeek: {
      PROJECT_CREATED: 1,
      PROJECT_SHIPPED: 0.7,
      MILESTONE_COMPLETED: 4,
      PROJECT_UPDATE_POSTED: 3,
      EVIDENCE_ADDED: 2,
      EVIDENCE_ENDORSED: 3,
      CONNECTION_ACCEPTED: 2.5,
      MESSAGE_SENT_FIRST_IN_CONNECTION: 2.5,
      TEAM_APPLICATION_ACCEPTED: 0.15,
      HACKATHON_JOINED: 0.1,
    },
  },
  {
    name: 'Power',
    description: 'About 6 a day, ships a project every week, joins a hackathon every month.',
    perWeek: {
      PROJECT_CREATED: 2,
      PROJECT_SHIPPED: 1,
      MILESTONE_COMPLETED: 10,
      PROJECT_UPDATE_POSTED: 8,
      EVIDENCE_ADDED: 4,
      EVIDENCE_ENDORSED: 7,
      CONNECTION_ACCEPTED: 4,
      MESSAGE_SENT_FIRST_IN_CONNECTION: 4,
      TEAM_APPLICATION_ACCEPTED: 0.3,
      HACKATHON_JOINED: 0.25,
      TEAM_FORMED: 0.15,
      HACKATHON_WON: 0.02,
    },
  },
]

/**
 * Not a user, a ceiling: someone who earns every capped action up to its daily cap every
 * day (and ships three projects a day). It is here to show the fastest the rules allow,
 * which is the number to compare "the top 0.1%" against.
 */
export const CEILING: Persona = {
  name: 'Ceiling',
  description: 'Hits every daily cap every day. The fastest the rules allow, not a person.',
  perWeek: {
    PROJECT_CREATED: 3 * 7,
    PROJECT_SHIPPED: 3 * 7,
    MILESTONE_COMPLETED: 5 * 7,
    PROJECT_UPDATE_POSTED: 3 * 7,
    EVIDENCE_ADDED: 3 * 7,
    EVIDENCE_ENDORSED: 10 * 7,
    CONNECTION_ACCEPTED: 5 * 7,
    MESSAGE_SENT_FIRST_IN_CONNECTION: 5 * 7,
  },
}

/** What the level curve is tuned against: [user, level, earliest day, latest day]. Weeks and months as 7 and 30.4 days. */
export const TARGETS: { persona: string; level: number; label: string; from: number; to: number }[] = [
  { persona: 'Casual', level: 10, label: 'Silver in 6-8 weeks', from: 42, to: 56 },
  { persona: 'Active', level: 20, label: 'Gold in 3-4 months', from: 91, to: 122 },
  { persona: 'Power', level: 35, label: 'Platinum in 9-12 months', from: 274, to: 365 },
]

/** After the first project (50 XP) and its achievement (25 XP), the user must be at level 2, not still at 1 or past it. */
export function levelAfterFirstProject(levelOf: (xp: number) => number = (xp) => levelFor(xp).level): number {
  const ledger = new Ledger()
  ledger.emit(1, 'PROJECT_CREATED', 0)
  return levelOf(ledger.xp)
}

const ME = 'me'

/** A payload with a fresh id in every field, so each event is a new source. */
function payloadFor(counter: number): never {
  const id = (label: string) => `${label}-${counter}`
  return {
    userId: ME,
    otherUserId: id('other'),
    endorserId: id('endorser'),
    projectId: id('project'),
    projectName: id('project'),
    updateId: id('update'),
    milestoneId: id('milestone'),
    hackathonId: id('hackathon'),
    hackathonName: id('hackathon'),
    hackathonTeamId: id('hackathon-team'),
    teamId: id('team'),
    applicationId: id('application'),
    evidenceId: id('evidence'),
    skillId: id('skill'),
    connectionId: id('connection'),
    conversationId: id('conversation'),
    messageId: id('message'),
  } as never
}

interface RewardLike {
  xp?: {
    action: keyof typeof REWARD_RULES
    source: (payload: never) => RewardSource
    recipients?: (payload: never) => string[]
  }
  achievement?: keyof typeof ACHIEVEMENT_DEFINITIONS
}

/** One user's XP, with the same rules grant() applies: once per source, daily caps, achievements once. */
class Ledger {
  xp = 0
  private readonly seen = new Set<string>()
  private readonly perDay = new Map<string, number>()
  private readonly achievements = new Set<string>()

  award(day: number, action: keyof typeof REWARD_RULES, source: RewardSource, amount: number) {
    const rule = REWARD_RULES[action]
    const key = `${action}|${dedupeKeyFor(source)}`
    if (this.seen.has(key)) return
    if (rule.dailyCap !== null) {
      const slot = `${action}|${day}`
      const used = this.perDay.get(slot) ?? 0
      if (used >= rule.dailyCap) return
      this.perDay.set(slot, used + 1)
    }
    this.seen.add(key)
    this.xp += amount
  }

  /** What the event pays, through EVENT_REWARDS: the XP rule first, then the achievement it unlocks. */
  emit(day: number, name: EventName, counter: number) {
    const reward = EVENT_REWARDS[name] as RewardLike
    const payload = payloadFor(counter)
    if (reward.xp) {
      const recipients = reward.xp.recipients ? reward.xp.recipients(payload) : [ME]
      const amount = REWARD_RULES[reward.xp.action].amount
      if (recipients.includes(ME) && amount !== null) this.award(day, reward.xp.action, reward.xp.source(payload), amount)
    }
    if (reward.achievement && !this.achievements.has(reward.achievement)) {
      this.achievements.add(reward.achievement)
      const definition = ACHIEVEMENT_DEFINITIONS[reward.achievement]
      this.award(day, 'ACHIEVEMENT_EARNED', { sourceType: 'ACHIEVEMENT', sourceId: reward.achievement }, definition.xpReward)
    }
  }
}

/** The days on which each level is first reached. Level 1 is day 0. */
export function daysToLevels(persona: Persona, days = SIMULATED_DAYS, levelOf: (xp: number) => number = (xp) => levelFor(xp).level): Map<number, number> {
  const ledger = new Ledger()
  const reached = new Map<number, number>([[1, 0]])
  const owed = new Map<EventName, number>()
  const names = Object.keys(persona.perWeek) as EventName[]
  let counter = 0
  let level = 1

  for (let day = 1; day <= days; day++) {
    // Work in the order a person would: start things, then progress, then talk to people.
    for (const name of names) {
      const due = (owed.get(name) ?? 0) + (persona.perWeek[name] ?? 0) / 7
      const times = Math.floor(due + 1e-9)
      owed.set(name, due - times)
      for (let time = 0; time < times; time++) ledger.emit(day, name, counter++)
    }
    const now = levelOf(ledger.xp)
    for (; level < now; level++) reached.set(level + 1, day)
    if (level >= MAX_LEVEL) break
  }
  return reached
}

export function describeDays(days: number | undefined): string {
  if (days === undefined) return 'never (6 yr+)'
  if (days < 14) return `${days} d`
  if (days < 70) return `${days} d (${(days / 7).toFixed(1)} wk)`
  if (days < 540) return `${days} d (${(days / 30.4).toFixed(1)} mo)`
  return `${days} d (${(days / 365).toFixed(1)} yr)`
}

export function renderTable(rows: { persona: Persona; reached: Map<number, number> }[]): string {
  const header = ['User', ...REPORT_LEVELS.map((level) => `Level ${level}`)]
  const lines = [`| ${header.join(' | ')} |`, `| --- | ${REPORT_LEVELS.map(() => '---:').join(' | ')} |`]
  for (const { persona, reached } of rows) {
    lines.push(`| ${persona.name} | ${REPORT_LEVELS.map((level) => describeDays(reached.get(level))).join(' | ')} |`)
  }
  return lines.join('\n')
}

/** XP a day, averaged over a year, to put the days in context. */
export function yearlyXp(persona: Persona): number {
  const ledger = new Ledger()
  const owed = new Map<EventName, number>()
  let counter = 0
  for (let day = 1; day <= 365; day++) {
    for (const name of Object.keys(persona.perWeek) as EventName[]) {
      const due = (owed.get(name) ?? 0) + (persona.perWeek[name] ?? 0) / 7
      const times = Math.floor(due + 1e-9)
      owed.set(name, due - times)
      for (let time = 0; time < times; time++) ledger.emit(day, name, counter++)
    }
  }
  return ledger.xp
}

export function renderTargets(rows: { persona: Persona; reached: Map<number, number> }[]): string {
  const lines = ['| Target | Wanted | Simulated | XP a day: needed / earned | |', '| --- | --- | --- | --- | --- |']
  const firstProject = levelAfterFirstProject()
  lines.push(`| First project and its achievement | level 2 | level ${firstProject} | | ${firstProject === 2 ? 'met' : 'MISSED'} |`)
  for (const target of TARGETS) {
    const reached = rows.find((row) => row.persona.name === target.persona)?.reached.get(target.level)
    const verdict = reached === undefined ? 'MISSED' : reached < target.from ? 'MISSED (too fast)' : reached > target.to ? 'MISSED (too slow)' : 'met'
    const persona = rows.find((row) => row.persona.name === target.persona)!.persona
    const needed = Math.round(xpAtLevelStart(target.level) / ((target.from + target.to) / 2))
    lines.push(`| ${target.persona}: ${target.label} | ${target.from}-${target.to} d | ${describeDays(reached)} | ${needed} / ${Math.round(yearlyXp(persona) / 365)} | ${verdict} |`)
  }
  const power = rows.find((row) => row.persona.name === 'Power')?.reached.get(80)
  lines.push(`| Mythic is top-0.1% territory | not within 3 years of steady play | Power: ${describeDays(power)} | | ${power === undefined || power > 3 * 365 ? 'met' : 'MISSED'} |`)
  return lines.join('\n')
}

function main() {
  const rows = [...PERSONAS, CEILING].map((persona) => ({ persona, reached: daysToLevels(persona) }))
  console.log(renderTable(rows))
  console.log('')
  console.log(renderTargets(rows))
  console.log('')
  for (const { persona } of rows) {
    console.log(`- **${persona.name}**: ${persona.description} Earns about ${Math.round(yearlyXp(persona) / 365)} XP a day over its first year.`)
  }
}

if (require.main === module) main()
