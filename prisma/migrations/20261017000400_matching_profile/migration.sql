-- CreateEnum
CREATE TYPE "MatchType" AS ENUM ('COFOUNDER', 'HACKATHON_TEAMMATE', 'COLLABORATOR', 'MENTOR', 'MENTEE', 'DATING');

-- AlterTable
ALTER TABLE "User" ADD COLUMN "birthDate" DATE;

-- CreateTable
CREATE TABLE "MatchingProfile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "connectionTypes" "MatchType"[],
    "intentTags" JSONB NOT NULL DEFAULT '[]',
    "hoursPerWeek" INTEGER,
    "availableFrom" DATE,
    "remoteOk" BOOLEAN NOT NULL DEFAULT true,
    "cityOnly" BOOLEAN NOT NULL DEFAULT false,
    "lookingForSkills" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "workingStyle" JSONB NOT NULL DEFAULT '{}',
    "dropTimeLocal" TEXT NOT NULL DEFAULT '09:00',
    "paused" BOOLEAN NOT NULL DEFAULT false,
    "lastDropDate" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MatchingProfile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MatchingProfile_userId_key" ON "MatchingProfile"("userId");

-- CreateIndex
CREATE INDEX "MatchingProfile_paused_dropTimeLocal_idx" ON "MatchingProfile"("paused", "dropTimeLocal");

-- CreateIndex
CREATE INDEX "MatchingProfile_connectionTypes_idx" ON "MatchingProfile" USING GIN ("connectionTypes");

-- AddForeignKey
ALTER TABLE "MatchingProfile" ADD CONSTRAINT "MatchingProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
