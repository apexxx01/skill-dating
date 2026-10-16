import type { PrismaClient, Prisma, SubscriptionPlan, SubscriptionStatus } from '@prisma/client'
import { env } from '@/lib/env'

// What a plan includes, in one table, so turning a paywall on is a config switch
// and not a code change. Everyone is on FREE today and ENTITLEMENTS_ENFORCED is
// off, which opens every feature to everyone; only the hard safety ceilings
// below still apply (they exist to stop abuse, not to sell anything).
//
// Ask in code with can() and limit(); never compare a plan name directly.

export const PLANS = ['FREE', 'PRO', 'CREW_PRO', 'ORG'] as const satisfies readonly SubscriptionPlan[]
export type Plan = (typeof PLANS)[number]

type PlanValues<T> = Record<Plan, T>

interface LimitSpec {
  kind: 'limit'
  /** The number each plan gets. */
  plans: PlanValues<number>
  /** Applies whatever the plan and whatever ENTITLEMENTS_ENFORCED says. */
  hardLimit: number
}

interface SwitchSpec {
  kind: 'switch'
  plans: PlanValues<boolean>
}

const everyone = <T>(value: T): PlanValues<T> => ({ FREE: value, PRO: value, CREW_PRO: value, ORG: value })

export const ENTITLEMENTS = {
  // Profiles shown to the user per day.
  DAILY_DROPS: { kind: 'limit', plans: { FREE: 3, PRO: 10, CREW_PRO: 10, ORG: 10 }, hardLimit: 50 },
  // Sparks a user can send per local day. The hard ceiling is what stops one account messaging the whole network.
  DAILY_SPARKS: { kind: 'limit', plans: { FREE: 5, PRO: 25, CREW_PRO: 25, ORG: 25 }, hardLimit: 40 },
  // Build dates a user can set up per week.
  BUILD_DATES_PER_WEEK: { kind: 'limit', plans: { FREE: 2, PRO: 10, CREW_PRO: 10, ORG: 10 }, hardLimit: 50 },
  SEE_WHO_SPARKED: { kind: 'switch', plans: { FREE: false, PRO: true, CREW_PRO: true, ORG: true } },
  ADVANCED_FILTERS: { kind: 'switch', plans: { FREE: false, PRO: true, CREW_PRO: true, ORG: true } },
  PROFILE_ANALYTICS: { kind: 'switch', plans: { FREE: false, PRO: true, CREW_PRO: true, ORG: true } },
  CUSTOM_DOMAIN: { kind: 'switch', plans: { FREE: false, PRO: false, CREW_PRO: true, ORG: true } },
} as const satisfies Record<string, LimitSpec | SwitchSpec>

export type Feature = keyof typeof ENTITLEMENTS
export type LimitFeature = { [F in Feature]: (typeof ENTITLEMENTS)[F] extends { kind: 'limit' } ? F : never }[Feature]
export type SwitchFeature = Exclude<Feature, LimitFeature>

export const FEATURES = Object.keys(ENTITLEMENTS) as Feature[]

/** Who is asking: all the table needs is their plan. */
export interface Subject {
  plan: Plan
}

export interface EntitlementOptions {
  /** Defaults to ENTITLEMENTS_ENFORCED. */
  enforced?: boolean
}

function isEnforced(options?: EntitlementOptions): boolean {
  return options?.enforced ?? env.ENTITLEMENTS_ENFORCED
}

/**
 * How many the subject may have, for the features that are counted. With
 * enforcement off this is the hard ceiling for every plan.
 */
export function limit(subject: Subject, feature: LimitFeature, options?: EntitlementOptions): number {
  const spec: LimitSpec = ENTITLEMENTS[feature]
  if (!isEnforced(options)) return spec.hardLimit
  return Math.min(spec.plans[subject.plan], spec.hardLimit)
}

/**
 * Whether the subject has the feature. With enforcement off every feature is
 * open; a counted feature is open while its hard ceiling is above zero.
 */
export function can(subject: Subject, feature: Feature, options?: EntitlementOptions): boolean {
  const spec: LimitSpec | SwitchSpec = ENTITLEMENTS[feature]
  if (spec.kind === 'limit') return limit(subject, feature as LimitFeature, options) > 0
  return isEnforced(options) ? spec.plans[subject.plan] : true
}

/** Whether one more use is allowed after `used` so far. */
export function withinLimit(subject: Subject, feature: LimitFeature, used: number, options?: EntitlementOptions): boolean {
  return used < limit(subject, feature, options)
}

/** The whole table for a plan, as the interface needs it to draw upgrade prompts. */
export function entitlementsFor(subject: Subject, options?: EntitlementOptions): Record<Feature, number | boolean> {
  const out = {} as Record<Feature, number | boolean>
  for (const feature of FEATURES) {
    out[feature] = ENTITLEMENTS[feature].kind === 'limit' ? limit(subject, feature as LimitFeature, options) : can(subject, feature, options)
  }
  return out
}

// --- Plans from subscriptions -------------------------------------------------

export interface SubscriptionState {
  plan: SubscriptionPlan
  status: SubscriptionStatus
  currentPeriodEnd: Date | null
}

/**
 * The plan a subscription entitles its user to right now. Without a
 * subscription, or when it has ended, that is FREE. A subscription whose
 * payment is late keeps its plan until the period it paid for ends. A cancelled
 * one keeps it until the period ends too, but needs an end date to do so.
 */
export function planFor(subscription: SubscriptionState | null | undefined, now: Date = new Date()): Plan {
  if (!subscription || subscription.status === 'EXPIRED') return 'FREE'
  const { currentPeriodEnd } = subscription
  if (currentPeriodEnd) return currentPeriodEnd.getTime() > now.getTime() ? subscription.plan : 'FREE'
  return subscription.status === 'CANCELED' ? 'FREE' : subscription.plan
}

type Db = PrismaClient | Prisma.TransactionClient

export async function subjectFor(db: Db, userId: string, now: Date = new Date()): Promise<Subject> {
  const subscription = await db.subscription.findUnique({
    where: { userId },
    select: { plan: true, status: true, currentPeriodEnd: true },
  })
  return { plan: planFor(subscription, now) }
}
