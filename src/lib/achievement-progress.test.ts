import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Db } from './events'

const grantAchievement = vi.fn()
vi.mock('@/lib/achievements', () => ({ grantAchievement: (...args: unknown[]) => grantAchievement(...args) }))
const advanceQuests = vi.fn()
vi.mock('@/lib/quest-progress', () => ({ advanceQuests: (...args: unknown[]) => advanceQuests(...args) }))
const recordTick = vi.fn()
const lockProgress = vi.fn()
vi.mock('@/lib/metrics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/metrics')>()),
  recordTick: (...args: unknown[]) => recordTick(...args),
  lockProgress: (...args: unknown[]) => lockProgress(...args),
}))

import { advanceProgress, unlockGoldenVouch, unlockSeries, unlockShipSecrets, unlockStreak, usersInvolved } from './achievement-progress'
import { xpAtLevelStart } from './levels'

interface FakeState {
  owned?: string[]
  timezone?: string | null
  shipTicks?: Date[]
  endorserXp?: number | null
}

function fakeTx(state: FakeState = {}) {
  return {
    userAchievement: { findMany: vi.fn(async () => (state.owned ?? []).map((slug) => ({ achievement: { slug } }))) },
    progressTick: { findMany: vi.fn(async () => (state.shipTicks ?? []).map((createdAt) => ({ createdAt }))) },
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        if (where.id === 'endorser') return state.endorserXp === null ? null : { xp: state.endorserXp ?? 0 }
        return { timezone: state.timezone ?? null }
      }),
    },
  } as unknown as Db
}

const granted = (slugs: string[]) => slugs.map((slug) => grantAchievement.mock.calls.find((call) => call[2] === slug)).filter(Boolean).length
const grantedSlugs = () => grantAchievement.mock.calls.map((call) => call[2])

beforeEach(() => {
  grantAchievement.mockReset().mockResolvedValue({ granted: true })
  recordTick.mockReset()
  advanceQuests.mockReset().mockResolvedValue(0)
  lockProgress.mockReset().mockResolvedValue(undefined)
})

describe('unlockSeries', () => {
  it('unlocks the first tier at 1, with the counter stored as the progress', async () => {
    expect(await unlockSeries(fakeTx(), 'u1', 'ships', 1)).toBe(1)
    expect(grantAchievement).toHaveBeenCalledWith(expect.anything(), 'u1', 'first-ship', { current: 1, target: 1 })
  })

  it('unlocks nothing below the first target', async () => {
    expect(await unlockSeries(fakeTx(), 'u1', 'streak_days', 6)).toBe(0)
    expect(grantAchievement).not.toHaveBeenCalled()
  })

  it('unlocks the tier whose target is met exactly, and not the next', async () => {
    await unlockSeries(fakeTx({ owned: ['first-ship'] }), 'u1', 'ships', 5)
    expect(grantedSlugs()).toEqual(['ship-5'])
    expect(grantAchievement).toHaveBeenCalledWith(expect.anything(), 'u1', 'ship-5', { current: 5, target: 5 })
  })

  it('does not grant a tier the user already has', async () => {
    expect(await unlockSeries(fakeTx({ owned: ['first-ship', 'ship-5'] }), 'u1', 'ships', 5)).toBe(0)
    expect(grantAchievement).not.toHaveBeenCalled()
  })

  it('catches up every tier a counter has already passed, lowest first: a counter backfilled from history', async () => {
    expect(await unlockSeries(fakeTx(), 'u1', 'ships', 30)).toBe(3)
    expect(grantedSlugs()).toEqual(['first-ship', 'ship-5', 'ship-25'])
    expect(grantAchievement).toHaveBeenLastCalledWith(expect.anything(), 'u1', 'ship-25', { current: 30, target: 25 })
  })

  it('counts only the unlocks that actually happened', async () => {
    grantAchievement.mockResolvedValueOnce({ granted: false }).mockResolvedValue({ granted: true })
    expect(await unlockSeries(fakeTx(), 'u1', 'ships', 5)).toBe(1)
  })

  it('does not even ask the database when no target has been reached', async () => {
    const tx = fakeTx()
    await unlockSeries(tx, 'u1', 'hackathon_wins', 0)
    expect((tx as unknown as { userAchievement: { findMany: ReturnType<typeof vi.fn> } }).userAchievement.findMany).not.toHaveBeenCalled()
  })
})

