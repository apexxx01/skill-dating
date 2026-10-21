import { z } from 'zod'

// The one place the process environment is read. Every other module imports the
// typed `env` from here instead of touching process.env, so a missing or
// malformed setting is found when the server starts (see src/instrumentation.ts),
// not on the first request that happens to need it.
//
// Values are never echoed in error messages: a bad key is reported by name and
// reason only, so a failed boot does not copy a secret into the logs.

const csv = z
  .string()
  .optional()
  .transform((value) => (value ?? '').split(',').map((part) => part.trim()).filter(Boolean))

// "true" / "false" only: a typo in a switch must stop the boot, not silently read as off.
const flag = (defaultValue: 'true' | 'false') => z.enum(['true', 'false']).default(defaultValue).transform((value) => value === 'true')

const envSchema = z.object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    // Set by Vercel. A preview deployment runs with NODE_ENV=production too, so
    // this is what tells a preview from the real thing (see requiresProductionConfig).
    VERCEL_ENV: z.enum(['production', 'preview', 'development']).optional(),

    // PostgreSQL connection string.
    DATABASE_URL: z
      .string({ required_error: 'is required' })
      .url('must be a URL')
      .refine((value) => /^postgres(ql)?:\/\//.test(value), 'must be a postgresql:// URL'),

    // Clerk. Keys come from the dashboard; the webhook secret from the endpoint
    // created for /api/webhooks/clerk.
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: z
      .string({ required_error: 'is required' })
      .startsWith('pk_', 'must start with pk_'),
    CLERK_SECRET_KEY: z.string({ required_error: 'is required' }).startsWith('sk_', 'must start with sk_'),
    CLERK_WEBHOOK_SECRET: z.string().startsWith('whsec_', 'must start with whsec_').optional(),
    CLERK_AUTHORIZED_PARTIES: csv,

    // How many reverse proxies sit in front of the app (see README, "Rate limiting").
    TRUSTED_PROXY_HOPS: z.coerce.number().int('must be a whole number').min(0, 'must be 0 or more').default(0),

    // Cache and rate limits: Upstash Redis over REST.
    UPSTASH_REDIS_REST_URL: z.string().url('must be a URL').optional(),
    UPSTASH_REDIS_REST_TOKEN: z.string().min(1).optional(),

    // Background jobs: Inngest.
    INNGEST_EVENT_KEY: z.string().min(1).optional(),
    INNGEST_SIGNING_KEY: z.string().min(1).optional(),

    // Realtime: Ably. The key has the form appId.keyId:secret.
    ABLY_API_KEY: z
      .string()
      .regex(/^[^.\s]+\.[^:\s]+:\S+$/, 'must look like appId.keyId:secret')
      .optional(),

    // Object storage for uploads (post media, romance photos): any S3-compatible store (AWS S3, Cloudflare R2, MinIO), addressed path-style as
    // <endpoint>/<bucket>/<key>. Optional: without it development keeps uploads in memory and production refuses them (503 STORAGE_UNAVAILABLE).
    STORAGE_ENDPOINT: z.string().url('must be a URL').optional(),
    STORAGE_BUCKET: z.string().min(1).optional(),
    STORAGE_REGION: z.string().min(1).default('auto'),
    STORAGE_ACCESS_KEY_ID: z.string().min(1).optional(),
    STORAGE_SECRET_ACCESS_KEY: z.string().min(1).optional(),
    // Where objects are served publicly, if the bucket is (a CDN or the bucket's public domain). Without it every read is a short-lived signed URL.
    STORAGE_PUBLIC_BASE_URL: z.string().url('must be a URL').optional(),

    // Whether finishing onboarding needs a date of birth (the platform age policy, docs/SAFETY.md). On by default; the switch exists so a deploy that
    // reaches users before the onboarding screen asks for the date can be rolled out in two steps.
    BIRTH_DATE_REQUIRED: flag('true'),

    // Plan limits (src/lib/entitlements.ts). Off: every feature is open to everyone
    // and only the hard safety ceilings apply. On: the limits of the user's plan apply.
    ENTITLEMENTS_ENFORCED: flag('false'),

    // Product analytics. Events are always stored in ProductEvent; with a PostHog
    // project key they are also forwarded (src/lib/infra/analytics.ts).
    POSTHOG_KEY: z.string().min(1).optional(),
    POSTHOG_HOST: z.string().url('must be a URL').default('https://us.i.posthog.com'),

    // Error reporting (src/lib/log.ts). Without a DSN errors are only logged.
    SENTRY_DSN: z.string().url('must be a URL').optional(),

    // Minimum level written by the structured logger.
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).optional(),

    // Whether the Prisma client prints every query in development (default on). Scripts turn it off.
    PRISMA_QUERY_LOG: z.enum(['on', 'off']).optional(),

    // Comma-separated host:port pairs the page fetcher (src/lib/infra/page-fetch.ts) may reach even though they resolve to a private or loopback
    // address: only for a local test page. Refused in production, where every private address is always blocked.
    PAGE_FETCH_ALLOW_PRIVATE: z.string().regex(/^[a-z0-9.-]+:\d{2,5}(,[a-z0-9.-]+:\d{2,5})*$/i, 'must be host:port pairs separated by commas').optional(),

    // Set only by the integration harness (tests/integration/global-setup.ts) when it runs the suite against a production build (`next start`, which
    // always runs with NODE_ENV=production). It lets that build keep uploads in memory and honour PAGE_FETCH_ALLOW_PRIVATE, as `next dev` does. Refused
    // wherever the production services are required, so a real deployment can never turn it on.
    INTEGRATION_TEST_SERVER: flag('false'),
  })

