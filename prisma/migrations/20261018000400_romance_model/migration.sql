-- The romance mode (docs/ROMANCE.md): its own tables, none of which is read by the professional matching model, and the stubs for Phase 2 (Build Dates).
-- A pair of people is one Duo row (userAId is the smaller id), like a Match.

-- CreateEnum
CREATE TYPE "RomanceGender" AS ENUM ('WOMAN', 'MAN', 'NON_BINARY', 'SELF_DESCRIBED');

-- CreateEnum
CREATE TYPE "RomanceScope" AS ENUM ('CITY', 'COUNTRY', 'ANYWHERE');

-- CreateEnum
CREATE TYPE "RevealStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED', 'REVOKED');

-- CreateEnum
CREATE TYPE "BuildDateStatus" AS ENUM ('PROPOSED', 'ACCEPTED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DuoStatus" AS ENUM ('PENDING', 'ACTIVE', 'DISSOLVED');

-- CreateTable
CREATE TABLE "RomanceProfile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "promptObsessed" TEXT NOT NULL,
    "promptBuild" TEXT NOT NULL,
    "promptWeekend" TEXT NOT NULL,
    "ambition" INTEGER NOT NULL,
    "direction" TEXT NOT NULL,
    "rhythm" TEXT NOT NULL,
    "obsessions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "gender" "RomanceGender" NOT NULL,
    "genderSelfDescribe" TEXT,
    "interestedIn" "RomanceGender"[],
    "ageMin" INTEGER NOT NULL,
    "ageMax" INTEGER NOT NULL,
    "scope" "RomanceScope" NOT NULL DEFAULT 'COUNTRY',
    "minEndorsements" INTEGER NOT NULL DEFAULT 0,
    "paused" BOOLEAN NOT NULL DEFAULT false,
    "lastDropWeek" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RomanceProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RomancePhoto" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "blurHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RomancePhoto_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RomanceDrop" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "reasons" JSONB NOT NULL DEFAULT '[]',
    "weekKey" TEXT NOT NULL,
    "status" "DropStatus" NOT NULL DEFAULT 'NEW',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "viewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RomanceDrop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RevealRequest" (
    "id" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "requesterId" TEXT NOT NULL,
    "status" "RevealStatus" NOT NULL DEFAULT 'PENDING',
    "buildDateId" TEXT,
    "respondedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revokedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RevealRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BuildDate" (
    "id" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "proposedById" TEXT NOT NULL,
    "status" "BuildDateStatus" NOT NULL DEFAULT 'PROPOSED',
    "scheduledFor" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BuildDate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Duo" (
    "id" TEXT NOT NULL,
    "userAId" TEXT NOT NULL,
    "userBId" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "status" "DuoStatus" NOT NULL DEFAULT 'PENDING',
    "acceptedAt" TIMESTAMP(3),
    "dissolvedAt" TIMESTAMP(3),
    "dissolvedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Duo_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RomanceProfile_userId_key" ON "RomanceProfile"("userId");

-- CreateIndex
CREATE INDEX "RomanceProfile_paused_gender_idx" ON "RomanceProfile"("paused", "gender");

-- CreateIndex
CREATE INDEX "RomanceProfile_interestedIn_idx" ON "RomanceProfile" USING GIN ("interestedIn");

-- CreateIndex
CREATE UNIQUE INDEX "RomancePhoto_assetId_key" ON "RomancePhoto"("assetId");

-- CreateIndex
CREATE INDEX "RomancePhoto_profileId_position_idx" ON "RomancePhoto"("profileId", "position");

-- CreateIndex
CREATE INDEX "RomanceDrop_userId_candidateId_createdAt_idx" ON "RomanceDrop"("userId", "candidateId", "createdAt");

-- CreateIndex
CREATE INDEX "RomanceDrop_candidateId_createdAt_idx" ON "RomanceDrop"("candidateId", "createdAt");

-- CreateIndex
CREATE INDEX "RomanceDrop_status_expiresAt_idx" ON "RomanceDrop"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "RomanceDrop_userId_weekKey_key" ON "RomanceDrop"("userId", "weekKey");

-- CreateIndex
CREATE UNIQUE INDEX "RevealRequest_matchId_key" ON "RevealRequest"("matchId");

-- CreateIndex
CREATE UNIQUE INDEX "RevealRequest_buildDateId_key" ON "RevealRequest"("buildDateId");

-- CreateIndex
CREATE INDEX "BuildDate_matchId_idx" ON "BuildDate"("matchId");

-- CreateIndex
CREATE INDEX "Duo_userBId_status_idx" ON "Duo"("userBId", "status");

-- CreateIndex
CREATE INDEX "Duo_userAId_status_idx" ON "Duo"("userAId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Duo_userAId_userBId_key" ON "Duo"("userAId", "userBId");

-- AddForeignKey
ALTER TABLE "RomanceProfile" ADD CONSTRAINT "RomanceProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RomancePhoto" ADD CONSTRAINT "RomancePhoto_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "RomanceProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RomancePhoto" ADD CONSTRAINT "RomancePhoto_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "MediaAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RomanceDrop" ADD CONSTRAINT "RomanceDrop_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RomanceDrop" ADD CONSTRAINT "RomanceDrop_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RevealRequest" ADD CONSTRAINT "RevealRequest_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RevealRequest" ADD CONSTRAINT "RevealRequest_buildDateId_fkey" FOREIGN KEY ("buildDateId") REFERENCES "BuildDate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuildDate" ADD CONSTRAINT "BuildDate_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Duo" ADD CONSTRAINT "Duo_userAId_fkey" FOREIGN KEY ("userAId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Duo" ADD CONSTRAINT "Duo_userBId_fkey" FOREIGN KEY ("userBId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- A pair is one row whichever of them asked.
ALTER TABLE "Duo" ADD CONSTRAINT "Duo_pair_order" CHECK ("userAId" < "userBId");

-- The rules of a profile hold in the database too, not only in the API: an adult age range, a gate between 0 and 5, an ambition on the scale.
ALTER TABLE "RomanceProfile" ADD CONSTRAINT "RomanceProfile_age_range" CHECK ("ageMin" >= 18 AND "ageMax" >= "ageMin" AND "ageMax" <= 99);
ALTER TABLE "RomanceProfile" ADD CONSTRAINT "RomanceProfile_gate_range" CHECK ("minEndorsements" BETWEEN 0 AND 5);
ALTER TABLE "RomanceProfile" ADD CONSTRAINT "RomanceProfile_ambition_range" CHECK ("ambition" BETWEEN 1 AND 4);

-- DATING leaves the professional model. Whoever had chosen it as a connection type loses that choice (the romance mode is joined with its own profile, and its own
-- opt-in), and the dating drops and unanswered dating sparks of the old model are removed: nobody has a romance profile yet, so none of them could be answered.
-- Matches that already exist stay as they are, with their conversations.
UPDATE "MatchingProfile" SET "connectionTypes" = array_remove("connectionTypes", 'DATING'::"MatchType") WHERE 'DATING'::"MatchType" = ANY("connectionTypes");
DELETE FROM "Drop" WHERE "connectionType" = 'DATING';
DELETE FROM "Spark" WHERE "connectionType" = 'DATING' AND "status" = 'PENDING';
