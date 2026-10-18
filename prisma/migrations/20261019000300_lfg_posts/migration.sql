-- Squads, part 3: the looking-for-group board. One active post per person per hackathon is kept by the create route under an advisory lock
-- (src/lib/squads/lfg.ts), not by a partial index, which Prisma could not see.

-- CreateEnum
CREATE TYPE "LfgKind" AS ENUM ('PERSON', 'TEAM');

-- CreateTable
CREATE TABLE "LfgPost" (
    "id" TEXT NOT NULL,
    "hackathonId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "kind" "LfgKind" NOT NULL,
    "teamId" TEXT,
    "roles" "SquadRole"[] DEFAULT ARRAY[]::"SquadRole"[],
    "stack" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "timezone" TEXT,
    "note" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LfgPost_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LfgPost_hackathonId_closedAt_expiresAt_createdAt_idx" ON "LfgPost"("hackathonId", "closedAt", "expiresAt", "createdAt");

-- CreateIndex
CREATE INDEX "LfgPost_authorId_hackathonId_idx" ON "LfgPost"("authorId", "hackathonId");

-- CreateIndex
CREATE INDEX "LfgPost_roles_idx" ON "LfgPost" USING GIN ("roles");

-- CreateIndex
CREATE INDEX "LfgPost_stack_idx" ON "LfgPost" USING GIN ("stack");

-- AddForeignKey
ALTER TABLE "LfgPost" ADD CONSTRAINT "LfgPost_hackathonId_fkey" FOREIGN KEY ("hackathonId") REFERENCES "Hackathon"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LfgPost" ADD CONSTRAINT "LfgPost_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LfgPost" ADD CONSTRAINT "LfgPost_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE SET NULL ON UPDATE CASCADE;

