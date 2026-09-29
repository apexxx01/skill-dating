# Skill Dating

A builder-first social network. Find the right people to build with — hackathon
teammates, collaborators, mentors — matched on demonstrated skills instead of static
profiles, then take the whole journey inside one product: form a team, chat, build,
ship, and earn reputation.

> Status: pre-launch. The backend is functional end to end; the interface is a
> functional placeholder while the visual design is being built separately.

## The core loop

```
Discover → Connect → Team up → Chat → Build → Ship → Compete → Win → Reputation
```

1. **Discover** builders ranked by skill compatibility with you, and **connect** with
   a typed request (teammate, collaborator, mentor, friend, network, or dating) that
   unlocks a DM the moment it's accepted.
2. **Team up.** Teams are open or closed to applications, capped by size, and joined
   through an apply/accept flow — either direction: apply to a recruiting team, or get
   invited directly by its owner.
3. **Coordinate.** Every team, project and hackathon gets a conversation, and members
   are added to it the moment they join.
4. **Build and ship** projects, or post a "currently building" status others can browse.
5. **Compete** in hackathons as a team, submit for judging, and **win** — placements
   award XP and a permanent achievement to every member of the winning team.
6. **Reputation.** XP, an activity feed, achievements, and a live leaderboard.

## What's implemented

| Area | Details |
| --- | --- |
| Auth | Email/password registration (bcrypt, validated, rate limited) plus GitHub, Google and Discord OAuth. Sessions via NextAuth v5. A GitHub sign-in raises `verificationLevel`, never downgrading it. |
| Onboarding | Route-level gating: an account can't reach the app until it has a headline and at least one skill. |
| Discovery | `GET /api/discover` — paginated, excludes yourself, ranked by a shared, unit-tested skill-compatibility score. |
| Connections | Typed connection requests in either direction, checked both ways for conflicts, no self-connect. Accepting one atomically creates the shared DM conversation. |
| Teams | Create, browse and filter (recruiting, hackathon, free text, skill match), apply, accept or reject, withdraw your own application, invite someone directly, leave, remove members, promote/demote roles, transfer ownership, delete. |
| Team integrity | Team and (independently) project size caps are enforced atomically inside the accept transaction, so simultaneous accepts can never overfill either one. A sole owner can't abandon a team with no owner left — they transfer ownership first. |
| Projects | Public showcase listing with correct visibility rules for private and member projects (owner, member, or public — not just public). Status lifecycle through to shipped. Delete cascades cleanly. |
| Current builds | Post a "what I'm building right now" status (`PUT /api/builds/me`), browsable as a public feed, optionally scoped to a hackathon. |
| Hackathons | Browse by status, register, form or join a team, min/max team size enforced independently of the team's own cap, submit a project for judging, and record final placements — which award win XP and an achievement to every member of the winning team. Status moves forward only (upcoming → active → ended, or cancelled). |
| Messaging | Direct, team, project and hackathon conversations. Send, edit and delete with soft-delete masking, and pagination. |
| Notifications | Written on applications, decisions, invitations, connections, messages, removals, registrations and hackathon wins. The UI reads real data, supports mark-read and mark-all-read, and keeps an unread count. |
| Moderation | Report a user (deduped, no self-reporting), moderator/admin review queue with forward-only status transitions, each resolution logged as a moderation action and an audit event. |
| Reputation | Shared XP award logic, a real activity feed, achievements (granted idempotently, defined in one place), and a live leaderboard computed from the XP event log. |
| Profiles | Skills with evidence, XP, achievements, owned and joined projects, owned and joined teams. |
| My applications | `GET /api/teams/applications` — a user's own applications and their status, including invitations sent to them. |
| Demo data | `npm run db:seed` populates a small, clearly-fake community (users, projects, teams in different states, hackathons, messages, applications) — idempotent, safe to re-run. |

Ownership and membership checks live in shared helpers, so authorization is not
re-implemented per route. Every route is documented in
[`docs/API.md`](docs/API.md), generated from the actual handler code.

## Stack

Next.js 14 (App Router) · TypeScript · PostgreSQL · Prisma · NextAuth v5 · Zod ·
Tailwind CSS · Radix UI · React Query · react-three-fiber · Vitest

## Getting started

Requirements: Node 20+ and a PostgreSQL database.

```bash
git clone https://github.com/apexxx01/skill-dating.git
cd skill-dating
npm install

cp .env.example .env.local
# set DATABASE_URL and NEXTAUTH_SECRET (openssl rand -base64 32)
# OAuth keys are optional — email/password works without them

npx prisma db push
npm run db:seed   # optional — populates a small demo community; credentials in the file's header comment
npm run dev
```

Open http://localhost:3000.

> Do not set `NEXTAUTH_URL`. With `next-auth@5` beta and Next 14.1 it crashes every
> `/api/auth/*` route; v5 infers the URL on its own.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Start the dev server |
| `npm run build` | Production build |
| `npm run typecheck` | Type-check the project |
| `npm test` | Run the unit tests (fast, mocked Prisma, no DB needed) |
| `npm run test:integration` | Run the integration suite against a real, disposable database — spins up its own `next dev` server, no manual setup beyond a reachable Postgres |
| `npm run db:seed` | Populate a small idempotent demo community |
| `npm run db:studio` | Browse the database in Prisma Studio |

## Project layout

```
prisma/schema.prisma   data model
prisma/seed.ts         idempotent demo data
src/app/api/           route handlers
src/app/(dashboard)/   authenticated app pages
src/lib/               scoring, XP, activity/achievements, auth, shared API helpers
src/hooks/             client data hooks
tests/integration/     real-server, real-database integration tests
docs/API.md            full route reference, generated from the handlers
```

## Roadmap

- Challenges (would need sandboxed code execution — a security decision, not a
  route) and full skill-evidence verification beyond the GitHub sign-in signal
  are modelled in the schema but have no further API routes yet.
- Blocking and muting.
- Distributed rate limiting (the current limiter is in-memory and per-process).
- Real-time delivery. Notifications currently refresh by polling.
- Full interface design.

See [PRODUCT.md](PRODUCT.md) for the product vision and principles.