describe('Night Owl: a ship between 02:00 and 05:00 local time', () => {
  const night = (iso: string, timezone: string | null = null) => unlockShipSecrets(fakeTx({ timezone, shipTicks: [new Date(iso)] }), 'u1', new Date(iso))

  it.each([
    ['01:59:59', false],
    ['02:00:00', true],
    ['03:30:00', true],
    ['04:59:59', true],
    ['05:00:00', false],
    ['12:00:00', false],
    ['00:00:00', false],
  ])('at %s UTC: %s', async (time, unlocks) => {
    await night(`2026-03-11T${time}Z`)
    expect(grantedSlugs().includes('night-owl')).toBe(unlocks)
  })

  it('uses the local hour: 21:30Z is 03:00 in Kolkata, and 14:30 in Los Angeles', async () => {
    await night('2026-03-10T21:30:00Z', 'Asia/Kolkata')
    expect(grantedSlugs()).toContain('night-owl')
    grantAchievement.mockClear()
    await night('2026-03-10T21:30:00Z', 'America/Los_Angeles')
    expect(grantedSlugs()).not.toContain('night-owl')
  })
})

describe('Hat Trick: three ships in one local week', () => {
  const week = (ticks: string[], now: string, timezone: string | null = null) =>
    unlockShipSecrets(fakeTx({ timezone, shipTicks: ticks.map((tick) => new Date(tick)) }), 'u1', new Date(now))

  it('unlocks on the third ship of the week and not before', async () => {
    await week(['2026-03-09T10:00:00Z', '2026-03-10T10:00:00Z'], '2026-03-10T10:00:00Z')
    expect(grantedSlugs()).not.toContain('hat-trick')
    await week(['2026-03-09T10:00:00Z', '2026-03-10T10:00:00Z', '2026-03-12T10:00:00Z'], '2026-03-12T10:00:00Z')
    expect(grantedSlugs()).toContain('hat-trick')
  })

  it('asks only for the ships since the local Monday', async () => {
    const tx = fakeTx({ timezone: 'Asia/Kolkata' })
    await unlockShipSecrets(tx, 'u1', new Date('2026-03-11T10:00:00Z'))
    const query = (tx as unknown as { progressTick: { findMany: ReturnType<typeof vi.fn> } }).progressTick.findMany.mock.calls[0][0]
    // Monday 2026-03-09 00:00 in Kolkata is Sunday 18:30Z.
    expect(query.where).toEqual({ userId: 'u1', metric: 'ships', createdAt: { gte: new Date('2026-03-08T18:30:00.000Z') } })
  })
})

describe('Weekend Warrior: a weekend ship after a weekday ship in the same week', () => {
  const ship = (ticks: string[], now: string, timezone: string | null = null) =>
    unlockShipSecrets(fakeTx({ timezone, shipTicks: [...ticks, now].map((tick) => new Date(tick)) }), 'u1', new Date(now))

  it('unlocks for a Saturday ship after a Wednesday one', async () => {
    await ship(['2026-03-11T10:00:00Z'], '2026-03-14T10:00:00Z')
    expect(grantedSlugs()).toContain('weekend-warrior')
  })

  it('does not unlock for a weekend ship that is the first of the week, or follows only weekend ships', async () => {
    await ship([], '2026-03-14T10:00:00Z')
    await ship(['2026-03-14T08:00:00Z'], '2026-03-15T10:00:00Z')
    expect(grantedSlugs()).not.toContain('weekend-warrior')
  })

  it('does not unlock for a weekday ship, however many came before', async () => {
    await ship(['2026-03-09T10:00:00Z', '2026-03-10T10:00:00Z'], '2026-03-11T10:00:00Z')
    expect(grantedSlugs()).not.toContain('weekend-warrior')
  })

  it('decides weekday and weekend by the local calendar', async () => {
    // 20:00Z Friday is already Saturday 01:30 in Kolkata: a Friday-evening ship counts as the weekend there.
    await ship(['2026-03-11T10:00:00Z'], '2026-03-13T20:00:00Z', 'Asia/Kolkata')
    expect(grantedSlugs()).toContain('weekend-warrior')
    grantAchievement.mockClear()
    await ship(['2026-03-11T10:00:00Z'], '2026-03-13T20:00:00Z', 'America/Los_Angeles')
    expect(grantedSlugs()).not.toContain('weekend-warrior')
  })
})

