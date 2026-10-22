import { NextRequest } from 'next/server'
import { z } from 'zod'
import { withAuth, validateQuery, createApiResponse } from '@/lib/api/handler'
import { foldText } from '@/lib/search/query'
import { normalizeCountryCode } from '@/lib/places'

// The campuses a person can verify, for a picker: GET /api/campuses?q=&countryCode=. The domains are listed so the page can say which address to use.
const querySchema = z.object({
  q: z.string().max(100).optional(),
  countryCode: z.string().max(2).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
})

export const GET = withAuth(async (request: NextRequest, { prisma }) => {
  const query = validateQuery(querySchema)(request)
  if (query instanceof Response) return query
  // Every word of the search must be somewhere in the name, the slug or the city: "findable open" finds "Findable Open University".
  const words = (foldText(query.data.q ?? '').match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, 6)
  const country = normalizeCountryCode(query.data.countryCode)
  const campuses = await prisma.campus.findMany({
    where: {
      disabledAt: null,
      ...(country ? { countryCode: country } : {}),
      ...(words.length > 0 ? { AND: words.map((word) => ({ OR: [{ name: { contains: word, mode: 'insensitive' as const } }, { slug: { contains: word } }, { city: { contains: word, mode: 'insensitive' as const } }] })) } : {}),
    },
    orderBy: { name: 'asc' },
    take: query.data.limit,
    select: { id: true, slug: true, name: true, city: true, countryCode: true, emailDomains: true },
  })
  return createApiResponse({ campuses })
}, { rateLimit: { windowMs: 60000, maxRequests: 60, keyPrefix: 'campus:list' } })
