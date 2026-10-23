import type { Ctx, Person } from './types'
import { HOUR_MS } from './types'
import { atMoment, STAMPED } from './clock'
import type { Rng } from './rng'
import { SKILLS, SPARK_OPENERS } from './catalog'
import { generateDropsForUser } from '../../src/lib/matching/drops'
import { loadTodayDrops, passDrop } from '../../src/lib/matching/drop-view'
import { sendSpark } from '../../src/lib/matching/sparks'
import { counterpartType } from '../../src/lib/matching/types'
import { addDaysToDateKey, localDateKey, localDateStart } from '../../src/lib/time'
import type { MatchType } from '@prisma/client'

// Matching, through the matching functions: each of the last days every person with a matching profile is given their drops at their chosen time (the scoring engine picks who), looks at
// them (which counts a view), and sparks, passes or lets them go; a spark is sometimes answered, which makes a match with its conversation. Messages in those conversations are
// written directly, as the match writer writes its openers (no event, no XP): docs/SEED.md.

const MATCH_STAMPED = [...STAMPED, { table: 'Drop', column: 'createdAt' }, { table: 'Spark', column: 'createdAt' }, { table: 'Match', column: 'createdAt' }, { table: 'Message', column: 'createdAt' }]

const skillName = (slug: string) => SKILLS.find((skill) => skill.slug === slug)?.name ?? slug

function openerFor(rng: Rng, me: Person, other: Person, thing: string): string {
  const mine = skillName(me.skills[0]?.slug ?? 'building')
  const theirs = skillName(other.skills[0]?.slug ?? 'shipping')
  const text = rng.pick(SPARK_OPENERS).replace('{thing}', thing).replace('{mine}', mine).replace('{theirs}', theirs)
  // The first name keeps two openers from reading as the same message.
  return `${other.name.split(' ')[0]}, ${text.charAt(0).toLowerCase()}${text.slice(1)}`.slice(0, 270)
}

const THREAD = [
  'Thanks for the spark! Your last update was exactly the kind of thing I was hoping to find.',
  'Glad it landed. I have a weekend free after next. Want to sketch the first version together?',
  'Yes. I can take the data model and the API; you take the front end and the demo?',
  'Deal. I will open a repo tonight and drop the link here.',
  'Repo is up. I added a short README with the plan, tell me what is wrong with it.',
  'Read it. The plan is good; I would cut the second milestone and ship the first sooner.',
]

export interface MatchingResult {
  drops: number
  sparks: number
  matches: number
  passed: number
}

export async function seedMatching(ctx: Ctx): Promise<MatchingResult> {
  const { db, rng } = ctx
  const eligible = ctx.people.filter((person) => person.tier === 'core' && (person.activity > 0.08 || person.streaky) && person.createdAt.getTime() < ctx.now.getTime() - 10 * 24 * HOUR_MS)
  const result: MatchingResult = { drops: 0, sparks: 0, matches: 0, passed: 0 }
  const DAYS = 6
  for (let k = DAYS; k >= 0; k--) {
    const reciprocate: { fromId: string; toId: string; type: MatchType; thing: string }[] = []
    for (const person of rng.fork(`match-order-${k}`).shuffle(eligible)) {
      const dayKey = addDaysToDateKey(localDateKey(ctx.now, person.city.timezone), -k)
      const dropAt = new Date(localDateStart(dayKey, person.city.timezone).getTime() + (Number(person.dropTime.slice(0, 2)) * 60 + Number(person.dropTime.slice(3, 5)) + 3) * 60_000)
      if (dropAt.getTime() > ctx.now.getTime() - 5 * 60_000) continue
      const r = rng.fork(`match-${k}-${person.id}`)
      const made = await atMoment(db, dropAt, () => generateDropsForUser(db, person.id, dropAt, { enforced: false }), MATCH_STAMPED)
      result.drops += made.created
      if (made.created === 0) continue
      // Today's drops are left for the person to open; earlier days they looked at and answered.
      if (k === 0) continue
      const actAt = new Date(Math.min(ctx.now.getTime() - 30 * 60_000, dropAt.getTime() + r.int(1, 12) * HOUR_MS))
      await atMoment(
        db,
        actAt,
        async () => {
          const today = await loadTodayDrops(db, person.id, actAt)
          for (const drop of today.drops) {
            const roll = r.next()
            const candidate = ctx.byId.get(drop.candidate.id)
            if (!candidate || drop.status !== 'NEW') continue
            if (roll < 0.34) {
              const type = drop.connectionType as MatchType
              const sent = await sendSpark(db, person.id, { toId: candidate.id, connectionType: type, opener: openerFor(r, person, candidate, ctx.state.get(candidate.id)?.projects[0]?.name ?? candidate.headline.slice(0, 40)), dropId: drop.id }, { now: actAt, enforced: false })
              if (sent.ok) {
                result.sparks += 1
                if (sent.match) result.matches += 1
                else if (r.chance(0.4)) reciprocate.push({ fromId: candidate.id, toId: person.id, type: counterpartType(type) as MatchType, thing: person.skills[0]?.slug ?? 'building' })
              }
            } else if (roll < 0.62) {
              if ((await passDrop(db, person.id, drop.id, actAt)) === 'PASSED') result.passed += 1
            }
          }
        },
        MATCH_STAMPED
      )
    }
    // The people sparked write back, a little later: the matches.
    for (const answer of reciprocate) {
      const from = ctx.byId.get(answer.fromId)!
      const to = ctx.byId.get(answer.toId)!
      const at = new Date(Math.min(ctx.now.getTime() - 20 * 60_000, ctx.now.getTime() - (k - 0.4) * 24 * HOUR_MS))
      await atMoment(
        db,
        at,
        async () => {
          const sent = await sendSpark(db, from.id, { toId: to.id, connectionType: answer.type, opener: openerFor(rng, from, to, answer.thing) }, { now: at, enforced: false })
          if (sent.ok) {
            result.sparks += 1
            if (sent.match) result.matches += 1
          }
        },
        MATCH_STAMPED
      )
    }
  }

  // Conversations that went somewhere: a few messages over the next days, read by the other side.
  const matches = await db.match.findMany({ where: { endedAt: null, connectionType: { not: 'DATING' }, conversationId: { not: null }, userAId: { startsWith: 'sd_' } }, select: { id: true, userAId: true, userBId: true, conversationId: true, createdAt: true } })
  for (const match of matches) {
    const r = rng.fork(`thread-${match.id}`)
    if (!r.chance(0.65)) continue
    const lines = r.int(2, THREAD.length)
    let at = match.createdAt.getTime()
    for (let i = 0; i < lines; i++) {
      at += r.int(20, 600) * 60_000
      if (at > ctx.now.getTime() - 10 * 60_000) break
      const senderId = i % 2 === 0 ? match.userBId : match.userAId
      const message = await db.message.create({ data: { conversationId: match.conversationId!, senderId, content: THREAD[i], createdAt: new Date(at) } })
      const reader = senderId === match.userAId ? match.userBId : match.userAId
      if (r.chance(0.75)) await db.messageRead.create({ data: { messageId: message.id, userId: reader, readAt: new Date(at + r.int(1, 90) * 60_000) } }).catch(() => undefined)
    }
    await db.conversation.update({ where: { id: match.conversationId! }, data: { updatedAt: new Date(at) } })
  }
  return result
}
