-- Squads, part 4: hackathon tracks and the tracks a squad goes for, the team space (checklist, idea board with votes), and keep-building.

-- AlterTable
ALTER TABLE "Team" ADD COLUMN     "keptBuildingAt" TIMESTAMP(3),
ADD COLUMN     "targetTracks" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "Hackathon" ADD COLUMN     "tracks" JSONB NOT NULL DEFAULT '[]';

-- CreateTable
CREATE TABLE "TeamChecklistItem" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "assigneeId" TEXT,
    "done" BOOLEAN NOT NULL DEFAULT false,
    "doneAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeamChecklistItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamIdea" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "voteCount" INTEGER NOT NULL DEFAULT 0,
    "chosenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeamIdea_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamIdeaVote" (
    "id" TEXT NOT NULL,
    "ideaId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TeamIdeaVote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TeamChecklistItem_teamId_position_idx" ON "TeamChecklistItem"("teamId", "position");

-- CreateIndex
CREATE INDEX "TeamIdea_teamId_createdAt_idx" ON "TeamIdea"("teamId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "TeamIdeaVote_ideaId_userId_key" ON "TeamIdeaVote"("ideaId", "userId");

-- AddForeignKey
ALTER TABLE "TeamChecklistItem" ADD CONSTRAINT "TeamChecklistItem_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamChecklistItem" ADD CONSTRAINT "TeamChecklistItem_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamChecklistItem" ADD CONSTRAINT "TeamChecklistItem_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamIdea" ADD CONSTRAINT "TeamIdea_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamIdea" ADD CONSTRAINT "TeamIdea_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamIdeaVote" ADD CONSTRAINT "TeamIdeaVote_ideaId_fkey" FOREIGN KEY ("ideaId") REFERENCES "TeamIdea"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamIdeaVote" ADD CONSTRAINT "TeamIdeaVote_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

