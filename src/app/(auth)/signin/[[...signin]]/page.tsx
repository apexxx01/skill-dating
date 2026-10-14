import { SignIn } from '@clerk/nextjs'

// Clerk's hosted-in-app sign-in with path routing: the multi-step flows (second
// factor, SSO callback) live under /signin/*, which is why this is a catch-all.
// Returning users land on the dashboard; middleware sends anyone who has not
// finished onboarding on to /onboarding from there. A callbackUrl set by
// middleware wins, but only when it is a path on this site.
function localPath(value: string | undefined): string | undefined {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return undefined
  return value
}

export default async function SignInPage(props: { searchParams: Promise<{ callbackUrl?: string }> }) {
  const searchParams = await props.searchParams
  const callbackUrl = localPath(searchParams.callbackUrl)
  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4 py-12">
      <SignIn
        routing="path"
        path="/signin"
        signUpUrl="/signup"
        fallbackRedirectUrl="/dashboard"
        {...(callbackUrl ? { forceRedirectUrl: callbackUrl } : {})}
      />
    </div>
  )
}
