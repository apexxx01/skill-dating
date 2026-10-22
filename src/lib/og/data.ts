import type { PrismaClient } from '@prisma/client'
import { isMinor } from '@/lib/age-policy'
import { levelFor } from '@/lib/levels'
import { effectiveLevel } from '@/lib/integrity/risk'
import { accountState } from '@/lib/moderation/restrictions'
import { clip, drawable, plainText } from './text'
import type { AchievementCard, CardModel, PassportCard, PostCard, SquadCard } from './models'

// The data behind each share card, and the rules about who may be on one. A card is a public image: anybody with the link can fetch it, signed in or not, and it
// ends up in link previews, search engines and other people's feeds. So it shows less than the app does, and only what the person has not kept to themselves:
//
//   hidden entirely (404)   an account that is deleted, closed for its age, suspended or banned, at a HIGH risk level, or in invisible mode; a post that is not PUBLIC,
//                           or is hidden, removed or deleted; a squad whose hackathon is not public or has not ended;
//   a minor, or an account with no date of birth yet   only the @username, level and counts: no name, headline, role, skills, or place;
//   a passport field that is not PUBLIC  not shown (the headline and the builder role are the fields a card prints);
//   never shown   e-mail, bio, links, location, the date of birth, and anything from a person's private modes: no such table is read here.
// A person who is not in the cards can always be linked to by name inside the app; the cards are for sharing, and are generous with nothing.

type Db = Pick<PrismaClient, 'user' | 'profile' | 'shipPost' | 'team' | 'achievement' | 'userAchievement' | 'project' | 'userRisk' | 'userRestriction' | 'userSkill' | 'hackathonTeam' | 'teamMember' | 'xPEvent'>

interface Holder {
  id: string
  username: string
  name: string | null
  minimal: boolean
  fieldVisibility: Record<string, unknown>
}

/** The person as a card may show them, or null when they may not be on one. */
async function holderOf(db: Db, where: { username: string } | { id: string }, now: Date): Promise<Holder | null> {
  const user = await db.user.findFirst({
    where: { ...('username' in where ? { username: { equals: where.username, mode: 'insensitive' as const } } : { id: where.id }), deletedAt: null, birthDateRefusedAt: null },
    select: { id: true, username: true, name: true, birthDate: true, profile: { select: { invisibleMode: true, fieldVisibility: true } } },
  })
  if (!user || user.profile?.invisibleMode) return null
  const state = await accountState(db as never, user.id, undefined, now)
  // The risk level is read from its row, not from the cached list of high risk accounts: a card is cached on its own, and what hides it should not lag a second time.
  const risk = await db.userRisk.findUnique({ where: { userId: user.id }, select: { level: true, overrideLevel: true } })
  if (state.banned || state.suspendedUntil || effectiveLevel(risk) === 'HIGH') return null
  const fieldVisibility = user.profile?.fieldVisibility && typeof user.profile.fieldVisibility === 'object' && !Array.isArray(user.profile.fieldVisibility) ? (user.profile.fieldVisibility as Record<string, unknown>) : {}
  // No date of birth on file is treated as a minor: nothing is known that says otherwise.
  const minimal = user.birthDate === null || isMinor(user.birthDate, now)
  return { id: user.id, username: user.username, name: minimal ? null : drawable(user.name), minimal, fieldVisibility }
}

const isPublicField = (holder: Holder, field: string) => !holder.minimal && (holder.fieldVisibility[field] ?? 'PUBLIC') === 'PUBLIC'