// Rules that span several settings. They are checked from which settings are
// present, outside Zod, because Zod skips refinements once any field is invalid
// and a boot should report every problem, not make you fix them in rounds.
type Setting = keyof z.input<typeof envSchema>

const CREDENTIAL_PAIRS: [Setting, Setting][] = [
  ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'],
  ['INNGEST_EVENT_KEY', 'INNGEST_SIGNING_KEY'],
  // Object storage needs all four (chained, so any one set requires the rest).
  ['STORAGE_ENDPOINT', 'STORAGE_BUCKET'],
  ['STORAGE_ENDPOINT', 'STORAGE_ACCESS_KEY_ID'],
  ['STORAGE_ACCESS_KEY_ID', 'STORAGE_SECRET_ACCESS_KEY'],
]

// Services the in-memory stand-ins replace when they are not configured. Each
// stand-in is fine for one process and wrong for a fleet: instances would each
// keep their own rate limits and presence, and jobs and realtime delivery would
// not reach anyone. `fallback` says what is lost, for the startup warning.
const SERVICES: { settings: Setting[]; fallback: string }[] = [
  {
    settings: ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'],
    fallback: 'cache, rate limits and presence live in process memory: every instance counts on its own',
  },
  {
    settings: ['INNGEST_EVENT_KEY', 'INNGEST_SIGNING_KEY'],
    fallback: 'background jobs run inside the request process and are lost on restart',
  },
  {
    settings: ['ABLY_API_KEY'],
    fallback: 'realtime is an in-memory stand-in: nothing is delivered to other instances or browsers',
  },
  {
    settings: ['CLERK_WEBHOOK_SECRET'],
    fallback: 'the Clerk webhook answers 503, so changes made in Clerk are not synced',
  },
]

const REQUIRED_IN_PRODUCTION: Setting[] = SERVICES.flatMap((service) => service.settings)

/**
 * Whether the services above must all be configured. True for a Vercel
 * production deployment, and for NODE_ENV=production anywhere that is not Vercel
 * (so self-hosting stays strict). A Vercel preview also runs with
 * NODE_ENV=production, but may use the stand-ins: the boot warns loudly instead.
 */
export function requiresProductionConfig(source: Record<string, string | undefined>): boolean {
  if (source.VERCEL_ENV !== undefined) return source.VERCEL_ENV === 'production'
  return source.NODE_ENV === 'production'
}

