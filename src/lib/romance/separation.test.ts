import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

// Nothing about the romance mode appears on a professional surface. That is a rule about the whole code base, so it is checked against the whole code base: only the files below may
// so much as name the mode (its tables, its routes, the DATING key, its label), each with the reason. A file that needs to is added here on purpose.

const SRC = path.resolve(__dirname, '..', '..')
const walk = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : walk(full)
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name) ? [full] : []
  })
const rel = (file: string) => path.relative(SRC, file).split(path.sep).join('/')
const read = (file: string) => fs.readFileSync(file, 'utf-8')
const NAMES_THE_MODE = /romance|Romance|ROMANCE|DATING|Kindred/

// The romance mode's own code needs no entry: everything under these directories is it.
const OWN_DIRS = ['lib/romance/', 'app/api/romance/']

const MAY_NAME_THE_MODE: Record<string, string> = {
  'app/api/admin/users/[id]/birthdate/route.ts': 'a correction to 16 or 17 removes the person from the mode (it is 18+)',
  'app/api/matching/profile/route.ts': 'says in a comment that the mode is not a type of the matching profile',
  'app/api/sparks/route.ts': 'says in a comment that the mode has its own spark route',
  'lib/achievement-definitions.ts': 'says in a comment that a romance match counts toward no achievement',
  'lib/age-policy.ts': 'the age rules: the mode is 18+',
  'lib/api/errors.ts': 'the error catalog: messages that name the mode from the one constant, and the codes of the mode',
  'lib/birth-date-admin.ts': 'the admin correction hook that removes a new minor from the mode',
  'lib/entitlements.ts': 'the weekly romance spark limit',
  'lib/env.ts': 'a comment: romance photos use the storage settings',
  'lib/infra/analytics.ts': 'the mode’s own event names (never its product name)',
  'lib/infra/jobs.ts': 'the mode’s two weekly-drop jobs',
  'lib/infra/storage.ts': 'a comment: private objects such as romance photos are read through signed URLs',
  'lib/matching/candidates.ts': 'a comment: the professional pool never reads the romance one',
  'lib/matching/dating.ts': 'the one 18+ gate (storage key DATING) the mode uses',
  'lib/matching/drops.ts': 'ignores a stored DATING type: the mode has its own weekly drop',
  'lib/matching/icebreaker.ts': 'a comment: the mode writes its own icebreaker',
  'lib/matching/matches.ts': 'leaves DATING matches out of the professional lists and ends a romance match’s reveal and Duo with it',
  'lib/matching/profile.ts': 'the gate helpers the mode reuses; refuses DATING as a matching type',
  'lib/matching/recommend.ts': 'never scores for the romance type on professional surfaces',
  'lib/matching/score.ts': 'scoreRomance(), the mode’s own scoring profile',
  'lib/matching/second-look.ts': 'ignores a stored DATING type',
  'lib/matching/spark-digest.ts': 'the romance daily count, kept apart from the professional one',
  'lib/matching/sparks.ts': 'refuses a professional spark of type DATING; the shared match writer takes the mode’s style',
  'lib/matching/team-match.ts': 'leaves romance matches out of "a match that became a team"',
  'lib/matching/types.ts': 'the DATING storage key and the list of professional types',
  'lib/media-assets.ts': 'the ROMANCE_PHOTO purpose',
  'lib/media.ts': 'the ROMANCE_PHOTO rules',
  'lib/notification-kinds.ts': 'the mode’s own notification kinds',
  'lib/user-sync.ts': 'deleting an account removes the person from the mode',
  'app/api/admin/actions/route.ts': 'a comment: a restriction can close the romance mode for a person',
  'app/api/admin/queue/route.ts': 'a comment: romance reports come first in the queue',
  'app/api/conversations/[id]/route.ts': 'the stricter content rule for the first messages of a romance match',
  'app/api/users/me/consents/[type]/route.ts': 'withdrawing ROMANCE_MODE consent turns the mode off and deletes its data',
  'lib/api/request-features.ts': 'the romance routes as one feature, for the kill switch and moderation restrictions',
  'lib/moderation/actions.ts': 'the ROMANCE restriction a moderator can apply',
  'lib/moderation/priority.ts': 'romance reports come first in the queue',
  'lib/moderation/reports.ts': 'a comment: the queue order',
  'lib/moderation/restrictions.ts': 'the ROMANCE restriction kind',
  'lib/moderation/targets.ts': 'romance profiles, sparks and messages can be reported, hidden and removed',
  'lib/ops/kill-switches.ts': 'the romance mode’s kill switch',
  'lib/privacy/consent.ts': 'the ROMANCE_MODE consent type',
  'lib/infra/media-moderation.ts': 'the scanner every romance photo passes before it is shown',
  'lib/privacy/delete.ts': 'deleting an account purges the romance mode, as leaving it does',
  'lib/privacy/inventory.ts': 'the data inventory lists the romance tables and what deleting an account does to them',
  'lib/integrity/collusion-job.ts': 'a comment: a lowered endorsement counts less toward the mode’s inbox gate',
  'lib/integrity/reach-sql.ts': 'the ROMANCE restriction kind, so a person restricted from the mode leaves its pool',
  'lib/safety/content.ts': 'the stricter content rule for the first messages of a romance match',
  'types/api.ts': 'documents the storage key in the match types',
}

