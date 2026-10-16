import { describe, it, expect, vi, beforeEach } from 'vitest'

const grantSeasonCosmetics = vi.fn()
vi.mock('@/lib/cosmetics', () => ({ grantSeasonCosmetics: (...args: unknown[]) => grantSeasonCosmetics(...args) }))

import { grantPendingSeasonRewards, grantSeasonRewards, nextSeasonWindow, SEASON_LENGTH_DAYS, seasonName } from './seasons'

const DAY = 24 * 60 * 60 * 1000

describe('nextSeasonWindow', () => {
  it('is eight weeks', () => {
    expect(SEASON_LENGTH_DAYS).toBe(56)
  })

  it('starts where the last season stopped, so seasons are back to back', () => {
    const previousEnd = new Date('2026-12-11T12:00:00Z')
    const window = nextSeasonWindow(previousEnd, new Date('2026-12-11T12:30:00Z'))
    expect(window.startsAt.toISOString()).toBe('2026-12-11T12:00:00.000Z')
    expect(window.endsAt.toISOString()).toBe('2027-02-05T12:00:00.000Z')
    expect((window.endsAt.getTime() - window.startsAt.getTime()) / DAY).toBe(56)
  })

  it('still follows on when the job ran a few days late', () => {
    const previousEnd = new Date('2026-12-11T12:00:00Z')
    const window = nextSeasonWindow(previousEnd, new Date('2026-12-20T00:00:00Z'))
    expect(window.startsAt).toEqual(previousEnd)
  })

  it('starts now when the job was down so long that the following season is over too', () => {
    const previousEnd = new Date('2026-12-11T12:00:00Z')
    const now = new Date('2027-04-01T00:00:00Z')
    const window = nextSeasonWindow(previousEnd, now)
    expect(window.startsAt).toEqual(now)
    expect(window.endsAt.getTime() - now.getTime()).toBe(56 * DAY)
  })

  it('starts now at exactly the moment the following season would end', () => {
    const previousEnd = new Date('2026-12-11T12:00:00Z')
    const now = new Date(previousEnd.getTime() + 56 * DAY)
    expect(nextSeasonWindow(previousEnd, now).startsAt).toEqual(now)
    expect(nextSeasonWindow(previousEnd, new Date(now.getTime() - 1)).startsAt).toEqual(previousEnd)
  })
})

describe('seasonName', () => {
  it('numbers them', () => {
    expect(seasonName(1)).toBe('Season 1')
    expect(seasonName(12)).toBe('Season 12')
  })
})

interface SeasonRow {
  id: string
  number: number
  closedAt: Date | null
  rewardsGrantedAt: Date | null
}

/** A database with these seasons, whose transactions run straight through. */
function fakePrisma(seasons: SeasonRow[], ranked = 40) {
  const tx = {
    $executeRaw: vi.fn(async () => 1),
    season: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => seasons.find((season) => season.id === where.id) ?? null),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<SeasonRow> }) => Object.assign(seasons.find((season) => season.id === where.id)!, data)),
    },
    seasonStanding: { count: vi.fn(async () => ranked) },
  }
  return {
    tx,
    prisma: {
      ...tx,
      $transaction: vi.fn(async (run: (client: typeof tx) => Promise<unknown>) => run(tx)),
      season: {
        ...tx.season,
        findMany: vi.fn(async ({ where }: { where: { closedAt: unknown; rewardsGrantedAt: null } }) =>
          seasons.filter((season) => season.closedAt !== null && season.rewardsGrantedAt === where.rewardsGrantedAt).sort((a, b) => a.number - b.number).map((season) => ({ id: season.id }))
        ),
      },
    } as never,
  }
}
const closed = (number: number, over: Partial<SeasonRow> = {}): SeasonRow => ({ id: `s${number}`, number, closedAt: new Date('2026-12-11T00:00:00Z'), rewardsGrantedAt: null, ...over })

