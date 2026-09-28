"use client"

// Bare placeholder — frontend is frozen. Maps NextAuth's `error` query param
// to a human-readable message; no visual design pass yet.

import { Suspense } from "react"
import { useSearchParams } from "next/navigation"

const ERROR_MESSAGES: Record<string, string> = {
  Configuration: "There's a problem with the server configuration.",
  AccessDenied: "You don't have access to sign in.",
  Verification: "That sign-in link is invalid or has expired.",
  CredentialsSignin: "Invalid email or password.",
  OAuthAccountNotLinked: "That email is already linked to a different sign-in method.",
  Default: "Something went wrong while signing in.",
}

function ErrorContent() {
  const searchParams = useSearchParams()
  const code = searchParams.get("error") || "Default"
  const message = ERROR_MESSAGES[code] || ERROR_MESSAGES.Default

  return (
    <div style={{ maxWidth: 400, margin: "64px auto", padding: 16 }}>
      <h1>Sign-in error</h1>
      <p>{message}</p>
      <p>
        <a href="/signin">Back to sign in</a>
      </p>
    </div>
  )
}

export default function AuthErrorPage() {
  return (
    <Suspense fallback={<div style={{ maxWidth: 400, margin: "64px auto", padding: 16 }}>Loading...</div>}>
      <ErrorContent />
    </Suspense>
  )
}
