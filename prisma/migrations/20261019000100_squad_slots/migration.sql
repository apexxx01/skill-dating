-- Squads, stage 1E, part 1: structured role slots on a team (TeamSlot), the role a member plays (TeamMember.squadRole), applications and invitations
-- for a slot, invitation expiry, a hackathon's submission deadline and when a participant joined their squad. Ends with the data migration of
-- every team's free-text lookingFor into OTHER slots; Team.lookingFor stays, derived from the open slots from now on.

-- CreateEnum
CREATE TYPE "SquadRole" AS ENUM ('FRONTEND', 'BACKEND', 'FULLSTACK', 'MOBILE', 'ML_AI', 'DATA', 'DEVOPS', 'DESIGN_UI_UX', 'PRODUCT', 'PITCH_BUSINESS', 'HARDWARE', 'OTHER');

-- CreateEnum
CREATE TYPE "SlotStatus" AS ENUM ('OPEN', 'FILLED');

-- AlterEnum
ALTER TYPE "TeamApplicationStatus" ADD VALUE 'EXPIRED';

-- AlterTable
ALTER TABLE "TeamMember" ADD COLUMN     "roleLabel" TEXT,
ADD COLUMN     "squadRole" "SquadRole";

-- AlterTable
ALTER TABLE "TeamApplication" ADD COLUMN     "expiresAt" TIMESTAMP(3),
ADD COLUMN     "slotId" TEXT;

-- AlterTable
ALTER TABLE "Hackathon" ADD COLUMN     "submissionDeadline" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "HackathonParticipant" ADD COLUMN     "teamJoinedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "TeamSlot" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "role" "SquadRole" NOT NULL,
    "customLabel" TEXT,
    "requiredSkills" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "SlotStatus" NOT NULL DEFAULT 'OPEN',
    "filledById" TEXT,
    "filledAt" TIMESTAMP(3),
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeamSlot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TeamSlot_teamId_status_idx" ON "TeamSlot"("teamId", "status");

-- CreateIndex
CREATE INDEX "TeamSlot_filledById_idx" ON "TeamSlot"("filledById");

-- CreateIndex
CREATE INDEX "TeamApplication_status_expiresAt_idx" ON "TeamApplication"("status", "expiresAt");

-- AddForeignKey
ALTER TABLE "TeamApplication" ADD CONSTRAINT "TeamApplication_slotId_fkey" FOREIGN KEY ("slotId") REFERENCES "TeamSlot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamSlot" ADD CONSTRAINT "TeamSlot_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamSlot" ADD CONSTRAINT "TeamSlot_filledById_fkey" FOREIGN KEY ("filledById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Data: one OPEN slot of role OTHER per existing lookingFor entry, labelled with it and asking for it as a skill, in the order it was listed. The
-- entry is kept verbatim (no guessing at a role in SQL); the lookingFor that the code derives from these slots is the same list as before.
INSERT INTO "TeamSlot" ("id", "teamId", "role", "customLabel", "requiredSkills", "status", "position", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, t."id", 'OTHER', l.entry, ARRAY[l.entry], 'OPEN', (l.ord - 1)::int, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Team" t, unnest(t."lookingFor") WITH ORDINALITY AS l(entry, ord)
WHERE btrim(l.entry) <> '';
