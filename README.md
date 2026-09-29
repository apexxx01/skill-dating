# Skill Dating

A builder-first social network. Find the right people to build with — hackathon
teammates, collaborators, mentors — matched on demonstrated skills instead of static
profiles, then take the whole journey inside one product: form a team, chat, build,
ship, and earn reputation.

> Status: pre-launch. The backend is functional end to end; the interface is a
> functional placeholder while the visual design is being built separately.

## The core loop

```
Discover  →  Match  →  Team up  →  Chat  →  Build  →  Ship  →  Compete  →  Reputation
```

1. **Discover** builders ranked by skill compatibility with you.
2. **Team up.** Teams are open or closed to applications, capped by size, and joined
   through an apply/accept flow with owner and admin roles.
3. **Coordinate.** Every team, project and hackathon gets a conversation, and members
   are added to it the moment they join.
4. **Build and ship** projects. Shipping awards XP.
5. **Compete** in hackathons as a team, with the team's project carried into the entry.
6. **Reputation.** XP, achievements and a live leaderboard.

## What's implemented

| Area | Details |
| --- | --- |
| Auth | Email/password registration (bcrypt, validated, rate limited) plus GitHub, Google and Discord OAuth. Sessions via NextAuth v5. |
| Onboarding | Route-level gating: an account can't reach the app until it has a headline and at least one skill. |
| Discovery | `GET /api/discover` — paginated, excludes yourself, ranked by a shared, unit-tested skill-compatibility score. |
| Teams | Create, browse and filter (recruiting, hackathon, free text, skill match), apply, accept or reject, leave, remove members. |
| Team integrity | Team size caps are enforced atomically, so simultaneous accepts can never overfill a team. A sole owner can't abandon a team. Accepting an application creates the team, project and conversation memberships in a single transaction. |
| Projects | Public showcase listing with correct visibility rules for private and member projects. Status lifecycle through to shipped. |
| Hackathons | Browse by status, register a team, min and max team size enforced, team project inherited into the entry. |
| Messaging | Direct, team, project and hackathon conversations. Send, edit and delete with soft-delete masking, and pagination. |
| Notifications | Written on applications, decisions, messages, removals and registrations. The UI reads real data, supports mark-read and mark-all-read, and keeps an unread count. |
| Reputation | Shared XP award logic, achievements, and a live leaderboard computed from the XP event log. |
| Profiles | Skills with evidence, XP, achievements, owned and joined projects, owned and joined teams. |
| My applications | `GET /api/teams/applications` — a user's own applications and their status. |

Ownership and membership checks live in shared helpers, so authorization is not
re-implemented per route.

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
| `npm test` | Run the unit tests |
| `npm run db:studio` | Browse the database in Prisma Studio |

## Project layout

```
prisma/schema.prisma   data model
src/app/api/           route handlers
src/app/(dashboard)/   authenticated app pages
src/lib/               scoring, XP, auth, shared API helpers
src/hooks/             client data hooks
```

## Roadmap

- Skill verification, challenges, "currently building" status and content reporting
  are modelled in the schema but have no API routes yet.
- Blocking and muting.
- Distributed rate limiting (the current limiter is in-memory and per-process).
- Real-time delivery. Notifications currently refresh by polling.
- Full interface design.

See [PRODUCT.md](PRODUCT.md) for the product vision and principles.
