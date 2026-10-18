-- Squads, part 6: commitment pledges, private peer reviews, each person's reliability, and when a hackathon's results were recorded.

-- CreateEnum
CREATE TYPE "AttendanceMode" AS ENUM ('IN_PERSON', 'REMOTE');

-- CreateEnum
CREATE TYPE "ShowedUp" AS ENUM ('YES', 'PARTLY', 'NO');

-- AlterTable
ALTER TABLE "Hackathon" ADD COLUMN     "resultsAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "CommitmentPledge" (
    "id" TEXT NOT NULL,
    "hackathonId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "attendance" "AttendanceMode" NOT NULL,
    "hoursAvailable" INTEGER NOT NULL,
    "availableFrom" DATE NOT NULL,
    "availableUntil" DATE NOT NULL,
    "confirmedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommitmentPledge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PeerReview" (
    "id" TEXT NOT NULL,
    "hackathonId" TEXT NOT NULL,
    "teamId" TEXT,
    "reviewerId" TEXT NOT NULL,
    "revieweeId" TEXT NOT NULL,
    "showedUp" "ShowedUp" NOT NULL,
    "wouldBuildAgain" BOOLEAN NOT NULL,
    "note" TEXT,
    "counted" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PeerReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserReliability" (
    "userId" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "reviews" INTEGER NOT NULL,
    "badge" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserReliability_pkey" PRIMARY KEY ("userId")
);

-- CreateIndex
CREATE INDEX "CommitmentPledge_teamId_idx" ON "CommitmentPledge"("teamId");

-- CreateIndex
CREATE UNIQUE INDEX "CommitmentPledge_hackathonId_userId_key" ON "CommitmentPledge"("hackathonId", "userId");

-- CreateIndex
CREATE INDEX "PeerReview_revieweeId_createdAt_idx" ON "PeerReview"("revieweeId", "createdAt");

-- CreateIndex
CREATE INDEX "PeerReview_reviewerId_revieweeId_idx" ON "PeerReview"("reviewerId", "revieweeId");

-- CreateIndex
CREATE UNIQUE INDEX "PeerReview_hackathonId_reviewerId_revieweeId_key" ON "PeerReview"("hackathonId", "reviewerId", "revieweeId");

-- AddForeignKey
ALTER TABLE "CommitmentPledge" ADD CONSTRAINT "CommitmentPledge_hackathonId_fkey" FOREIGN KEY ("hackathonId") REFERENCES "Hackathon"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommitmentPledge" ADD CONSTRAINT "CommitmentPledge_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PeerReview" ADD CONSTRAINT "PeerReview_hackathonId_fkey" FOREIGN KEY ("hackathonId") REFERENCES "Hackathon"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PeerReview" ADD CONSTRAINT "PeerReview_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PeerReview" ADD CONSTRAINT "PeerReview_revieweeId_fkey" FOREIGN KEY ("revieweeId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserReliability" ADD CONSTRAINT "UserReliability_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

