import type { Ctx, Person } from './types'
import { DAY_MS, HOUR_MS } from './types'
import { atMoment, STAMPED } from './clock'
import { REPORT_SCENARIOS } from './catalog'
import { emit, transactWithEvents } from '../../src/lib/events'
import { ensurePersonalCode, qualifyInvites, redeemInvite } from '../../src/lib/invites/invites'
import { fileAutomatedReport, fileReport } from '../../src/lib/moderation/reports'
import { writeShipDayRecap } from '../../src/lib/posts/ship-day'
import { sendSquadReminders } from '../../src/lib/squads/reminders'
import { sendPeerReviewPrompts } from '../../src/lib/squads/peer-review'
import { recordActivity } from '../../src/lib/activity'

// The rest of the world: invites and campaign codes, a few reports in the moderation queue, crews with applications, what people are building right now, the Ship Day recaps, and the
// projects that went quiet. Domain functions where there are some (invites, reports, the recap); direct rows, as the routes write them, for crews and current builds (docs/SEED.md).

export async function seedInvites(ctx: Ctx): Promise<{ redeemed: number; qualified: number; rewarded: number }> {
  const { db, rng, now } = ctx
  const core = ctx.people.filter((person) => person.tier === 'core')
  const newcomers = core.filter((person) => now.getTime() - person.createdAt.getTime() < 40 * DAY_MS && now.getTime() - person.createdAt.getTime() > 9 * DAY_MS)
  const inviters = rng.sample(core.filter((person) => person.activity > 0.3 && now.getTime() - person.createdAt.getTime() > 45 * DAY_MS), 40)

  // Three campaign codes, as an admin would make them for a launch and two colleges.
  const campaigns = [
    { code: 'LAUNCH2026', label: 'Launch waitlist', campus: null as string | null },
    { code: 'IISC2026', label: 'IISc Bangalore chapter', campus: 'iisc-bangalore' },
    { code: 'BERKELEY26', label: 'Berkeley builders', campus: 'uc-berkeley' },
  ]
  for (const campaign of campaigns) {
    await db.inviteCode.upsert({
      where: { code: campaign.code },
      create: { code: campaign.code, kind: 'CAMPAIGN', label: campaign.label, campusId: campaign.campus ? ctx.campusIds.get(campaign.campus) : null, maxUses: 500, expiresAt: new Date(now.getTime() + 120 * DAY_MS) },
      update: {},
    })
  }

  let redeemed = 0
  const pool = rng.shuffle(newcomers)
  for (const inviter of inviters) {
    await ensurePersonalCode(db, inviter.id)
  }
  for (const [index, invitee] of pool.entries()) {
    const at = new Date(Math.min(now.getTime() - HOUR_MS, invitee.createdAt.getTime() + rng.int(1, 6) * DAY_MS))
    const campaign = index % 5 === 0 ? campaigns[index % campaigns.length] : null
    const inviter = campaign ? null : inviters[index % inviters.length]
    if (!campaign && !inviter) continue
    const code = campaign ? campaign.code : (await ensurePersonalCode(db, inviter!.id)).code
    const outcome = await atMoment(db, at, () => redeemInvite(db, invitee.id, code, at))
    if (outcome.ok) redeemed += 1
  }
  // The hourly job: those who finished onboarding and did a real thing, a week in and trusted, qualify and pay their inviters through the rewards engine.
  const result = await qualifyInvites(db, now)
  return { redeemed, qualified: result.qualified, rewarded: result.rewarded }
}

