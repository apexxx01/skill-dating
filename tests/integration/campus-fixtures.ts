import { randomUUID } from 'crypto'
import type { Campus } from '@prisma/client'
import { testPrisma } from './db'

// Campuses for the tests, written straight into the database. A person joins one the way verifying a campus e-mail address leaves them (src/lib/campus/campus.ts
// confirmVerification): a CampusMembership, and the campus's name and slug on their profile. The verification itself is tested through its routes (campus.test.ts).

const slugOf = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')

export async function ensureCampus(name: string, over: Partial<{ emailDomains: string[]; countryCode: string | null; city: string | null; disabledAt: Date | null }> = {}): Promise<Campus> {
  const slug = slugOf(name)
  return testPrisma.campus.upsert({
    where: { slug },
    create: { slug, name, emailDomains: over.emailDomains ?? ['campus.test'], countryCode: over.countryCode ?? null, city: over.city ?? null, disabledAt: over.disabledAt ?? null },
    update: {},
  })
}

/** Makes the person a verified member of the campus (made if it does not exist), replacing any campus they had. */
export async function joinCampus(userId: string, name: string, over: Parameters<typeof ensureCampus>[1] = {}): Promise<Campus> {
  const campus = await ensureCampus(name, over)
  await testPrisma.campusMembership.upsert({
    where: { userId },
    create: { userId, campusId: campus.id, emailHash: randomUUID().replace(/-/g, '') },
    update: { campusId: campus.id },
  })
  await testPrisma.profile.upsert({ where: { userId }, create: { userId, campus: campus.name, campusKey: campus.slug }, update: { campus: campus.name, campusKey: campus.slug } })
  return campus
}

export async function removeCampuses(slugs: string[]) {
  await testPrisma.campus.deleteMany({ where: { slug: { in: slugs } } })
}
