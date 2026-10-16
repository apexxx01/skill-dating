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

import { achievementSeries, ACHIEVEMENT_DEFINITIONS, type AchievementSlug } from '../src/lib/achievement-definitions'
import { levelFor, MAX_LEVEL, xpAtLevelStart } from '../src/lib/levels'
import { ticksFor, type Metric } from '../src/lib/metrics'
import { dedupeKeyFor, EVENT_REWARDS, REWARD_RULES, type RewardSource } from '../src/lib/rewards-config'
import { pickQuests } from '../src/lib/quests'
import { advanceStreak, NEW_STREAK, type StreakState } from '../src/lib/streaks'
import { addDaysToDateKey, isoWeekKeyOfDateKey } from '../src/lib/time'

/** The levels the table reports: the first level of each tier, plus two early ones. */
export const REPORT_LEVELS = [2, 5, 10, 20, 35, 55, 80] as const

/** Days simulated: ten years is long enough to say "effectively never". */
export const SIMULATED_DAYS = 10 * 365

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
 * Power, plus about four hackathon wins a year (the base Power user wins roughly one): a
 * top competitor. Wins are worth 500 XP each, so they add a few percent, not a multiple, to
 * what a power user earns: this user reaches Mythic a little sooner than the plain Power user,
 * not years sooner.
 */
export const POWER_WINS: Persona = {
  name: 'Power + wins',
  description: 'The Power user, with about four hackathon wins a year instead of one.',
  perWeek: { ...PERSONAS.find((persona) => persona.name === 'Power')!.perWeek, HACKATHON_WON: 4 / 52 },
}

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

/**
 * A target counts as met within a week of its window. The windows come from "about 9 months" and
 * "6 to 8 weeks", and the simulation has a day for resolution and nine users to take a median of, so a
 * difference of a few days is the simulation's rounding and not a miss.
 */
export const WINDOW_SLACK_DAYS = 7

/** What the level curve is tuned against: [user, level, earliest day, latest day]. Weeks and months as 7 and 30.4 days. */
export const TARGETS: { persona: string; level: number; label: string; from: number; to: number }[] = [
  { persona: 'Casual', level: 10, label: 'Silver in 6-8 weeks', from: 42, to: 56 },
  { persona: 'Active', level: 20, label: 'Gold in 3-4 months', from: 91, to: 122 },
  { persona: 'Power', level: 35, label: 'Platinum in 9-12 months', from: 274, to: 365 },
  { persona: 'Power', level: 55, label: 'Diamond in 2.5-3 years', from: Math.round(2.5 * 365), to: 3 * 365 },
  { persona: 'Power', level: 80, label: 'Mythic in about 5 years', from: Math.round(4.75 * 365), to: Math.round(5.25 * 365) },
  { persona: 'Power + wins', level: 80, label: 'Mythic in about 5 years, a little sooner than Power', from: 3 * 365, to: 5 * 365 },
]

/** The level a user is on after their first project (50 XP) and its achievement (25 XP): the onboarding moment. */
export function levelAfterFirstProject(levelOf: (xp: number) => number = (xp) => levelFor(xp).level): number {
  const ledger = new Ledger()
  ledger.emit(1, 'PROJECT_CREATED', 0)
  ledger.endDay(1)
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
}

/** The calendar the simulated streaks walk along. */
const FIRST_DAY = '2026-01-01'

/**
 * One user's XP, with the same rules the engine applies: once per source, daily caps, and the achievements
 * and streaks that follow from the counts (the progress engine's metrics and the streak rules, imported rather
 * than copied) and the daily and weekly quests the user is given (the real rotation, seeded by the user and
 * the period). Not simulated: the secret achievements, which depend on the clock.
 *
 * Simplifications: a user who is endorsed also endorses about as often as they are endorsed; every action of
 * their own counts toward the streak that day; and they do what they would have done anyway, quests or not
 * (nobody changes what they do to chase a quest), so a quest only pays when their usual week happens to meet it.
 */
export class Ledger {
  xp = 0
  constructor(private readonly userId: string = ME) {}
  private readonly questProgress = new Map<string, number>()
  private readonly seen = new Set<string>()
  private readonly perDay = new Map<string, number>()
  private readonly achievements = new Set<string>()
  private readonly counters = new Map<string, number>()
  private streak: StreakState = NEW_STREAK
  private actedToday = false

