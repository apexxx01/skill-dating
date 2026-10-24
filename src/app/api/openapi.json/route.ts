import { NextRequest } from 'next/server'
import { withAuth, createApiResponse } from '@/lib/api/handler'
import { nodeEnv } from '@/lib/env'
import spec from '../../../../docs/openapi.json'

// The OpenAPI 3.1 description of this API (docs/openapi.json, generated from the code: `npm run openapi:build`; a test fails when it is out of date). It is served so a tool can read the
// deployment it talks to. In development any signed-in person may read it; everywhere else, administrators only. It is a map of the whole surface, including the staff routes, so it is not public.
export const GET = withAuth(async (_request: NextRequest) => createApiResponse(spec), {
  requiredRole: nodeEnv === 'development' ? undefined : ['ADMIN'],
  cache: { maxAge: 60 },
  rateLimit: { windowMs: 60000, maxRequests: 20, keyPrefix: 'openapi:get' },
})
