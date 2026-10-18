-- Squads, part 2: the solo pool on a hackathon registration (looking for a team, preferred roles, open to an automatic squad), squad proposals
-- (the squad builder's and the auto-formation's) with their members, the formation rounds, and the invitations a proposal sent.

-- CreateEnum
CREATE TYPE "SquadProposalKind" AS ENUM ('BUILDER', 'AUTO');

-- CreateEnum
CREATE TYPE "SquadProposalStatus" AS ENUM ('OPEN', 'INVITED', 'PROPOSED', 'FORMED', 'FAILED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "ProposalResponse" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED');

-- AlterTable
ALTER TABLE "TeamApplication" ADD COLUMN     "proposalId" TEXT;

-- AlterTable
ALTER TABLE "HackathonParticipant" ADD COLUMN     "lookingForTeam" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "openToAutoTeam" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "preferredRoles" "SquadRole"[] DEFAULT ARRAY[]::"SquadRole"[];

-- CreateTable
CREATE TABLE "SquadProposal" (
    "id" TEXT NOT NULL,
    "hackathonId" TEXT NOT NULL,
    "kind" "SquadProposalKind" NOT NULL,
    "status" "SquadProposalStatus" NOT NULL,
    "requesterId" TEXT,
    "teamId" TEXT,
    "runId" TEXT,
    "seed" INTEGER NOT NULL,
    "size" INTEGER NOT NULL,
    "strength" INTEGER NOT NULL,
    "detail" JSONB NOT NULL DEFAULT '{}',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SquadProposal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SquadProposalMember" (
    "id" TEXT NOT NULL,
    "proposalId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "SquadRole" NOT NULL,
    "roleLabel" TEXT,
    "reasons" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "position" INTEGER NOT NULL DEFAULT 0,
    "response" "ProposalResponse" NOT NULL DEFAULT 'PENDING',
    "respondedAt" TIMESTAMP(3),

    CONSTRAINT "SquadProposalMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SquadFormationRun" (
    "id" TEXT NOT NULL,
    "hackathonId" TEXT NOT NULL,
    "round" INTEGER NOT NULL,
    "poolSize" INTEGER NOT NULL,
    "squads" INTEGER NOT NULL,
    "leftovers" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMP(3),

    CONSTRAINT "SquadFormationRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SquadProposal_status_expiresAt_idx" ON "SquadProposal"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "SquadProposal_hackathonId_kind_status_idx" ON "SquadProposal"("hackathonId", "kind", "status");

-- CreateIndex
CREATE INDEX "SquadProposal_requesterId_createdAt_idx" ON "SquadProposal"("requesterId", "createdAt");

-- CreateIndex
CREATE INDEX "SquadProposal_runId_idx" ON "SquadProposal"("runId");

-- CreateIndex
CREATE INDEX "SquadProposalMember_userId_response_idx" ON "SquadProposalMember"("userId", "response");

-- CreateIndex
CREATE UNIQUE INDEX "SquadProposalMember_proposalId_userId_key" ON "SquadProposalMember"("proposalId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "SquadFormationRun_hackathonId_round_key" ON "SquadFormationRun"("hackathonId", "round");

-- CreateIndex
CREATE INDEX "HackathonParticipant_hackathonId_lookingForTeam_teamId_idx" ON "HackathonParticipant"("hackathonId", "lookingForTeam", "teamId");

-- AddForeignKey
ALTER TABLE "TeamApplication" ADD CONSTRAINT "TeamApplication_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "SquadProposal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SquadProposal" ADD CONSTRAINT "SquadProposal_hackathonId_fkey" FOREIGN KEY ("hackathonId") REFERENCES "Hackathon"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SquadProposal" ADD CONSTRAINT "SquadProposal_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SquadProposal" ADD CONSTRAINT "SquadProposal_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SquadProposal" ADD CONSTRAINT "SquadProposal_runId_fkey" FOREIGN KEY ("runId") REFERENCES "SquadFormationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SquadProposalMember" ADD CONSTRAINT "SquadProposalMember_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "SquadProposal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SquadProposalMember" ADD CONSTRAINT "SquadProposalMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SquadFormationRun" ADD CONSTRAINT "SquadFormationRun_hackathonId_fkey" FOREIGN KEY ("hackathonId") REFERENCES "Hackathon"("id") ON DELETE CASCADE ON UPDATE CASCADE;