export async function seedReports(ctx: Ctx): Promise<number> {
  const { db, rng, now } = ctx
  const posts = await db.shipPost.findMany({ where: { author: { id: { startsWith: 'sd_' } } }, select: { id: true, authorId: true }, orderBy: { createdAt: 'desc' }, take: 80 })
  const trusted = ctx.people.filter((person) => person.tier === 'core' && now.getTime() - person.createdAt.getTime() > 20 * DAY_MS && person.activity > 0.3)
  let filed = 0
  const reports: string[] = []
  for (const [index, scenario] of REPORT_SCENARIOS.entries()) {
    const post = posts[index * 7 % Math.max(1, posts.length)]
    const reporter = rng.pick(trusted.filter((person) => person.id !== post?.authorId))
    if (!post || !reporter) continue
    const at = new Date(now.getTime() - (index + 1) * 9 * HOUR_MS)
    const result = await atMoment(db, at, () => fileReport(db, reporter.id, { targetType: index % 2 === 0 ? 'SHIP_POST' : 'USER', targetId: index % 2 === 0 ? post.id : post.authorId, reason: scenario.reason, description: scenario.description }, at))
    if (result.ok) {
      filed += 1
      reports.push(result.report.id)
      // A second person reports the same thing: it moves up the queue.
      if (index < 2) {
        const second = rng.pick(trusted.filter((person) => person.id !== post.authorId && person.id !== reporter.id))
        await atMoment(db, new Date(at.getTime() + 3 * HOUR_MS), () => fileReport(db, second.id, { targetType: index % 2 === 0 ? 'SHIP_POST' : 'USER', targetId: index % 2 === 0 ? post.id : post.authorId, reason: scenario.reason }, new Date(at.getTime() + 3 * HOUR_MS)))
      }
    }
  }
  const automated = posts[3]
  if (automated) {
    await atMoment(db, new Date(now.getTime() - 5 * HOUR_MS), async () => {
      await fileAutomatedReport(db, { targetType: 'SHIP_POST', targetId: automated.id, reason: 'SPAM', description: 'Flagged by the content checks: a promotional link and repeated text.', details: { reasons: ['LINK', 'REPEATED_TEXT'] } })
    })
    filed += 1
  }
  // Some are already being looked at, and two are done.
  if (reports[1]) await db.report.update({ where: { id: reports[1] }, data: { status: 'REVIEWING' } })
  if (reports[2]) await db.report.update({ where: { id: reports[2] }, data: { status: 'RESOLVED', resolvedAt: new Date(now.getTime() - 2 * HOUR_MS) } })
  if (reports[4]) await db.report.update({ where: { id: reports[4] }, data: { status: 'DISMISSED', resolvedAt: new Date(now.getTime() - 20 * HOUR_MS) } })
  return filed
}

const CREW_NAMES = ['Night Shift', 'Pointer Sisters', 'The Daily Build', 'Rubber Duck Club', 'Commit Crew', 'Cold Start', 'Open Loop', 'Merge Conflict']

export async function seedCrews(ctx: Ctx): Promise<number> {
  const { db, rng, now } = ctx
  const owners = rng.sample(ctx.people.filter((person) => person.tier === 'core' && person.activity > 0.25 && (ctx.state.get(person.id)?.projects.length ?? 0) > 0), 28)
  let made = 0
  for (const [index, owner] of owners.entries()) {
    const project = ctx.state.get(owner.id)!.projects[0]
    const name = `${rng.pick(CREW_NAMES)} ${index + 1}`
    const created = new Date(now.getTime() - rng.int(5, 55) * DAY_MS)
    if (created.getTime() < owner.createdAt.getTime() + DAY_MS) continue
    const mates = rng.sample(ctx.people.filter((person) => person.tier === 'core' && person.id !== owner.id && person.createdAt.getTime() < created.getTime() && person.activity > 0.1), rng.int(1, 3))
    const team = await atMoment(db, created, async () => {
      const { value } = await transactWithEvents(db, async (tx) => {
        const team = await tx.team.create({
          data: { name, slug: `seed-crew-${index}-${owner.index.toString(36)}`, description: `A small crew building ${project.name} in the open.`, projectId: project.id, ownerId: owner.id, maxSize: 5, isRecruiting: rng.chance(0.7), lookingFor: owner.archetype.seeks.slice(0, 2), createdAt: created },
        })
        await tx.teamMember.create({ data: { userId: owner.id, teamId: team.id, role: 'OWNER', joinedAt: created } })
        await tx.conversation.create({ data: { type: 'TEAM', teamId: team.id, members: { create: { userId: owner.id, role: 'OWNER' } } } })
        for (const mate of mates) {
          const application = await tx.teamApplication.create({ data: { userId: mate.id, teamId: team.id, message: 'I like what you are building and can take the part you are missing.', status: 'ACCEPTED', createdAt: new Date(created.getTime() + HOUR_MS) } })
          await tx.teamMember.create({ data: { userId: mate.id, teamId: team.id, role: 'MEMBER', joinedAt: new Date(created.getTime() + 2 * HOUR_MS) } })
          await tx.projectMember.upsert({ where: { userId_projectId: { userId: mate.id, projectId: project.id } }, create: { userId: mate.id, projectId: project.id, role: 'MEMBER' }, update: {} })
          await emit(tx, 'TEAM_APPLICATION_ACCEPTED', { userId: mate.id, teamId: team.id, applicationId: application.id, counterpartyId: owner.id })
          await recordActivity(tx, mate.id, 'TEAM_JOINED', `Joined team "${name}"`, { link: `/teams/${team.slug}` })
        }
        return team
      })
      return value
    })
    // Open applications and a few that did not work out, for the owner's inbox.
    const applicants = rng.sample(ctx.people.filter((person) => person.tier === 'core' && person.id !== owner.id && !mates.some((mate) => mate.id === person.id) && person.createdAt.getTime() < now.getTime() - 3 * DAY_MS), 2)
    for (const [i, applicant] of applicants.entries()) {
      await db.teamApplication.create({ data: { userId: applicant.id, teamId: team.id, message: 'Can I help with the part you are missing?', status: i === 0 ? 'PENDING' : rng.pick(['REJECTED', 'WITHDRAWN', 'PENDING']), createdAt: new Date(now.getTime() - rng.int(1, 6) * DAY_MS) } })
    }
    await db.project.update({ where: { id: project.id }, data: { teamSize: 1 + mates.length } })
    made += 1
  }
  return made
}

