import { describe, it, expect, vi } from 'vitest'
import { EVENT_TICKS, METRICS, recordTick, ticksFor, type Tick } from './metrics'
import { DOMAIN_EVENT_NAMES } from './events'
import type { Db } from './events'

const paid = (...ids: string[]) => new Set(ids)
const sample = {
  userId: 'a',
  otherUserId: 'b',
  endorserId: 'b',
  projectId: 'p1',
  projectName: 'P',
  updateId: 'u1',
  milestoneId: 'm1',
  hackathonId: 'h1',
  hackathonName: 'H',
  hackathonTeamId: 'ht1',
  teamId: 't1',
  applicationId: 'ap1',
  evidenceId: 'ev1',
  skillId: 's1',
  connectionId: 'c1',
  conversationId: 'cv1',
  messageId: 'ms1',
  recipientId: 'b',
  repliedToUserId: 'b',
  postId: 'po1',
  giverId: 'b',
  dateKey: '2026-10-16',
  kind: 'SHIP',
}

describe('EVENT_TICKS', () => {
  it('counts every metric somewhere, and nothing that is not a metric', () => {
    const counted = new Set<string>()
    for (const name of DOMAIN_EVENT_NAMES) for (const tick of ticksFor(name, sample as never, paid('a', 'b'))) counted.add(tick.metric)
    expect([...counted].sort()).toEqual([...METRICS].sort())
  })

  it('counts a Ship Day post once per Ship Day, and a SHIP post also for the Ship Day quest', () => {
    const post = { userId: 'a', postId: 'po1', dateKey: '2026-10-16' }
    expect(ticksFor('POST_SHIP_DAY', { ...post, kind: 'DEMO' }, paid())).toEqual([{ userId: 'a', metric: 'ship_day_posts', dedupeKey: '2026-10-16' }])
    expect(ticksFor('POST_SHIP_DAY', { ...post, kind: 'SHIP' }, paid())).toEqual([
      { userId: 'a', metric: 'ship_day_posts', dedupeKey: '2026-10-16' },
      { userId: 'a', metric: 'ship_day_ships', dedupeKey: '2026-10-16' },
    ])
  })

  it.each([
    ['PROJECT_CREATED', 'projects_created', 'p1'],
    ['PROJECT_SHIPPED', 'ships', 'p1'],
    ['PROJECT_UPDATE_POSTED', 'updates', 'u1'],
    ['MILESTONE_COMPLETED', 'milestones', 'm1'],
    ['HACKATHON_JOINED', 'hackathons_joined', 'h1'],
    ['HACKATHON_WON', 'hackathon_wins', 'h1'],
    ['TEAM_FORMED', 'crews_formed', 'h1'],
    ['TEAM_APPLICATION_ACCEPTED', 'teams_joined', 'ap1'],
    ['EVIDENCE_ADDED', 'evidence_added', 'ev1'],
    ['MESSAGE_SENT_FIRST_IN_CONNECTION', 'first_messages', 'cv1'],
  ] as const)('%s counts %s once per thing (%s) for the person who was paid', (name, metric, key) => {
    expect(ticksFor(name, sample as never, paid('a'))).toEqual([{ userId: 'a', metric, dedupeKey: key }])
  })

  it.each(['PROJECT_CREATED', 'PROJECT_SHIPPED', 'MILESTONE_COMPLETED', 'EVIDENCE_ADDED', 'HACKATHON_WON'] as const)(
    '%s counts nothing when the award did not pay (a cap, a repeat)',
    (name) => {
      expect(ticksFor(name, sample as never, paid())).toEqual([])
      expect(ticksFor(name, sample as never, paid('b'))).toEqual([])
    }
  )

  it('counts an endorsement as received by the owner and given by the endorser, once per pair', () => {
    expect(ticksFor('EVIDENCE_ENDORSED', sample as never, paid('a'))).toEqual([
      { userId: 'a', metric: 'endorsements_received', dedupeKey: 'ev1:b' },
      { userId: 'b', metric: 'endorsements_given', dedupeKey: 'ev1:b' },
    ])
    // If the owner's award did not pay, neither side counts: the endorser cannot farm it.
    expect(ticksFor('EVIDENCE_ENDORSED', sample as never, paid())).toEqual([])
  })

  it('counts a connection for each person who was paid for it', () => {
    expect(ticksFor('CONNECTION_ACCEPTED', sample as never, paid('a', 'b')).map((tick) => tick.userId)).toEqual(['a', 'b'])
    expect(ticksFor('CONNECTION_ACCEPTED', sample as never, paid('b'))).toEqual([{ userId: 'b', metric: 'connections', dedupeKey: 'c1' }])
    expect(ticksFor('CONNECTION_ACCEPTED', sample as never, paid())).toEqual([])
  })

  it('counts a reply without any payment, since replying pays no XP of its own', () => {
    expect(ticksFor('MESSAGE_REPLIED', sample as never, paid())).toEqual([{ userId: 'a', metric: 'replies', dedupeKey: 'ms1' }])
  })

  it('counts nothing for the events the rewards engine announces about itself', () => {
    expect(EVENT_TICKS.STREAK_EXTENDED).toBeUndefined()
    expect(EVENT_TICKS.USER_COMEBACK).toBeUndefined()
    expect(ticksFor('STREAK_EXTENDED', sample as never, paid('a'))).toEqual([])
  })
})