function crossRuleProblems(source: Record<string, string | undefined>): Map<string, string> {
  const problems = new Map<string, string>()
  const present = (name: Setting) => source[name] !== undefined

  for (const [a, b] of CREDENTIAL_PAIRS) {
    if (present(a) !== present(b)) {
      const missing = present(a) ? b : a
      problems.set(missing, `is required when ${present(a) ? a : b} is set`)
    }
  }
  const testServer = source.INTEGRATION_TEST_SERVER === 'true'
  if (testServer && requiresProductionConfig(source)) {
    problems.set('INTEGRATION_TEST_SERVER', 'must not be set in production')
  }
  if (source.NODE_ENV === 'production' && !testServer && present('PAGE_FETCH_ALLOW_PRIVATE')) {
    problems.set('PAGE_FETCH_ALLOW_PRIVATE', 'must not be set in production')
  }
  if (requiresProductionConfig(source)) {
    for (const name of REQUIRED_IN_PRODUCTION) {
      if (!present(name) && !problems.has(name)) problems.set(name, 'is required in production')
    }
  }
  return problems
}

export type Env = z.infer<typeof envSchema>

/** What this process is running without: one line per service that has no credentials. */
export function inMemoryFallbacks(config: Env): string[] {
  return SERVICES.filter((service) => service.settings.some((name) => config[name as keyof Env] === undefined)).map(
    (service) => `${service.settings.join(' / ')} not set: ${service.fallback}`
  )
}

export class EnvValidationError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid environment configuration:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`)
    this.name = 'EnvValidationError'
  }
}

// Zod's own wording for some issues (an unknown enum value, for one) quotes the
// value it received, and a setting's value may be a secret. Only issue kinds
// whose message is known not to carry the value use Zod's text.
function describe(issue: z.ZodIssue): string {
  switch (issue.code) {
    case z.ZodIssueCode.invalid_enum_value:
      return `must be one of: ${issue.options.join(', ')}`
    case z.ZodIssueCode.invalid_type:
    case z.ZodIssueCode.too_small:
    case z.ZodIssueCode.too_big:
    case z.ZodIssueCode.invalid_string:
    case z.ZodIssueCode.custom:
      return issue.message
    default:
      return 'is invalid'
  }
}

/** Parses a set of variables. Empty strings count as unset, so a copied .env.example works. */
export function parseEnv(source: Record<string, string | undefined> = process.env): Env {
  const cleaned: Record<string, string | undefined> = {}
  for (const [key, raw] of Object.entries(source)) {
    cleaned[key] = typeof raw === 'string' && raw.trim() === '' ? undefined : raw
  }

  const result = envSchema.safeParse(cleaned)
  const problems = new Map<string, string>()
  if (!result.success) {
    for (const issue of result.error.issues) problems.set(issue.path.join('.') || 'environment', describe(issue))
  }
  // A setting already reported as malformed is not also reported as missing.
  for (const [name, message] of crossRuleProblems(cleaned)) if (!problems.has(name)) problems.set(name, message)

  if (problems.size > 0 || !result.success) {
    throw new EnvValidationError([...problems].map(([name, message]) => `${name}: ${message}`))
  }
  return result.data
}

let cached: Env | undefined

/** Parses and caches process.env; throws EnvValidationError listing every problem. */
export function validateEnv(): Env {
  if (!cached) cached = parseEnv(process.env)
  return cached
}

/** For tests that change process.env between cases. */
export function resetEnvCache() {
  cached = undefined
}

// Typed access. Validation happens on first use, so importing this module
// (which `next build` does while collecting routes) needs no configuration.
export const env: Env = new Proxy({} as Env, {
  get: (_target, property: string) => validateEnv()[property as keyof Env],
  has: (_target, property: string) => property in validateEnv(),
  ownKeys: () => Reflect.ownKeys(validateEnv()),
  getOwnPropertyDescriptor: (_target, property: string) => ({
    enumerable: true,
    configurable: true,
    value: validateEnv()[property as keyof Env],
  }),
})

// NODE_ENV alone, for module-scope code that must not require the rest of the
// configuration (the Prisma client is created when the module loads).
export const nodeEnv: Env['NODE_ENV'] = z
  .enum(['development', 'test', 'production'])
  .catch('development')
  .parse(process.env.NODE_ENV)

// PRISMA_QUERY_LOG alone, for the same reason. A function, so a script can set the variable after its imports have run.
export function prismaQueryLog(): 'on' | 'off' {
  return z.enum(['on', 'off']).catch('on').parse(process.env.PRISMA_QUERY_LOG)
}