  /** Returns whether the award was paid. */
  award(day: number, action: keyof typeof REWARD_RULES, source: RewardSource, amount: number): boolean {
    const rule = REWARD_RULES[action]
    const key = `${action}|${dedupeKeyFor(source)}`
    if (this.seen.has(key)) return false
    if (rule.dailyCap !== null) {
      const slot = `${action}|${day}`
      const used = this.perDay.get(slot) ?? 0
      if (used >= rule.dailyCap) return false
      this.perDay.set(slot, used + 1)
    }
    this.seen.add(key)
    this.xp += amount
    return true
  }

  /** An achievement is earned once, and pays its XP as an ACHIEVEMENT_EARNED award. */
  private unlock(day: number, slug: AchievementSlug) {
    if (this.achievements.has(slug)) return
    this.achievements.add(slug)
    this.award(day, 'ACHIEVEMENT_EARNED', { sourceType: 'ACHIEVEMENT', sourceId: slug }, ACHIEVEMENT_DEFINITIONS[slug].xpReward)
  }

  /** One more of `metric` today: moves the daily and weekly quests that ask for it, and pays the ones it completes. */
  private advanceQuests(day: number, metric: Metric) {
    const date = addDaysToDateKey(FIRST_DAY, day)
    for (const [key, type] of [[date, 'DAILY'], [isoWeekKeyOfDateKey(date), 'WEEKLY']] as const) {
      for (const quest of pickQuests(this.userId, key, type)) {
        if (quest.metric !== metric) continue
        const slot = `${key}|${quest.slug}`
        const current = (this.questProgress.get(slot) ?? 0) + 1
        this.questProgress.set(slot, current)
        if (current === quest.target) this.award(day, 'QUEST_COMPLETED', { sourceType: 'QUEST', sourceId: slot }, quest.xpReward)
      }
    }
  }

  private unlockSeries(day: number, metric: Metric | 'streak_days', value: number) {
    for (const entry of achievementSeries(metric)) if (entry.target <= value) this.unlock(day, entry.slug)
  }

  /** What the event pays, through EVENT_REWARDS: the XP rule, then the counts and achievements it moves. */
  emit(day: number, name: EventName, counter: number) {
    const reward = EVENT_REWARDS[name] as RewardLike
    const payload = payloadFor(counter)
    const paid = new Set<string>()
    if (reward.xp) {
      const recipients = reward.xp.recipients ? reward.xp.recipients(payload) : [ME]
      const amount = REWARD_RULES[reward.xp.action].amount
      if (recipients.includes(ME) && amount !== null && this.award(day, reward.xp.action, reward.xp.source(payload), amount)) {
        paid.add(ME)
        if (REWARD_RULES[reward.xp.action].streak) this.actedToday = true
      }
    }

    const ticks = ticksFor(name, payload, paid).filter((tick) => tick.userId === ME)
    // Symmetry: a user who is endorsed also endorses.
    if (name === 'EVIDENCE_ENDORSED' && paid.has(ME)) ticks.push({ userId: ME, metric: 'endorsements_given', dedupeKey: `given-${counter}` })
    for (const tick of ticks) {
      const value = (this.counters.get(tick.metric) ?? 0) + 1
      this.counters.set(tick.metric, value)
      this.unlockSeries(day, tick.metric, value)
      this.advanceQuests(day, tick.metric)
    }
  }

  /** Closes the day: a day with an action of the user's own extends the streak, which can unlock streak achievements. */
  endDay(day: number) {
    if (!this.actedToday) return
    this.actedToday = false
    const step = advanceStreak(this.streak, addDaysToDateKey(FIRST_DAY, day))
    this.streak = step.state
    if (step.extended) this.unlockSeries(day, 'streak_days', step.state.current)
  }
}

/** Plays one simulated day for a persona. `owed` carries the fractions of actions between days. */
function playDay(ledger: Ledger, persona: Persona, day: number, owed: Map<EventName, number>, counter: { value: number }) {
  // Work in the order a person would: start things, then progress, then talk to people.
  for (const name of Object.keys(persona.perWeek) as EventName[]) {
    const due = (owed.get(name) ?? 0) + (persona.perWeek[name] ?? 0) / 7
    const times = Math.floor(due + 1e-9)
    owed.set(name, due - times)
    for (let time = 0; time < times; time++) ledger.emit(day, name, counter.value++)
  }
  ledger.endDay(day)
}