describe('recordTick', () => {
  const tick: Tick = { userId: 'u1', metric: 'ships', dedupeKey: 'p1' }

  function fakeTx(duplicate = false) {
    return {
      progressTick: { createMany: vi.fn(async () => ({ count: duplicate ? 0 : 1 })) },
      $executeRaw: vi.fn(async () => 1),
      $queryRaw: vi.fn(async () => [{ value: 7 }]),
    }
  }

  it('records the tick, raises the counter and returns the new total', async () => {
    const tx = fakeTx()
    const when = new Date('2026-03-10T10:00:00Z')
    expect(await recordTick(tx as unknown as Db, tick, when)).toBe(7)
    expect(tx.progressTick.createMany).toHaveBeenCalledWith({
      data: [{ userId: 'u1', metric: 'ships', dedupeKey: 'p1', createdAt: when }],
      skipDuplicates: true,
    })
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1)
  })

  it('counts a repeated tick once: it returns null and leaves the counter alone', async () => {
    const tx = fakeTx(true)
    expect(await recordTick(tx as unknown as Db, tick)).toBeNull()
    expect(tx.$queryRaw).not.toHaveBeenCalled()
  })

  it('takes the lock for the user once per transaction, however many ticks', async () => {
    const tx = fakeTx()
    await recordTick(tx as unknown as Db, tick)
    await recordTick(tx as unknown as Db, { ...tick, dedupeKey: 'p2' })
    await recordTick(tx as unknown as Db, { ...tick, metric: 'milestones', dedupeKey: 'm1' })
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1)
    await recordTick(tx as unknown as Db, { ...tick, userId: 'u2' })
    expect(tx.$executeRaw).toHaveBeenCalledTimes(2)
  })
})

describe('squad ticks', () => {
  it('counts a submitted squad once per hackathon, and only when it paid', () => {
    const payload = { userId: 'u', teamId: 't', hackathonId: 'h', hackathonName: 'H' }
    expect(ticksFor('SQUAD_SUBMITTED', payload, new Set(['u']))).toEqual([{ userId: 'u', metric: 'squads', dedupeKey: 'h' }])
    expect(ticksFor('SQUAD_SUBMITTED', payload, new Set())).toEqual([])
  })

  it('counts a pool squad and a reunion without a payment, once per hackathon', () => {
    expect(ticksFor('AUTO_SQUAD_FORMED', { userId: 'u', teamId: 't', hackathonId: 'h', proposalId: 'p' }, new Set())).toEqual([{ userId: 'u', metric: 'pool_squads', dedupeKey: 'h' }])
    expect(ticksFor('SQUAD_REUNITED', { userId: 'u', teamId: 't', hackathonId: 'h' }, new Set())).toEqual([{ userId: 'u', metric: 'reunions', dedupeKey: 'h' }])
  })

  it('counts nothing for a filled slot or a confirmed join: they only pay XP', () => {
    expect(ticksFor('SQUAD_SLOT_FILLED', { userId: 'o', teamId: 't', slotId: 's', filledById: 'f' }, new Set(['o']))).toEqual([])
    expect(ticksFor('SQUAD_JOIN_CONFIRMED', { userId: 'u', ownerId: 'o', teamId: 't', hackathonId: 'h', hackathonName: 'H' }, new Set(['u']))).toEqual([])
  })
})