describe('Golden Vouch: an endorsement from Gold or above', () => {
  const gold = xpAtLevelStart(20)

  it('unlocks at exactly Gold, and not one XP below', async () => {
    expect(await unlockGoldenVouch(fakeTx({ endorserXp: gold }), 'owner', 'endorser')).toBe(1)
    expect(grantAchievement).toHaveBeenCalledWith(expect.anything(), 'owner', 'golden-vouch')
    grantAchievement.mockClear()
    expect(await unlockGoldenVouch(fakeTx({ endorserXp: gold - 1 }), 'owner', 'endorser')).toBe(0)
    expect(grantAchievement).not.toHaveBeenCalled()
  })

  it('unlocks for a Mythic endorser too', async () => {
    expect(await unlockGoldenVouch(fakeTx({ endorserXp: xpAtLevelStart(90) }), 'owner', 'endorser')).toBe(1)
  })

  it('does nothing for an endorser that cannot be found', async () => {
    expect(await unlockGoldenVouch(fakeTx({ endorserXp: null }), 'owner', 'endorser')).toBe(0)
  })
})

describe('streak achievements', () => {
  it('unlocks the streak tiers as the run grows', async () => {
    await unlockStreak(fakeTx(), 'u1', 7, false)
    expect(grantedSlugs()).toEqual(['streak-7'])
  })

  it('unlocks No Safety Net at 30 days without a freeze, and not with one', async () => {
    await unlockStreak(fakeTx({ owned: ['streak-7'] }), 'u1', 30, false)
    expect(grantedSlugs()).toEqual(['streak-30', 'no-safety-net'])
    grantAchievement.mockClear()
    await unlockStreak(fakeTx({ owned: ['streak-7'] }), 'u1', 30, true)
    expect(grantedSlugs()).toEqual(['streak-30'])
  })

  it('does not unlock No Safety Net before 30 days', async () => {
    await unlockStreak(fakeTx(), 'u1', 29, false)
    expect(grantedSlugs()).not.toContain('no-safety-net')
  })
})

describe('usersInvolved', () => {
  it('names everyone an event is about, so they can be locked together', () => {
    expect(usersInvolved('PROJECT_CREATED', { userId: 'a', projectId: 'p', projectName: 'P' })).toEqual(['a'])
    expect(usersInvolved('EVIDENCE_ENDORSED', { userId: 'owner', endorserId: 'e', evidenceId: 'x' })).toEqual(['owner', 'e'])
    expect(usersInvolved('CONNECTION_ACCEPTED', { userId: 'a', otherUserId: 'b', connectionId: 'c' })).toEqual(['a', 'b'])
  })
})

