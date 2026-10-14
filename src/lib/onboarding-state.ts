// What the middleware learned from asking /api/users/me whether the caller has
// finished onboarding. Only a definite answer from the API counts: a 401 (the
// session token expired between the middleware's check and this call, or the
// local account is gone), any other failure and an unreadable body are
// "unknown", and an unknown state must never send an onboarded user back to
// /onboarding. The request goes on to the page, whose own auth() check sends a
// truly signed-out visitor to /signin.
export type OnboardingState = 'complete' | 'incomplete' | 'unknown'

export function readOnboardingState(status: number, body: unknown): OnboardingState {
  if (status !== 200) return 'unknown'
  const complete = (body as { onboardingComplete?: unknown } | null)?.onboardingComplete
  if (complete === true) return 'complete'
  if (complete === false) return 'incomplete'
  return 'unknown'
}
