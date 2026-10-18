import { randomUUID } from 'crypto'
import type { Prisma } from '@prisma/client'
import { testPrisma } from './db'

// Hackathons and registrations for the squad tests, written straight into the database (creating a hackathon through the API needs an admin, and
// most tests only need one to exist). Remove what a file made with `dropHackathons`.

const DAY_MS = 24 * 60 * 60 * 1000

export async function makeHackathon(over: Partial<Prisma.HackathonUncheckedCreateInput> = {}) {
  const id = randomUUID().slice(0, 8)
  const now = Date.now()
  return testPrisma.hackathon.create({
    data: {
      name: `Squad Hack ${id}`,
      slug: `squad-hack-${id}`,
      description: 'A hackathon for the squad tests',
      startDate: new Date(now + 10 * DAY_MS),
      endDate: new Date(now + 12 * DAY_MS),
      registrationDeadline: new Date(now + 9 * DAY_MS),
      minTeamSize: 1,
      maxTeamSize: 5,
      ...over,
    },
  })
}

export async function registerFor(hackathonId: string, userId: string, over: Partial<Prisma.HackathonParticipantUncheckedCreateInput> = {}) {
  return testPrisma.hackathonParticipant.create({ data: { hackathonId, userId, ...over } })
}

export async function dropHackathons(ids: string[]) {
  if (ids.length > 0) await testPrisma.hackathon.deleteMany({ where: { id: { in: ids } } })
}