describe('advanceProgress', () => {
  const created = { userId: 'u1', projectId: 'p1', projectName: 'P' }

  it('counts the tick and unlocks what the count reaches', async () => {
    recordTick.mockResolvedValue(1)
    const result = await advanceProgress(fakeTx(), 'PROJECT_CREATED', created, new Set(['u1']))
    expect(result).toEqual({ unlocked: 1 })
    expect(recordTick).toHaveBeenCalledWith(expect.anything(), { userId: 'u1', metric: 'projects_created', dedupeKey: 'p1' }, expect.any(Date))
    expect(granted(['first-project'])).toBe(1)
  })

  it('moves the user’s quests by the same count, in their time zone', async () => {
    recordTick.mockResolvedValue(1)
    const when = new Date('2026-03-10T10:00:00Z')
    await advanceProgress(fakeTx({ timezone: 'Asia/Kolkata' }), 'PROJECT_CREATED', created, new Set(['u1']), when)
    expect(advanceQuests).toHaveBeenCalledTimes(1)
    expect(advanceQuests).toHaveBeenCalledWith(expect.anything(), 'u1', 'projects_created', when, 'Asia/Kolkata')
  })

  it('does not move quests for a tick that was already counted, or an award that did not pay', async () => {
    recordTick.mockResolvedValue(null)
    await advanceProgress(fakeTx(), 'PROJECT_CREATED', created, new Set(['u1']))
    await advanceProgress(fakeTx(), 'PROJECT_CREATED', created, new Set())
    expect(advanceQuests).not.toHaveBeenCalled()
  })

  it('does nothing for an award that did not pay', async () => {
    expect(await advanceProgress(fakeTx(), 'PROJECT_CREATED', created, new Set())).toEqual({ unlocked: 0 })
    expect(recordTick).not.toHaveBeenCalled()
  })

  it('does nothing for a tick that was already counted', async () => {
    recordTick.mockResolvedValue(null)
    expect(await advanceProgress(fakeTx(), 'PROJECT_CREATED', created, new Set(['u1']))).toEqual({ unlocked: 0 })
    expect(grantAchievement).not.toHaveBeenCalled()
  })

  it('checks the ship secrets on a ship, and not on other events', async () => {
    recordTick.mockResolvedValue(2)
    const tx = fakeTx({ shipTicks: [new Date('2026-03-11T03:00:00Z')] })
    await advanceProgress(tx, 'PROJECT_SHIPPED', created, new Set(['u1']), new Date('2026-03-11T03:00:00Z'))
    expect(grantedSlugs()).toContain('night-owl')
    grantAchievement.mockClear()
    await advanceProgress(tx, 'PROJECT_CREATED', created, new Set(['u1']), new Date('2026-03-11T03:00:00Z'))
    expect(grantedSlugs()).not.toContain('night-owl')
  })

  it('counts both sides of an endorsement in id order and checks the Golden Vouch for the owner', async () => {
    recordTick.mockResolvedValue(1)
    const tx = fakeTx({ endorserXp: xpAtLevelStart(25) })
    await advanceProgress(tx, 'EVIDENCE_ENDORSED', { userId: 'owner', endorserId: 'endorser', evidenceId: 'e1' }, new Set(['owner']))
    expect(recordTick.mock.calls.map((call) => [call[1].userId, call[1].metric])).toEqual([
      ['endorser', 'endorsements_given'],
      ['owner', 'endorsements_received'],
    ])
    expect(grantedSlugs()).toContain('golden-vouch')
    expect(grantAchievement).toHaveBeenCalledWith(expect.anything(), 'owner', 'golden-vouch')
  })

  it('unlocks the streak achievements on STREAK_EXTENDED', async () => {
    await advanceProgress(fakeTx(), 'STREAK_EXTENDED', { userId: 'u1', current: 7, longest: 7, freezeUsedInRun: false }, new Set())
    expect(grantedSlugs()).toEqual(['streak-7'])
    expect(recordTick).not.toHaveBeenCalled()
  })

  it('unlocks Comeback Kid on USER_COMEBACK', async () => {
    expect(await advanceProgress(fakeTx(), 'USER_COMEBACK', { userId: 'u1', idleDays: 45 }, new Set())).toEqual({ unlocked: 1 })
    expect(grantAchievement).toHaveBeenCalledWith(expect.anything(), 'u1', 'comeback-kid')
  })
})
