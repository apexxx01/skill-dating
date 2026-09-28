"use client"

// Bare placeholder — frontend is frozen. Functionally complete: sets
// headline and at least one skill, which is what middleware checks to
// consider onboarding done. No visual design pass yet.

import { useEffect, useState } from "react"
import { useSession } from "next-auth/react"
import { useRouter } from "next/navigation"

// Depends on session state; not a candidate for static generation.
export const dynamic = "force-dynamic"

interface Skill {
  id: string
  name: string
  category: string
}

export default function OnboardingPage() {
  const { data: session, status } = useSession()
  const router = useRouter()

  const [skills, setSkills] = useState<Skill[]>([])
  const [headline, setHeadline] = useState("")
  const [selectedSkillIds, setSelectedSkillIds] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  useEffect(() => {
    if (status === "unauthenticated") {
      router.push("/signin?callbackUrl=/onboarding")
    }
  }, [status, router])

  useEffect(() => {
    fetch("/api/skills?limit=100")
      .then((res) => res.json())
      .then((data) => setSkills(data.skills ?? []))
      .catch(() => setError("Couldn't load skills. Try refreshing."))
  }, [])

  const toggleSkill = (id: string) => {
    setSelectedSkillIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)

    if (!headline.trim()) {
      setError("Headline is required")
      return
    }
    if (selectedSkillIds.size === 0) {
      setError("Pick at least one skill")
      return
    }
    if (!session?.user?.id) {
      setError("Not signed in")
      return
    }

    setIsSubmitting(true)
    try {
      const headlineRes = await fetch("/api/users", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ headline: headline.trim() }),
      })
      if (!headlineRes.ok) {
        const data = await headlineRes.json()
        throw new Error(data.error || "Failed to save headline")
      }

      for (const skillId of selectedSkillIds) {
        const res = await fetch(`/api/users/${session.user.id}/skills`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ skillId, level: 3 }),
        })
        // Ignore "already added" (400) so re-submits after a partial
        // failure don't block on skills that already saved.
        if (!res.ok && res.status !== 400) {
          const data = await res.json()
          throw new Error(data.error || "Failed to save skills")
        }
      }

      router.push("/dashboard")
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong")
    } finally {
      setIsSubmitting(false)
    }
  }

  if (status === "loading") {
    return <div style={{ maxWidth: 480, margin: "64px auto", padding: 16 }}>Loading...</div>
  }

  return (
    <div style={{ maxWidth: 480, margin: "64px auto", padding: 16 }}>
      <h1>Set up your builder profile</h1>
      <p>Add a headline and a few skills so people can find you.</p>

      {error && <p style={{ color: "crimson", fontSize: 14 }}>{error}</p>}

      <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <label>
          Headline
          <input
            type="text"
            required
            placeholder="e.g. Full-stack builder shipping AI tools"
            value={headline}
            onChange={(e) => setHeadline(e.target.value)}
            style={{ display: "block", width: "100%" }}
          />
        </label>

        <fieldset>
          <legend>Skills ({selectedSkillIds.size} selected)</legend>
          <div style={{ maxHeight: 300, overflowY: "auto", display: "flex", flexDirection: "column", gap: 4 }}>
            {skills.map((skill) => (
              <label key={skill.id} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input
                  type="checkbox"
                  checked={selectedSkillIds.has(skill.id)}
                  onChange={() => toggleSkill(skill.id)}
                />
                {skill.name} <span style={{ opacity: 0.6 }}>({skill.category})</span>
              </label>
            ))}
            {skills.length === 0 && <p>Loading skills...</p>}
          </div>
        </fieldset>

        <button type="submit" disabled={isSubmitting}>
          {isSubmitting ? "Saving..." : "Finish setup"}
        </button>
      </form>
    </div>
  )
}