/**
 * The quests a user is given depend on who they are, so one simulated user is one lucky or unlucky draw.
 * These nine stand in for everybody, and the days reported are the median across them.
 */
export const SIMULATED_USERS = ['sim-1', 'sim-2', 'sim-3', 'sim-4', 'sim-5', 'sim-6', 'sim-7', 'sim-8', 'sim-9']

function daysToLevelsFor(userId: string, persona: Persona, days: number, levelOf: (xp: number) => number): Map<number, number> {
  const ledger = new Ledger(userId)
  const reached = new Map<number, number>([[1, 0]])
  const owed = new Map<EventName, number>()
  const counter = { value: 0 }
  let level = 1

  for (let day = 1; day <= days; day++) {
    playDay(ledger, persona, day, owed, counter)
    const now = levelOf(ledger.xp)
    for (; level < now; level++) reached.set(level + 1, day)
    if (level >= MAX_LEVEL) break
  }
  return reached
}

/** The days on which each level is first reached (the median over SIMULATED_USERS). Level 1 is day 0. A level nobody reaches is absent. */
export function daysToLevels(
  persona: Persona,
  days = SIMULATED_DAYS,
  levelOf: (xp: number) => number = (xp) => levelFor(xp).level,
  users: readonly string[] = SIMULATED_USERS
): Map<number, number> {
  const runs = users.map((userId) => daysToLevelsFor(userId, persona, days, levelOf))
  const median = new Map<number, number>()
  for (let level = 1; level <= MAX_LEVEL; level++) {
    const reached = runs.map((run) => run.get(level) ?? Infinity).sort((a, b) => a - b)
    const middle = reached[Math.floor(reached.length / 2)]
    if (Number.isFinite(middle)) median.set(level, middle)
  }
  return median
}

export function describeDays(days: number | undefined): string {
  if (days === undefined) return 'never (10 yr+)'
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
  const totals = SIMULATED_USERS.map((userId) => {
    const ledger = new Ledger(userId)
    const owed = new Map<EventName, number>()
    const counter = { value: 0 }
    for (let day = 1; day <= 365; day++) playDay(ledger, persona, day, owed, counter)
    return ledger.xp
  }).sort((a, b) => a - b)
  return totals[Math.floor(totals.length / 2)]
}

export function renderTargets(rows: { persona: Persona; reached: Map<number, number> }[]): string {
  const lines = ['| Target | Wanted | Simulated | XP a day: needed / earned | |', '| --- | --- | --- | --- | --- |']
  const firstProject = levelAfterFirstProject()
  lines.push(`| First project and its achievement | level 4 | level ${firstProject} | | ${firstProject === 4 ? 'met' : 'MISSED'} |`)
  for (const target of TARGETS) {
    const reached = rows.find((row) => row.persona.name === target.persona)?.reached.get(target.level)
    const verdict = reached === undefined ? 'MISSED' : reached < target.from - WINDOW_SLACK_DAYS ? 'MISSED (too fast)' : reached > target.to + WINDOW_SLACK_DAYS ? 'MISSED (too slow)' : 'met'
    const persona = rows.find((row) => row.persona.name === target.persona)!.persona
    const needed = Math.round(xpAtLevelStart(target.level) / ((target.from + target.to) / 2))
    lines.push(`| ${target.persona}: ${target.label} | ${target.from}-${target.to} d | ${describeDays(reached)} | ${needed} / ${Math.round(yearlyXp(persona) / 365)} | ${verdict} |`)
  }
  const power = rows.find((row) => row.persona.name === 'Power')?.reached.get(80)
  lines.push(`| Mythic is top-0.1% territory | not within 3 years of steady play | Power: ${describeDays(power)} | | ${power === undefined || power > 3 * 365 ? 'met' : 'MISSED'} |`)
  return lines.join('\n')
}

function main() {
  const rows = [...PERSONAS, POWER_WINS, CEILING].map((persona) => ({ persona, reached: daysToLevels(persona) }))
  console.log(renderTable(rows))
  console.log('')
  console.log(renderTargets(rows))
  console.log('')
  for (const { persona } of rows) {
    console.log(`- **${persona.name}**: ${persona.description} Earns about ${Math.round(yearlyXp(persona) / 365)} XP a day over its first year.`)
  }
}

if (require.main === module) main()