export async function seedCurrentBuilds(ctx: Ctx): Promise<number> {
  const { db, rng } = ctx
  let count = 0
  for (const person of ctx.people.filter((p) => p.tier === 'core' && p.activity > 0.2)) {
    if (!rng.chance(0.4)) continue
    const project = ctx.state.get(person.id)?.projects.find((p) => !p.shipped)
    if (!project) continue
    const row = await db.project.findUnique({ where: { id: project.id }, select: { name: true, description: true, techStack: true, status: true, maxTeamSize: true } })
    if (!row) continue
    await db.currentBuild.upsert({
      where: { userId: person.id },
      create: { userId: person.id, title: row.name, description: row.description, status: row.status, progress: rng.int(10, 85), techStack: row.techStack, maxTeamSize: row.maxTeamSize, rolesNeeded: person.archetype.seeks.slice(0, 2) },
      update: {},
    })
    count += 1
  }
  return count
}

/** The recap of the last Ship Days, written as the Saturday job writes it. */
export async function seedShipDayRecaps(ctx: Ctx): Promise<number> {
  let written = 0
  for (let weeksAgo = 6; weeksAgo >= 0; weeksAgo--) {
    const saturday = new Date(ctx.now.getTime() - weeksAgo * 7 * DAY_MS)
    saturday.setUTCDate(saturday.getUTCDate() + ((6 - saturday.getUTCDay() + 7) % 7) - 7)
    saturday.setUTCHours(12, 30, 0, 0)
    if (saturday.getTime() > ctx.now.getTime() - HOUR_MS) continue
    const result = await atMoment(ctx.db, saturday, () => writeShipDayRecap(ctx.db, saturday), [...STAMPED, { table: 'ShipDayRecap', column: 'createdAt' }])
    if (result) written += 1
  }
  return written
}

/** Projects that went quiet are archived (the status the interface calls "paused"), so every status is in the world. */
export async function archiveQuietProjects(ctx: Ctx): Promise<number> {
  const rows = await ctx.db.$executeRaw`
    UPDATE "Project" p SET "status" = 'ARCHIVED'
    WHERE p."ownerId" LIKE 'sd\_%' AND p."status" IN ('IDEA', 'PLANNING') AND p."createdAt" < now() - interval '30 days'
      AND NOT EXISTS (SELECT 1 FROM "ProjectUpdate" u WHERE u."projectId" = p."id" AND u."createdAt" > now() - interval '21 days')
      AND p."hackathonId" IS NULL AND abs(hashtext(p."id")) % 3 = 0
  `
  return Number(rows)
}

/** The reminders the platform sends on its own, run as their jobs run them: squads and solo builders before a registration closes, and the asks to review teammates after a hackathon. */
export async function seedReminders(ctx: Ctx): Promise<{ reminders: number; reviewPrompts: number }> {
  const reminders = await sendSquadReminders(ctx.db, ctx.now)
  const reviewPrompts = await sendPeerReviewPrompts(ctx.db, ctx.now)
  return { reminders, reviewPrompts }
}
