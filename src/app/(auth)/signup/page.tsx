"use client"

// Bare placeholder — frontend is frozen. Functionally complete (real
// registration + sign-in), no visual design pass yet.

import { useState } from "react"
import { signIn } from "next-auth/react"
import { useRouter } from "next/navigation"

export default function SignUpPage() {
  const router = useRouter()
  const [form, setForm] = useState({ name: "", username: "", email: "", password: "" })
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setIsLoading(true)

    try {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      })
      const data = await res.json()

      if (!res.ok) {
        setError(data.error || "Something went wrong")
        return
      }

      const result = await signIn("credentials", {
        email: form.email,
        password: form.password,
        redirect: false,
      })

      if (result?.error) {
        setError("Account created, but automatic sign-in failed. Please sign in manually.")
        router.push("/signin")
        return
      }

      router.push("/onboarding")
      router.refresh()
    } catch {
      setError("Something went wrong")
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div style={{ maxWidth: 400, margin: "64px auto", padding: 16 }}>
      <h1>Create account</h1>

      {error && (
        <p style={{ color: "crimson", fontSize: 14 }}>{error}</p>
      )}

      <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <label>
          Name
          <input
            type="text"
            required
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            style={{ display: "block", width: "100%" }}
          />
        </label>
        <label>
          Username
          <input
            type="text"
            required
            minLength={3}
            pattern="[a-zA-Z0-9_-]+"
            value={form.username}
            onChange={(e) => setForm({ ...form, username: e.target.value })}
            style={{ display: "block", width: "100%" }}
          />
        </label>
        <label>
          Email
          <input
            type="email"
            required
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
            style={{ display: "block", width: "100%" }}
          />
        </label>
        <label>
          Password
          <input
            type="password"
            required
            minLength={8}
            autoComplete="new-password"
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            style={{ display: "block", width: "100%" }}
          />
        </label>
        <button type="submit" disabled={isLoading}>
          {isLoading ? "Creating account..." : "Sign up"}
        </button>
      </form>

      <p>
        Already have an account? <a href="/signin">Sign in</a>
      </p>
    </div>
  )
}
