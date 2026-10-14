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

const envSchema = z
  .object({
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
  .superRefine((value, ctx) => {
    const requireSet = (name: keyof typeof value, reason: string) => {
      if (value[name] === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [name], message: reason })
    }
    const pair = (a: keyof typeof value, b: keyof typeof value) => {
      if ((value[a] === undefined) !== (value[b] === undefined)) {
        const missing = value[a] === undefined ? a : b
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [missing], message: `is required when ${missing === a ? b : a} is set` })
      }
    }

    pair('UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN')
    pair('INNGEST_EVENT_KEY', 'INNGEST_SIGNING_KEY')

    // Production runs more than one instance, so the in-memory stand-ins would
    // silently give each instance its own rate limits and presence, and jobs and
    // realtime delivery would not exist at all.
    if (value.NODE_ENV === 'production') {
      requireSet('CLERK_WEBHOOK_SECRET', 'is required in production')
      requireSet('UPSTASH_REDIS_REST_URL', 'is required in production')
      requireSet('UPSTASH_REDIS_REST_TOKEN', 'is required in production')
      requireSet('INNGEST_EVENT_KEY', 'is required in production')
      requireSet('INNGEST_SIGNING_KEY', 'is required in production')
      requireSet('ABLY_API_KEY', 'is required in production')
    }
  })

export type Env = z.infer<typeof envSchema>

export class EnvValidationError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid environment configuration:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`)
    this.name = 'EnvValidationError'
  }
}

/** Parses a set of variables. Empty strings count as unset, so a copied .env.example works. */
export function parseEnv(source: Record<string, string | undefined> = process.env): Env {
  const cleaned: Record<string, string | undefined> = {}
  for (const [key, raw] of Object.entries(source)) {
    cleaned[key] = typeof raw === 'string' && raw.trim() === '' ? undefined : raw
  }
  const result = envSchema.safeParse(cleaned)
  if (!result.success) {
    throw new EnvValidationError(
      result.error.issues.map((issue) => `${issue.path.join('.') || 'environment'}: ${issue.message}`)
    )
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
