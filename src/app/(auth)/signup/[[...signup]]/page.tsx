import { SignUp } from '@clerk/nextjs'

// Path routing, so the verification steps live under /signup/*. A new account
// always continues to onboarding; the local profile is created on the first
// authenticated request (or the Clerk webhook, whichever arrives first).
export default function SignUpPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4 py-12">
      <SignUp routing="path" path="/signup" signInUrl="/signin" forceRedirectUrl="/onboarding" />
    </div>
  )
}
