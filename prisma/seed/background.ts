import type { Prisma } from '@prisma/client'
import type { Ctx } from './types'
import { DAY_MS, HOUR_MS } from './types'
import { CORE_PEOPLE, planPeople, register, writePeople } from './people'
import { POST_BODIES, POST_TITLES, UPDATE_TITLES, COMMENT_BODIES, SKILLS } from './catalog'
import { localDateKey } from '../../src/lib/time'

// Background people: everyone past the first 400 when --scale asks for more (10,000 for the performance work, docs/PERFORMANCE.md). They are written in bulk, straight into the tables,
// because 10,000 people through the domain functions would take hours, and they exist to give the busiest queries realistic volumes: a feed, a leaderboard, a search, a pool of
// candidates, notification lists. So their rows follow the same rules as the real ones (an XP event per award with its own dedupe key, and `User.xp` the sum of them; props
// that add up to the post's score; one conversation-less match per pair; drops for the days just gone) but nothing here pays achievements or runs the daily caps, and nobody
// has a streak beyond what their XP days say. Documented in docs/SEED.md.

const chunks = <T>(items: readonly T[], size: number): T[][] => {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

const XP_KINDS = [
  { type: 'PROJECT_UPDATE_POSTED', amount: 15, source: 'PROJECT_UPDATE', weight: 40 },
  { type: 'EVIDENCE_ADDED', amount: 20, source: 'EVIDENCE', weight: 14 },
  { type: 'MILESTONE_COMPLETED', amount: 30, source: 'MILESTONE', weight: 14 },
  { type: 'PROJECT_CREATED', amount: 50, source: 'PROJECT', weight: 8 },
  { type: 'PROPS_RECEIVED', amount: 2, source: 'PROP', weight: 34 },
  { type: 'CONNECTION_ACCEPTED', amount: 10, source: 'CONNECTION', weight: 6 },
] as const

export async function seedBackground(ctx: Ctx): Promise<void> {
  const { db, rng, now, args } = ctx
  const count = args.scale - CORE_PEOPLE
  if (count <= 0) return
  const people = planPeople(rng, count, now, args.days, CORE_PEOPLE)
  register(ctx, people)
  for (const batch of chunks(people, 2500)) await writePeople(ctx, batch)
  ctx.log(`  ${count} background people written`)

  const all = ctx.people
  const active = people.filter((person) => person.activity > 0.03)
  const ids = all.map((person) => person.id)

  // --- XP, projects, updates ---------------------------------------------------------------------------------------------------
  const xpRows: Prisma.XPEventCreateManyInput[] = []
  const projectRows: Prisma.ProjectCreateManyInput[] = []
  const memberRows: Prisma.ProjectMemberCreateManyInput[] = []
  const updateRows: Prisma.ProjectUpdateCreateManyInput[] = []
  const xpTotals = new Map<string, number>()
  const season = await db.season.findFirst({ where: { active: true }, select: { id: true } })
  for (const person of active) {
    const r = rng.fork(`bg-xp-${person.id}`)
    const lifeDays = Math.max(1, Math.floor((now.getTime() - person.createdAt.getTime()) / DAY_MS))
    const events = Math.min(160, Math.round(person.activity * Math.min(lifeDays, args.days) * 0.9 * (person.streaky ? 1.6 : 1)) + r.int(0, 3))
    const projectCount = person.activity > 0.15 ? r.int(1, 3) : r.chance(0.5) ? 1 : 0
    const projectIds: string[] = []
    for (let p = 0; p < projectCount; p++) {
      const id = `sd_p${person.index}_${p}`
      projectIds.push(id)
      const status = r.weighted([['IDEA', 30], ['PLANNING', 18], ['BUILDING', 22], ['TESTING', 8], ['SHIPPED', 17], ['ARCHIVED', 5]] as const)
      const created = new Date(person.createdAt.getTime() + r.int(1, Math.max(1, lifeDays - 1)) * DAY_MS)
      projectRows.push({ id, name: `${person.username}-${p}`, slug: `sd-${person.index.toString(36)}-${p}`, description: 'A background project.', status, ownerId: person.id, techStack: person.skills.slice(0, 3).map((skill) => SKILLS.find((s) => s.slug === skill.slug)?.name ?? skill.slug), startedAt: created, shippedAt: status === 'SHIPPED' ? new Date(created.getTime() + 20 * DAY_MS) : null, createdAt: created })
      memberRows.push({ userId: person.id, projectId: id, role: 'OWNER', joinedAt: created })
    }
    let total = 0
    for (let e = 0; e < events; e++) {
      const kind = r.weighted(XP_KINDS.map((k) => [k, k.weight] as const))
      const at = new Date(person.createdAt.getTime() + r.int(0, lifeDays * 24 - 1) * HOUR_MS)
      if (at.getTime() > now.getTime() - HOUR_MS) continue
      xpRows.push({ userId: person.id, type: kind.type, amount: kind.amount, description: `${kind.type.toLowerCase().replace(/_/g, ' ')}`, sourceType: kind.source, sourceId: `bg-${person.index}-${e}`, dedupeKey: `${kind.source.toLowerCase()}:bg-${person.index}-${e}`, seasonId: at.getTime() >= now.getTime() - 30 * DAY_MS ? season?.id ?? null : null, createdAt: at })
      total += kind.amount
      if (kind.type === 'PROJECT_UPDATE_POSTED' && projectIds.length > 0) {
        updateRows.push({ projectId: r.pick(projectIds), authorId: person.id, title: r.pick(UPDATE_TITLES), content: 'A background update.', type: 'UPDATE', createdAt: at })
      }
    }
    xpTotals.set(person.id, total)
  }
  for (const batch of chunks(projectRows, 4000)) await db.project.createMany({ data: batch, skipDuplicates: true })
  for (const batch of chunks(memberRows, 4000)) await db.projectMember.createMany({ data: batch, skipDuplicates: true })
  for (const batch of chunks(updateRows, 4000)) await db.projectUpdate.createMany({ data: batch })
  for (const batch of chunks(xpRows, 5000)) await db.xPEvent.createMany({ data: batch, skipDuplicates: true })
  // User.xp is the sum of the log, and the level follows from it, as in grant().
  for (const batch of chunks([...xpTotals.entries()], 500)) {
    await db.$executeRaw`UPDATE "User" u SET "xp" = v.xp FROM (SELECT unnest(${batch.map(([id]) => id)}::text[]) AS id, unnest(${batch.map(([, xp]) => xp)}::int[]) AS xp) v WHERE u."id" = v.id`
  }
  ctx.log(`  ${xpRows.length} XP events, ${projectRows.length} projects, ${updateRows.length} project updates`)

  // --- Posts, Props, comments ---------------------------------------------------------------------------------------------------
  const postRows: Prisma.ShipPostCreateManyInput[] = []
  for (const person of active) {
    const r = rng.fork(`bg-post-${person.id}`)
    const lifeDays = Math.max(1, Math.floor((now.getTime() - person.createdAt.getTime()) / DAY_MS))
    const posts = Math.min(30, Math.round(person.activity * Math.min(lifeDays, args.days) * 0.12) + (r.chance(0.3) ? 1 : 0))
    for (let k = 0; k < posts; k++) {
      const kind = r.weighted([['UPDATE', 55], ['DEVLOG', 18], ['SHIP', 17], ['DEMO', 10]] as const)
      const at = new Date(person.createdAt.getTime() + r.int(0, lifeDays * 24 - 1) * HOUR_MS)
      if (at.getTime() > now.getTime() - HOUR_MS) continue
      postRows.push({ id: `sd_post_${person.index}_${k}`, authorId: person.id, kind, title: r.pick(POST_TITLES[kind]).replace('{name}', `${person.username}-${k % 3}`), body: r.pick(POST_BODIES), stackTags: person.skills.slice(0, 2).map((skill) => skill.slug), visibility: 'PUBLIC', shipDayKey: null, createdAt: at })
    }
  }
  for (const batch of chunks(postRows, 4000)) await db.shipPost.createMany({ data: batch, skipDuplicates: true })

  const propRows: Prisma.PropCreateManyInput[] = []
  const commentRows: Prisma.CommentCreateManyInput[] = []
  const propTotals = new Map<string, { score: number; count: number; comments: number }>()
  for (const post of postRows) {
    const r = rng.fork(`bg-react-${post.id}`)
    const author = post.authorId
    const propCount = Math.min(40, Math.round(r.next() ** 2.2 * 40))
    const givers = new Set<string>()
    for (let k = 0; k < propCount; k++) {
      const giver = ids[r.int(0, ids.length - 1)]
      if (giver === author || givers.has(giver)) continue
      givers.add(giver)
      propRows.push({ userId: giver, postId: post.id!, weight: 1, createdAt: new Date((post.createdAt as Date).getTime() + r.int(1, 72) * HOUR_MS) })
    }
    const comments = Math.min(8, Math.round(r.next() ** 2.5 * 8))
    for (let k = 0; k < comments; k++) {
      const commenter = ids[r.int(0, ids.length - 1)]
      if (commenter === author) continue
      commentRows.push({ id: `sd_c_${post.id}_${k}`, postId: post.id!, authorId: commenter, body: r.pick(COMMENT_BODIES), createdAt: new Date((post.createdAt as Date).getTime() + r.int(1, 96) * HOUR_MS) })
    }
    propTotals.set(post.id!, { score: givers.size, count: givers.size, comments })
  }
  for (const batch of chunks(propRows, 6000)) await db.prop.createMany({ data: batch, skipDuplicates: true })
  for (const batch of chunks(commentRows, 6000)) await db.comment.createMany({ data: batch, skipDuplicates: true })
  for (const batch of chunks([...propTotals.entries()], 800)) {
    await db.$executeRaw`UPDATE "ShipPost" p SET "propsScore" = v.score, "propsCount" = v.cnt, "commentCount" = v.cm FROM (SELECT unnest(${batch.map(([id]) => id)}::text[]) AS id, unnest(${batch.map(([, v]) => v.score)}::float8[]) AS score, unnest(${batch.map(([, v]) => v.count)}::int[]) AS cnt, unnest(${batch.map(([, v]) => v.comments)}::int[]) AS cm) v WHERE p."id" = v.id`
  }
  ctx.log(`  ${postRows.length} posts, ${propRows.length} Props, ${commentRows.length} comments`)

  // --- Follows, evidence, drops, sparks, notifications -----------------------------------------------------------------------------
  const followRows: Prisma.FollowCreateManyInput[] = []
  const popular = rng.fork('bg-popular').sample(ids, Math.max(20, Math.floor(ids.length / 25)))
  for (const person of people) {
    const r = rng.fork(`bg-follow-${person.id}`)
    const n = person.activity > 0.2 ? r.int(8, 40) : r.int(0, 6)
    const chosen = new Set<string>()
    for (let k = 0; k < n; k++) {
      const target = r.chance(0.35) ? r.pick(popular) : ids[r.int(0, ids.length - 1)]
      if (target !== person.id) chosen.add(target)
    }
    for (const followeeId of chosen) followRows.push({ followerId: person.id, followeeId, createdAt: new Date(person.createdAt.getTime() + r.int(1, 30) * DAY_MS) })
  }
  for (const batch of chunks(followRows, 8000)) await db.follow.createMany({ data: batch, skipDuplicates: true })

  const evidenceRows: Prisma.SkillEvidenceCreateManyInput[] = []
  for (const person of active) {
    const r = rng.fork(`bg-ev-${person.id}`)
    for (const skill of person.skills.slice(0, r.int(1, 3))) {
      const skillId = ctx.skillIds.get(skill.slug)
      if (!skillId) continue
      evidenceRows.push({ userId: person.id, skillId, type: r.pick(['GITHUB_PROJECT', 'PORTFOLIO', 'CONTRIBUTION']), title: `${skill.slug} work`, description: 'Evidence of work.', url: `https://example.com/${person.username}`, verifiedAt: r.chance(0.5) ? person.createdAt : null, createdAt: new Date(person.createdAt.getTime() + DAY_MS) })
    }
  }
  for (const batch of chunks(evidenceRows, 6000)) await db.skillEvidence.createMany({ data: batch })

  // Drops for the last days, picked among people with a matching type in common (not scored: the scoring path is what the benchmark runs live).
  const dropRows: Prisma.DropCreateManyInput[] = []
  const sparkRows: Prisma.SparkCreateManyInput[] = []
  const today = ctx.now
  for (const person of active) {
    const r = rng.fork(`bg-drop-${person.id}`)
    for (let back = 0; back < 7; back++) {
      const localDate = localDateKey(new Date(today.getTime() - back * DAY_MS), person.city.timezone)
      const picked = new Set<string>()
      for (let k = 0; k < 3; k++) {
        const candidate = all[r.int(0, all.length - 1)]
        if (candidate.id === person.id || picked.has(candidate.id)) continue
        picked.add(candidate.id)
        const status = back === 0 ? 'NEW' : r.weighted([['EXPIRED', 55], ['PASSED', 25], ['SPARKED', 20]] as const)
        const type = r.pick(person.connectionTypes) as 'COFOUNDER'
        dropRows.push({ userId: person.id, candidateId: candidate.id, connectionType: type, score: r.int(52, 96), reasons: ['You both build with TypeScript'], localDate, status, expiresAt: new Date(today.getTime() - (back - 1) * DAY_MS), viewedAt: back === 0 ? null : new Date(today.getTime() - back * DAY_MS), createdAt: new Date(today.getTime() - back * DAY_MS) })
        if (status === 'SPARKED') sparkRows.push({ fromId: person.id, toId: candidate.id, connectionType: type, opener: `A background opener about ${candidate.username} and shared work`, openerHash: `bg${person.index}x${candidate.index}${back}`, status: 'PENDING', createdAt: new Date(today.getTime() - back * DAY_MS) })
      }
    }
  }
  for (const batch of chunks(dropRows, 6000)) await db.drop.createMany({ data: batch, skipDuplicates: true })
  for (const batch of chunks(sparkRows, 6000)) await db.spark.createMany({ data: batch, skipDuplicates: true })

  const noteRows: Prisma.NotificationCreateManyInput[] = []
  for (const person of active) {
    const r = rng.fork(`bg-note-${person.id}`)
    const n = Math.min(60, Math.round(person.activity * 40))
    for (let k = 0; k < n; k++) {
      const at = new Date(now.getTime() - r.int(1, args.days * 24) * HOUR_MS)
      const kind = r.weighted([['PROPS', 40], ['COMMENT', 20], ['FOLLOW', 15], ['SPARK', 10], ['MATCH_CREATED', 5], ['LEVEL_UP', 10]] as const)
      noteRows.push({ userId: person.id, type: kind === 'PROPS' ? 'PROPS' : kind === 'COMMENT' ? 'COMMENT' : kind === 'FOLLOW' ? 'FOLLOW' : kind === 'SPARK' ? 'SPARK' : kind === 'MATCH_CREATED' ? 'MATCH' : 'ACHIEVEMENT', title: kind === 'LEVEL_UP' ? 'Level up!' : kind.toLowerCase().replace(/_/g, ' '), message: 'A background notification.', metadata: { kind }, isRead: at.getTime() < now.getTime() - 3 * DAY_MS || r.chance(0.4), sweptAt: at, createdAt: at })
    }
  }
  for (const batch of chunks(noteRows, 8000)) await db.notification.createMany({ data: batch })
  ctx.log(`  ${followRows.length} follows, ${evidenceRows.length} evidence, ${dropRows.length} drops, ${sparkRows.length} sparks, ${noteRows.length} notifications`)

  // Registered for the hackathons that are open, so the pool and the boards have the volume.
  const hackathons = await db.hackathon.findMany({ where: { slug: { startsWith: 'seed-' }, status: { in: ['UPCOMING', 'ACTIVE'] } }, select: { id: true, registrationDeadline: true } })
  const participantRows: Prisma.HackathonParticipantCreateManyInput[] = []
  for (const hackathon of hackathons) {
    const r = rng.fork(`bg-reg-${hackathon.id}`)
    for (const person of active) {
      if (!r.chance(0.12)) continue
      participantRows.push({ userId: person.id, hackathonId: hackathon.id, registeredAt: new Date(now.getTime() - r.int(1, 10) * DAY_MS), skills: person.skills.slice(0, 3).map((s) => s.slug), lookingFor: person.archetype.seeks.slice(0, 2), lookingForTeam: r.chance(0.5), openToAutoTeam: r.chance(0.3) })
    }
  }
  for (const batch of chunks(participantRows, 6000)) await db.hackathonParticipant.createMany({ data: batch, skipDuplicates: true })
  ctx.log(`  ${participantRows.length} hackathon registrations`)
}