beforeEach(() => {
  grantSeasonCosmetics.mockReset().mockResolvedValue([{ award: 'TOP_100', cutoff: 40, granted: 40 }])
})

describe('grantSeasonRewards', () => {
  const now = new Date('2026-12-11T01:00:00Z')

  it('grants a closed season’s cosmetics once and marks it done', async () => {
    const seasons = [closed(1)]
    const { prisma, tx } = fakePrisma(seasons)
    const result = await grantSeasonRewards(prisma, 's1', now)
    expect(result).toEqual({ seasonId: 's1', seasonNumber: 1, ranked: 40, grants: [{ award: 'TOP_100', cutoff: 40, granted: 40 }] })
    expect(grantSeasonCosmetics).toHaveBeenCalledWith(tx, expect.objectContaining({ id: 's1', number: 1 }), now)
    expect(seasons[0].rewardsGrantedAt).toEqual(now)
  })

  it('does nothing for a season that has been done, so a second run grants and marks nothing', async () => {
    const seasons = [closed(1)]
    const { prisma, tx } = fakePrisma(seasons)
    await grantSeasonRewards(prisma, 's1', now)
    expect(await grantSeasonRewards(prisma, 's1', new Date(now.getTime() + 3600_000))).toBeNull()
    expect(grantSeasonCosmetics).toHaveBeenCalledTimes(1)
    expect(tx.season.update).toHaveBeenCalledTimes(1)
  })

  it('does nothing for a season that is still running, or one that does not exist', async () => {
    const { prisma } = fakePrisma([{ id: 'run', number: 2, closedAt: null, rewardsGrantedAt: null }])
    expect(await grantSeasonRewards(prisma, 'run', now)).toBeNull()
    expect(await grantSeasonRewards(prisma, 'nope', now)).toBeNull()
    expect(grantSeasonCosmetics).not.toHaveBeenCalled()
  })

  it('takes a lock for the season first, so two runs cannot do it at once', async () => {
    const { prisma, tx } = fakePrisma([closed(1)])
    await grantSeasonRewards(prisma, 's1', now)
    expect(tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(grantSeasonCosmetics.mock.invocationCallOrder[0])
  })

  it('does not mark the season done if granting failed, so the next run tries again', async () => {
    const seasons = [closed(1)]
    grantSeasonCosmetics.mockRejectedValueOnce(new Error('database went away'))
    const { prisma } = fakePrisma(seasons)
    await expect(grantSeasonRewards(prisma, 's1', now)).rejects.toThrow('went away')
    expect(seasons[0].rewardsGrantedAt).toBeNull()
    expect(await grantSeasonRewards(prisma, 's1', now)).not.toBeNull()
    expect(seasons[0].rewardsGrantedAt).toEqual(now)
  })
})

describe('grantPendingSeasonRewards', () => {
  const now = new Date('2026-12-11T01:00:00Z')

  it('catches up every closed season that is owed its cosmetics, oldest first, and skips the done and the running', async () => {
    const seasons = [closed(3), closed(1), closed(2, { rewardsGrantedAt: new Date('2026-11-01T00:00:00Z') }), { id: 's4', number: 4, closedAt: null, rewardsGrantedAt: null }]
    const { prisma } = fakePrisma(seasons)
    const done = await grantPendingSeasonRewards(prisma, now)
    expect(done.map((result) => result.seasonNumber)).toEqual([1, 3])
    expect(seasons.map((season) => [season.number, season.rewardsGrantedAt !== null])).toEqual([[3, true], [1, true], [2, true], [4, false]])
  })

  it('is empty when nothing is owed, and so is the run after it', async () => {
    const { prisma } = fakePrisma([closed(1)])
    expect(await grantPendingSeasonRewards(prisma, now)).toHaveLength(1)
    expect(await grantPendingSeasonRewards(prisma, now)).toEqual([])
    expect(grantSeasonCosmetics).toHaveBeenCalledTimes(1)
  })
})