// Surfaces other people can see about a person, or that are public: none may name the mode, ever.
const PROFESSIONAL_SURFACES = [
  'lib/player-card.ts',
  'lib/leaderboard.ts',
  'lib/leaderboard-read.ts',
  'lib/leaderboard-write.ts',
  'lib/leaderboard-boards.ts',
  'lib/dashboard.ts',
  'lib/activity.ts',
  'lib/achievements.ts',
  'lib/achievement-catalog.ts',
  'lib/achievement-progress.ts',
  'lib/cosmetics.ts',
  'lib/heatmap.ts',
  'lib/xp-views.ts',
  'lib/skill-evidence.ts',
  'lib/quests.ts',
  'lib/streaks.ts',
  'lib/metrics.ts',
  'lib/subscribers.ts',
  'app/api/leaderboard/route.ts',
  'app/api/users/[id]/route.ts',
  'app/api/users/[id]/stats/route.ts',
  'app/api/users/[id]/achievements/route.ts',
  'app/api/users/[id]/heatmap/route.ts',
  'app/api/users/route.ts',
  'app/api/discover/route.ts',
  'app/api/dashboard/route.ts',
  'app/api/activity/route.ts',
  'app/api/achievements/route.ts',
  'app/api/quests/route.ts',
  'app/api/teams/route.ts',
  'app/api/projects/route.ts',
]

describe('the romance mode stays apart', () => {
  const files = walk(SRC).filter((file) => !rel(file).startsWith('components/') && !rel(file).startsWith('app/(dashboard)/') && !rel(file).startsWith('app/(auth)/'))
  const outside = files.filter((file) => !OWN_DIRS.some((dir) => rel(file).startsWith(dir)))

  it('finds the source files to scan', () => {
    expect(files.length).toBeGreaterThan(200)
  })

  it('is named only by the files that need it', () => {
    const naming = outside.filter((file) => NAMES_THE_MODE.test(read(file))).map(rel).sort()
    expect(naming).toEqual(Object.keys(MAY_NAME_THE_MODE).filter((name) => naming.includes(name)).sort())
    for (const name of naming) expect(Object.keys(MAY_NAME_THE_MODE), `${name} may not name the romance mode`).toContain(name)
  })

  it('is named by no professional surface: the passport, the feed, the leaderboards, profiles, achievements, quests, search', () => {
    for (const name of PROFESSIONAL_SURFACES) {
      const file = path.join(SRC, name)
      if (!fs.existsSync(file)) continue
      expect(NAMES_THE_MODE.test(read(file)), `${name} names the romance mode`).toBe(false)
    }
    // The feed and the posts, when they exist, are professional surfaces too.
    for (const dir of ['lib/feed', 'lib/posts', 'app/api/feed', 'app/api/posts', 'app/api/ship-day']) {
      const full = path.join(SRC, dir)
      if (!fs.existsSync(full)) continue
      for (const file of walk(full)) expect(NAMES_THE_MODE.test(read(file)), `${rel(file)} names the romance mode`).toBe(false)
    }
  })

  it('reads the romance tables only in the mode’s own code and the few files that remove a person from it', () => {
    const readers = outside.filter((file) => /\.(romanceProfile|romanceDrop|romancePhoto|revealRequest|duo|buildDate)\b/.test(read(file))).map(rel).sort()
    // The shared match writer clears a romance drop when a pair matches; the digest counts the mode's sparks on the mode's marker.
    // Moderation finds, hides and removes reported romance profiles (lib/moderation/targets.ts).
    // Deleting an account dissolves the person's Duos (lib/privacy/delete.ts).
    expect(readers).toEqual(['lib/matching/spark-digest.ts', 'lib/matching/sparks.ts', 'lib/moderation/targets.ts', 'lib/privacy/delete.ts'])
  })

  it('says the mode’s product name in exactly one place', () => {
    const label = outside.filter((file) => /Kindred/.test(read(file))).map(rel)
    expect(label).toEqual([])
    const config = read(path.join(SRC, 'lib/romance/config.ts'))
    expect(config.match(/Kindred/g)).toHaveLength(1)
    const others = files.filter((file) => rel(file) !== 'lib/romance/config.ts' && /Kindred/.test(read(file))).map(rel)
    expect(others).toEqual([])
  })

  it('has no Build Date route yet: only the model exists (Phase 2)', () => {
    const routes = walk(path.join(SRC, 'app/api')).filter((file) => /buildDate|build-date|BuildDate/.test(read(file)) || /build-date/i.test(rel(file)))
    expect(routes.map(rel)).toEqual([])
  })

  it('keeps the romance routes under /api/romance, and no professional route imports them', () => {
    const importers = files.filter((file) => /from '@\/lib\/romance\//.test(read(file)) && !OWN_DIRS.some((dir) => rel(file).startsWith(dir))).map(rel).sort()
    expect(importers).toEqual(['app/api/admin/users/[id]/birthdate/route.ts', 'app/api/users/me/consents/[type]/route.ts', 'lib/api/errors.ts', 'lib/matching/matches.ts', 'lib/matching/score.ts', 'lib/matching/spark-digest.ts', 'lib/moderation/targets.ts', 'lib/notification-kinds.ts', 'lib/privacy/delete.ts', 'lib/user-sync.ts'])
  })
})
