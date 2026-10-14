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

const envSchema = z.object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

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
  })

// Rules that span several settings. They are checked from which settings are
// present, outside Zod, because Zod skips refinements once any field is invalid
// and a boot should report every problem, not make you fix them in rounds.
type Setting = keyof z.input<typeof envSchema>

const CREDENTIAL_PAIRS: [Setting, Setting][] = [
  ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'],
  ['INNGEST_EVENT_KEY', 'INNGEST_SIGNING_KEY'],
]

// Production runs more than one instance, so the in-memory stand-ins would
// silently give each instance its own rate limits and presence, and jobs and
// realtime delivery would not exist at all.
const REQUIRED_IN_PRODUCTION: Setting[] = [
  'CLERK_WEBHOOK_SECRET',
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
  'INNGEST_EVENT_KEY',
  'INNGEST_SIGNING_KEY',
  'ABLY_API_KEY',
]

function crossRuleProblems(source: Record<string, string | undefined>): Map<string, string> {
  const problems = new Map<string, string>()
  const present = (name: Setting) => source[name] !== undefined

  for (const [a, b] of CREDENTIAL_PAIRS) {
    if (present(a) !== present(b)) {
      const missing = present(a) ? b : a
      problems.set(missing, `is required when ${present(a) ? a : b} is set`)
    }
  }
  if (source.NODE_ENV === 'production') {
    for (const name of REQUIRED_IN_PRODUCTION) {
      if (!present(name) && !problems.has(name)) problems.set(name, 'is required in production')
    }
  }
  return problems
}

export type Env = z.infer<typeof envSchema>

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
