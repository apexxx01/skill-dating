# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary: student and early-career builders (developers, designers, and other technical/creative makers) looking for people to build with. Secondary audiences (indie hackers, working professionals) are supported by the same skill graph but are not the primary design target.

## Product Purpose

Skill Dating connects builders to the right people for the right kind of relationship — teammate, collaborator, mentor, friend, professional network, or romantic connection — based on verified skills and demonstrated work, not just a static profile or resume. Success means a user finds a genuine match (a hackathon teammate, a mentor, a co-founder, a friend, or a date) faster and with more confidence than they would through LinkedIn, Discord, or a hackathon Slack.

## Positioning

The product's mechanism is one skill graph serving multiple connection types at once: TEAMMATE, COLLABORATOR, MENTOR, FRIEND, NETWORK, and DATING are all edges on the same underlying profile, verified by GitHub/portfolio/organization/identity checks and a gamified reputation system (XP, rank, reputation score). A neighboring product can't truthfully copy this because they're built for a single connection type (LinkedIn: professional network; hackathon Slack: ephemeral team-forming; dating apps: romance only) — this product's differentiator is skill-verified matching that spans all of those contexts from one identity.

## Operating Context

- Users discover others via a swipe/browse-style `discover` flow, matched on skills and connection-type intent.
- Hackathons are a first-class object: users register, form teams, and submit projects within the app.
- Projects (with status from IDEA through SHIPPED/ARCHIVED) and Challenges (categorized by domain and difficulty) are used as evidence of skill, not just claimed skill tags.
- Teams have roles (OWNER/ADMIN/MEMBER) and an application/invitation flow (PENDING/ACCEPTED/REJECTED/WITHDRAWN).
- Messaging (conversations) and notifications (new message, team invite, join request, hackathon reminder, project update, achievement, challenge completion, connection, mention, application response, system) support ongoing coordination after a match.
- Moderation exists: users can report profiles/content for spam, harassment, inappropriate content, fake profiles, scams, or copyright, with a PENDING → REVIEWING → RESOLVED/DISMISSED pipeline.
- Onboarding is a distinct flow (`/onboarding`) separate from sign-in/sign-up.

## Capabilities and Constraints

- Stack: Next.js 14 (App Router), Prisma + PostgreSQL, NextAuth (`next-auth@5 beta`) with a Prisma adapter, React Query, Radix UI primitives, Tailwind, Framer Motion/`motion`, `@react-three/fiber` + `three` for 3D.
- Verification levels are staged: NONE → EMAIL → PHONE → GITHUB → PORTFOLIO → ORGANIZATION → IDENTITY. Design must be able to show a user's verification state credibly without overstating unverified claims.
- Connection type (teammate vs. dating, etc.) is a real, user-facing distinction the UI must make legible — these are not interchangeable "matches."
- Undecided: monetization model, mobile app plans (native vs. responsive web only), and moderation/trust-and-safety UI maturity beyond the data model above.

## Brand Commitments

Working name "Skill Dating" (repo/package name `skill-dating`). No confirmed logo, palette, typography, or other binding visual identity yet — those are visual-world decisions for `new-work`/`document`, not recorded here.

## Evidence on Hand

None. This is pre-launch with no real users, testimonials, case studies, or launch-partner community yet. Future design work must not fabricate any of these — use realistic placeholder content clearly treated as placeholder, not implied-real evidence.

## Product Principles

1. One identity, many connection types — skill verification and reputation are shared infrastructure across teammate, mentor, friend, network, and dating contexts, not siloed per use case.
2. Evidence over claims — projects, challenges, and verification levels exist so skill is demonstrated, not just asserted; design should surface proof, not just profile text.
3. Coordination doesn't stop at the match — messaging, notifications, and team/application workflows are core to the product, not an afterthought bolted onto a swipe screen.
4. Early-career-first — the primary user is a student/early-career builder; design should not assume the polish, network, or confidence of a senior professional.
5. Trust is load-bearing — with dating as one of the connection types alongside professional contexts, moderation and reporting are functional requirements, not optional extras.

## Accessibility & Inclusion

No product-specific accessibility requirement has been established yet; follow standard web accessibility practice (WCAG 2.1 AA) absent a more specific mandate.