export async function passportCard(db: Db, username: string, now: Date = new Date()): Promise<PassportCard | null> {
  const holder = await holderOf(db, { username }, now)
  if (!holder) return null
  const [user, shipped, achievements, skills] = await Promise.all([
    db.user.findUniqueOrThrow({ where: { id: holder.id }, select: { xp: true, headline: true, builderRole: true } }),
    db.project.count({ where: { status: 'SHIPPED', isPublic: true, OR: [{ ownerId: holder.id }, { members: { some: { userId: holder.id } } }] } }),
    db.userAchievement.count({ where: { userId: holder.id } }),
    holder.minimal ? Promise.resolve([]) : db.userSkill.findMany({ where: { userId: holder.id }, orderBy: { level: 'desc' }, take: 3, select: { skill: { select: { name: true } } } }),
  ])
  const level = levelFor(user.xp)
  return {
    kind: 'passport',
    username: holder.username,
    name: holder.name,
    headline: isPublicField(holder, 'headline') ? drawable(user.headline) : null,
    role: isPublicField(holder, 'builderRole') ? drawable(user.builderRole) : null,
    skills: skills.map((row) => drawable(row.skill.name)).filter((name): name is string => name !== null),
    level: level.level,
    tier: level.tier,
    projectsShipped: shipped,
    achievements,
  }
}

export async function postCard(db: Db, postId: string, now: Date = new Date()): Promise<PostCard | null> {
  const post = await db.shipPost.findFirst({
    where: { id: postId, visibility: 'PUBLIC', deletedAt: null, moderatedAt: null },
    select: { title: true, body: true, kind: true, propsCount: true, commentCount: true, authorId: true },
  })
  if (!post) return null
  const author = await holderOf(db, { id: post.authorId }, now)
  if (!author) return null
  return {
    kind: 'post',
    title: clip(drawable(post.title, 'A post') ?? 'A post', 110),
    excerpt: clip(drawable(plainText(post.body), '') ?? '', 220),
    postKind: post.kind,
    author: author.name ? `${author.name} (@${author.username})` : `@${author.username}`,
    propsCount: post.propsCount,
    commentCount: post.commentCount,
  }
}

export async function squadCard(db: Db, teamId: string, now: Date = new Date()): Promise<SquadCard | null> {
  const squad = await db.hackathonTeam.findUnique({
    where: { teamId },
    select: {
      name: true,
      rank: true,
      hackathon: { select: { name: true, status: true, isPublic: true, moderatedAt: true } },
      team: { select: { project: { select: { name: true, isPublic: true } }, members: { select: { userId: true } } } },
    },
  })
  // A recap is for after the hackathon, and only for one anybody could see.
  if (!squad || squad.hackathon.status !== 'ENDED' || !squad.hackathon.isPublic || squad.hackathon.moderatedAt) return null
  const holders = await Promise.all(squad.team.members.map((member) => holderOf(db, { id: member.userId }, now)))
  const named = holders.filter((holder): holder is Holder => holder !== null && !holder.minimal)
  return {
    kind: 'squad',
    squad: clip(drawable(squad.name, 'A squad') ?? 'A squad', 60),
    hackathon: clip(drawable(squad.hackathon.name, 'A hackathon') ?? 'A hackathon', 80),
    rank: squad.rank,
    project: squad.team.project?.isPublic ? drawable(squad.team.project.name) : null,
    memberCount: squad.team.members.length,
    members: named.slice(0, 5).map((holder) => `@${holder.username}`),
    unnamed: squad.team.members.length - Math.min(named.length, 5),
  }
}

export async function achievementCard(db: Db, slug: string, username: string, now: Date = new Date()): Promise<AchievementCard | null> {
  const holder = await holderOf(db, { username }, now)
  if (!holder) return null
  const earned = await db.userAchievement.findFirst({
    where: { userId: holder.id, achievement: { slug } },
    select: { earnedAt: true, achievement: { select: { name: true, description: true, xpReward: true, rarity: true } } },
  })
  if (!earned) return null
  return {
    kind: 'achievement',
    name: drawable(earned.achievement.name, 'Achievement') ?? 'Achievement',
    description: clip(drawable(earned.achievement.description, '') ?? '', 160),
    xp: earned.achievement.xpReward,
    rarityPercent: earned.achievement.rarity === null ? null : Math.round(earned.achievement.rarity * 1000) / 10,
    earnedOn: earned.earnedAt.toISOString().slice(0, 10),
    holder: holder.name ? `${holder.name} (@${holder.username})` : `@${holder.username}`,
  }
}

export type { CardModel }
